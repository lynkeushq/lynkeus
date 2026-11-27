import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

/** The process listening on a port, and when it is a Lynkeus CLI, the project it serves and its release. */
export type PortHolder = { pid: number; command: string; lynkeus?: { project?: string; version?: string } };

export type Run = (file: string, args: string[]) => Promise<string>;

const execute: Run = async (file, args) => (await promisify(execFile)(file, args, { encoding: 'utf8', timeout: 3000 })).stdout;

// `lynkeus mcp`, `npx lynkeus@0.7.6 mcp`, `node …/node_modules/.bin/lynkeus …`, `node …/lynkeus/dist/cli.js …`, never `lynkeus-agent`.
const LYNKEUS = /(?:^|[\s/])lynkeus(?:@([\w.-]+))?(?=\s|$|\/dist\/)/;

/** The release of the lynkeus package a script belongs to, from the package.json above its real path. */
const versionOf = (script: string): string | undefined => {
  let dir: string;
  try {
    dir = path.dirname(fs.realpathSync(script));
  } catch {
    return undefined;
  }
  for (let i = 0; i < 6; i++) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string };
      if (pkg.name === 'lynkeus') return pkg.version;
    } catch {
      // No package.json at this level.
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return undefined;
};

/**
 * Who listens on `port` on this machine, from lsof and ps (macOS and Linux). Undefined when neither can tell, as
 * where they are missing or the process belongs to another user.
 */
export const portHolder = async (port: number, run: Run = execute): Promise<PortHolder | undefined> => {
  const pids = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']).catch(() => '');
  const pid = Number(pids.split('\n')[0]?.trim());
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  const command = (await run('ps', ['-o', 'args=', '-p', String(pid)]).catch(() => '')).trim() || `pid ${pid}`;
  const named = LYNKEUS.exec(command);
  if (!named) return { pid, command };
  const args = command.split(/\s+/);
  const rootAt = args.findIndex((a) => a === '--root');
  const rootFlag = rootAt >= 0 ? args[rootAt + 1] : args.find((a) => a.startsWith('--root='))?.slice('--root='.length);
  const cwd = (await run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']).catch(() => ''))
    .split('\n')
    .find((l) => l.startsWith('n'))
    ?.slice(1);
  const project = rootFlag ? (cwd ? path.resolve(cwd, rootFlag) : rootFlag) : cwd;
  const script = args.find((a) => /\/(?:lynkeus|cli\.js)$/.test(a));
  const version = named[1] ?? (script ? versionOf(script) : undefined);
  return { pid, command, lynkeus: { ...(project ? { project } : {}), ...(version ? { version } : {}) } };
};

const short = (command: string) => (command.length > 90 ? `${command.slice(0, 87)}…` : command);

/** One line naming who holds the port and what to do about it, from the project at `root`. */
export const describeHolder = (port: number, holder: PortHolder | undefined, root: string): string => {
  const move = 'or give this project another port (LYNKEUS_PORT, for the app and its driver alike)';
  if (!holder) return `port ${port} is taken by another process (lsof could not name it): stop it, ${move}`;
  const who = `pid ${holder.pid} (${short(holder.command)})`;
  if (!holder.lynkeus) return `port ${port} is taken by ${who}, which is not Lynkeus: stop it, ${move}`;
  const release = holder.lynkeus.version ? `Lynkeus ${holder.lynkeus.version}` : 'Lynkeus';
  const project = holder.lynkeus.project;
  if (project !== undefined && path.resolve(project) === path.resolve(root))
    return `port ${port} is taken by ${who}: ${release} for this same project, left by another session or terminal, which takes this project's app for itself: stop it (\`kill ${holder.pid}\`), ${move}`;
  const whose = project === undefined ? `${release}, serving a project it does not say` : `${release} for another project, ${project}`;
  return `port ${port} is taken by ${who}: ${whose}. It cannot drive this project's app (each project has its own token) and keeps this driver from listening: stop it (\`kill ${holder.pid}\`), ${move}`;
};

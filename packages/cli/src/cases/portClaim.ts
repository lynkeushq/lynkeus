import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * A run lets go of its driver port between cases, and the app dials whichever driver is listening: two runs
 * on one port take turns at the app, and each reports steps the other drove. A run claims its ports for as
 * long as it lasts; what it answers is the release, or why another run holds one.
 */
export const claimPorts = (ports: number[], dir = os.tmpdir()): { release: () => void } | { refused: string } => {
  const held: string[] = [];
  const release = () => {
    for (const file of held) {
      try {
        if (fs.readFileSync(file, 'utf8').trim() === String(process.pid)) fs.unlinkSync(file);
      } catch {
        // Already gone.
      }
    }
  };
  for (const port of ports) {
    const file = path.join(dir, `lynkeus-port-${port}.pid`);
    for (;;) {
      try {
        fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
        held.push(file);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const owner = Number(fs.readFileSync(file, 'utf8').trim());
      if (Number.isInteger(owner) && owner > 0 && owner !== process.pid && alive(owner)) {
        release();
        return {
          refused: `port ${port} is held by another lynkeus case run (pid ${owner}), which is probably still going: stop it, or give this run other --ports`,
        };
      }
      // Left by a run that ended without letting go.
      fs.rmSync(file, { force: true });
    }
  }
  return { release };
};

const free = (port: number, host: string): Promise<boolean> =>
  new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });

/**
 * `count` driver ports nobody listens on or claims, counted up from just past `after`: the port an attached app
 * dials is left to it, or its app would attach to a case's host instead.
 */
export const freePorts = async (count: number, after: number, dir = os.tmpdir(), host = '127.0.0.1'): Promise<number[]> => {
  const found: number[] = [];
  for (let port = after + 1; found.length < count && port < 65_536; port++) {
    if (fs.existsSync(path.join(dir, `lynkeus-port-${port}.pid`))) continue;
    if (await free(port, host)) found.push(port);
  }
  return found;
};

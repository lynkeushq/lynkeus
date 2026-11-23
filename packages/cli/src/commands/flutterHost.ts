import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { lynkeusDir } from '../config.js';
import { hasReactNative } from './initFlutter.js';

/** A Flutter app: its pubspec names the package and depends on the Flutter SDK. */
export type FlutterProject = { name: string; hosted: boolean };

/** The top-level sections of a pubspec, each with its indented lines: enough to read names, never a YAML parser. */
const sections = (pubspec: string): Map<string, string[]> => {
  const out = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of pubspec.split(/\r?\n/)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    const top = /^([A-Za-z_][\w-]*):(.*)$/.exec(line);
    if (top) {
      current = [top[2]!.trim()];
      out.set(top[1]!, current);
    } else current?.push(line);
  }
  return out;
};

/** The app's package keys under a section (`dependencies:`), at the first indentation level. */
const keysOf = (lines: string[] | undefined): string[] => {
  if (!lines) return [];
  const indent = lines
    .slice(1)
    .map((l) => /^(\s+)\S/.exec(l)?.[1]?.length ?? 0)
    .find((n) => n > 0);
  return lines
    .slice(1)
    .filter((l) => (/^(\s+)\S/.exec(l)?.[1]?.length ?? 0) === indent)
    .map((l) => l.trim().split(':')[0]!);
};

/**
 * The Flutter app at `root`, if it is one: a pubspec.yaml whose dependencies take `flutter` from the SDK, in a folder
 * that is not also a React Native app (which keeps its behavior, as `lynkeus init` decides).
 * `hosted`: lynkeus_headless is among its dependencies, so `flutter test` can host it.
 */
export const flutterProject = (root: string): FlutterProject | undefined => {
  if (hasReactNative(root)) return undefined;
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, 'pubspec.yaml'), 'utf8');
  } catch {
    return undefined;
  }
  const parts = sections(text);
  const name = parts.get('name')?.[0]?.replace(/^['"]|['"]$/g, '');
  const dependencies = parts.get('dependencies');
  const flutterAt = dependencies?.findIndex((l) => /^\s+flutter:\s*$/.test(l)) ?? -1;
  if (!name || !dependencies || flutterAt < 0 || !/^\s+sdk:\s*flutter\s*$/.test(dependencies[flutterAt + 1] ?? '')) return undefined;
  const hosted = [...keysOf(dependencies), ...keysOf(parts.get('dev_dependencies'))].includes('lynkeus_headless');
  return { name, hosted };
};

export type FlutterSdk = { bin: string; root: string };

const executable = (file: string) => {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

/** The Flutter SDK: FLUTTER_ROOT, then `flutter` on PATH, then what mise has for the project. Undefined when none. */
export const findFlutter = (root: string, env: NodeJS.ProcessEnv = process.env): FlutterSdk | undefined => {
  const fromBin = (bin: string): FlutterSdk => {
    const real = fs.realpathSync(bin);
    return { bin: real, root: path.dirname(path.dirname(real)) };
  };
  if (env.FLUTTER_ROOT && executable(path.join(env.FLUTTER_ROOT, 'bin', 'flutter'))) return fromBin(path.join(env.FLUTTER_ROOT, 'bin', 'flutter'));
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    const bin = path.join(dir, 'flutter');
    // A mise shim answers for whichever version the folder pins, or fails: what mise resolves below is surer.
    if (dir && !dir.includes('mise/shims') && executable(bin)) return fromBin(bin);
  }
  const mise = spawnSync('mise', ['which', 'flutter'], { cwd: root, env, encoding: 'utf8' });
  const found = mise.status === 0 ? mise.stdout.trim() : '';
  return found && executable(found) ? fromBin(found) : undefined;
};

/**
 * The test file `flutter test` runs to host the app. It lives in .lynkeus, not test/: a host never ends, and the
 * app's own `flutter test` would run it with the rest of its tests and hang.
 */
export const flutterHostFile = (root: string, port: number | undefined): string =>
  path.join(lynkeusDir(root), 'host', port ? `lynkeus_host_${port}_test.dart` : 'lynkeus_host_test.dart');

/** Where a project keeps stand-ins of its own: `void configureHost(HostConfig host)`, which the host file passes on. */
export const PROJECT_HOST = path.join('test', 'lynkeus_host.dart');

export const flutterHostTest = (project: FlutterProject, entry: string, ownStandIns = false): string => {
  const main = entry.replace(/^lib\//, '');
  return `// Written by \`lynkeus headless start\`; runs the app inside flutter test as a host for the agent.
import 'package:lynkeus_headless/lynkeus_headless.dart';
import 'package:${project.name}/${main}' as app;
${ownStandIns ? "import '../../test/lynkeus_host.dart' as project;\n" : ''}
void main() => hostApp(app.main, name: ${JSON.stringify(project.name)}${ownStandIns ? ', configure: project.configureHost' : ''});
`;
};

/** Writes the host file, and keeps the folder that holds it out of git. */
export const writeFlutterHost = (root: string, project: FlutterProject, entry: string, port: number | undefined): string => {
  const file = flutterHostFile(root, port);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, flutterHostTest(project, entry, fs.existsSync(path.join(root, PROJECT_HOST))));
  const ignore = path.join(lynkeusDir(root), '.gitignore');
  const ignored = fs.existsSync(ignore) ? fs.readFileSync(ignore, 'utf8') : '';
  if (!ignored.split('\n').includes('host/')) fs.writeFileSync(ignore, `${ignored}${ignored && !ignored.endsWith('\n') ? '\n' : ''}host/\n`);
  return file;
};

/** The environment `flutter test` hands the host: the driver, the screen and the fonts that make text legible. */
export const flutterHostEnv = (
  sdk: FlutterSdk,
  token: string,
  port: number | undefined,
  options: { networkHosts?: string[]; platform?: string; window?: string } = {},
): Record<string, string> => ({
  LYNKEUS_TOKEN: token,
  LYNKEUS_PORT: String(port ?? 8123),
  LYNKEUS_FONTS: path.join(sdk.root, 'bin', 'cache', 'artifacts', 'material_fonts'),
  ...(options.networkHosts?.length ? { LYNKEUS_NETWORK_HOSTS: options.networkHosts.join(',') } : {}),
  ...(options.platform ? { LYNKEUS_PLATFORM: options.platform } : {}),
  ...(options.window ? { LYNKEUS_WINDOW: options.window } : {}),
});

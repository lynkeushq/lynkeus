import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { bundleInputs, changedInput, keepInputs, snapshotInputs } from './bundleInputs.js';

const SOURCE = /\.(?:[cm]?[jt]sx?|json)$/;
const TEST = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const NOT_APP_CODE = new Set(['node_modules', 'ios', 'android', 'build', 'dist', 'coverage', 'web-build', '__tests__', '__mocks__']);
// A walk that big is not an app's own code any more; a bundle is better left unchecked than a run held up.
const MAX_ENTRIES = 20_000;

const RUN = /("[^"]*fastsim-run"|'[^']*fastsim-run'|[^\s"']*fastsim-run)\s+("[^"]+"|'[^']+'|[^\s"']+)/;

const unquote = (word: string): string => word.replace(/^["']|["']$/g, '').replace(/^~(?=\/)/, os.homedir());

/** Whether a host command starts a Lynkeus FastSim host (`fastsim-run <bundle dir> {port}`). */
export const startsFastsim = (command: string | undefined): boolean => command !== undefined && RUN.test(command);

/** The bundle folder a `fastsim-run <bundle dir> {port}` host command names, resolved; undefined for any other command. */
export const fastsimBundleDir = (command: string, cwd: string): string | undefined => {
  const given = RUN.exec(command)?.[2];
  if (!given) return undefined;
  const dir = unquote(given);
  if (dir.includes('{') || dir.includes('$')) return undefined;
  return path.resolve(cwd, dir);
};

/** The `fastsim-bundle` beside the `fastsim-run` a host command starts (or on the PATH, for a bare `fastsim-run`), if it is there. */
export const fastsimBundler = (command: string, cwd: string, envPath: string | undefined = process.env.PATH): string | undefined => {
  const given = RUN.exec(command)?.[1];
  if (!given) return undefined;
  const run = unquote(given);
  if (run.includes('$') || run.includes('{')) return undefined;
  const dirs = run.includes('/') ? [path.dirname(path.resolve(cwd, run))] : (envPath ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const bundler = path.join(dir, 'fastsim-bundle');
    try {
      fs.accessSync(bundler, fs.constants.X_OK);
      return bundler;
    } catch {
      // not in this folder
    }
  }
  return undefined;
};

/**
 * The app's newest source file and when it changed, leaving out dependencies, native projects, tests, `skip` and the
 * files `ignore` names (by their full path).
 */
export const newestSource = (appDir: string, skip: string[] = [], ignore?: (file: string) => boolean): { file: string; mtimeMs: number } | undefined => {
  const skipped = new Set(skip.map((dir) => path.resolve(appDir, dir)));
  let newest: { file: string; mtimeMs: number } | undefined;
  let seen = 0;
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (++seen > MAX_ENTRIES) return;
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!NOT_APP_CODE.has(entry.name) && !skipped.has(full)) walk(full);
      } else if (entry.isFile() && SOURCE.test(entry.name) && !TEST.test(entry.name) && !ignore?.(full)) {
        const { mtimeMs } = fs.statSync(full);
        if (!newest || mtimeMs > newest.mtimeMs) newest = { file: full, mtimeMs };
      }
    }
  };
  walk(appDir);
  return newest;
};

export type StaleBundle = {
  bundle: string;
  /** The app fastsim-bundle recorded in the bundle's bundle.json, else the project's folder. */
  app: string;
  platform: string;
  /** The newest source, relative to `app`. */
  newest: string;
};

/**
 * The FastSim bundle a host command runs, when it is older than the app's code: a run on it would test the app as it
 * was. Undefined when it is current, or when the command runs no bundle that can be checked.
 */
/** The app and platform a bundle was made for, as fastsim-bundle recorded them (bundle.json, else host.args). */
const bundleFacts = (bundle: string, appDir: string): Omit<StaleBundle, 'newest'> => {
  let app = appDir;
  let platform: string | undefined;
  try {
    const recorded = JSON.parse(fs.readFileSync(path.join(bundle, 'bundle.json'), 'utf8')) as { app?: unknown; platform?: unknown };
    if (typeof recorded.app === 'string' && fs.existsSync(recorded.app)) app = recorded.app;
    if (recorded.platform === 'ios' || recorded.platform === 'android') platform = recorded.platform;
  } catch {
    // made before fastsim-bundle recorded its app
  }
  if (!platform)
    platform = /--platform (\w+)/.exec(
      (() => {
        try {
          return fs.readFileSync(path.join(bundle, 'host.args'), 'utf8');
        } catch {
          return '';
        }
      })(),
    )?.[1];
  return { bundle, app, platform: platform ?? 'ios' };
};

export const staleBundle = (command: string, appDir: string, skip: string[] = []): StaleBundle | undefined => {
  const bundle = fastsimBundleDir(command, appDir);
  if (!bundle) return undefined;
  let built: number;
  try {
    built = fs.statSync(path.join(bundle, 'app.hbc')).mtimeMs;
  } catch {
    return undefined;
  }
  let app = appDir;
  let platform: string | undefined;
  try {
    const recorded = JSON.parse(fs.readFileSync(path.join(bundle, 'bundle.json'), 'utf8')) as { app?: unknown; platform?: unknown };
    if (typeof recorded.app === 'string' && fs.existsSync(recorded.app)) app = recorded.app;
    if (recorded.platform === 'ios' || recorded.platform === 'android') platform = recorded.platform;
  } catch {
    // A bundle made before fastsim-bundle recorded its app: the project's folder is the app.
  }
  if (!platform) {
    try {
      platform = /--platform (\w+)/.exec(fs.readFileSync(path.join(bundle, 'host.args'), 'utf8'))?.[1];
    } catch {
      // no host.args either: fastsim-bundle's own default
    }
  }
  const found = { bundle, app, platform: platform ?? 'ios' };
  // What the bundle was made from decides, by content; dates only when that cannot be told.
  const changed = changedInput(bundle, app, built);
  if (changed !== undefined) return changed === null ? undefined : { ...found, newest: changed };
  const newest = newestSource(app, skip, (file) => path.basename(file) === 'lynkeus.config.json');
  if (!newest || newest.mtimeMs <= built) return undefined;
  return { ...found, newest: path.relative(app, newest.file) };
};

const shellWord = (word: string): string => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`);

/** The command that bundles the app again, as a person would type it. */
export const rebundleCommand = (stale: StaleBundle, bundler: string | undefined): string =>
  [bundler ? shellWord(bundler) : '<FastSim folder>/bin/fastsim-bundle', shellWord(stale.app), shellWord(stale.bundle), stale.platform].join(' ');

export type Bundling = { code: number | null; output: string };
export type Bundle = (bundler: string, args: string[], o: { cwd: string; signal?: AbortSignal; env?: NodeJS.ProcessEnv }) => Promise<Bundling>;

/**
 * Whether a FastSim bundle carries the project's token, read from its bytes (Hermes keeps string literals as they
 * are): `missing` when its agent will stay off and never dial in (trial run 11: a bundle made without
 * EXPO_PUBLIC_LYNKEUS_TOKEN waited out 60 s, saying nothing). Undefined when there is no bundle or no token to look for.
 */
export const bundleToken = (bundle: string, token: string | undefined): 'present' | 'missing' | undefined => {
  if (!token) return undefined;
  const needle = Buffer.from(token);
  let found: boolean | undefined;
  for (const name of ['app.hbc', 'app.js']) {
    try {
      const bytes = fs.readFileSync(path.join(bundle, name));
      if (bytes.includes(needle)) return 'present';
      found = false;
    } catch {
      // not in this bundle
    }
  }
  return found === false ? 'missing' : undefined;
};

/**
 * Whether the kit a host command runs hands the app's agent the token it is started with (LYNKEUS_TOKEN), so a bundle
 * need not carry it: a kit that does lists `host-token` in `share/capabilities`.
 */
export const kitGivesToken = (command: string, cwd: string): boolean => {
  const run = RUN.exec(command)?.[1];
  if (!run) return false;
  try {
    const kit = path.dirname(path.dirname(path.resolve(cwd, unquote(run))));
    return fs
      .readFileSync(path.join(kit, 'share', 'capabilities'), 'utf8')
      .split(/\s+/)
      .includes('host-token');
  } catch {
    return false;
  }
};

/** The environment a bundle is made in: the project's token where the app's bundler inlines it (Expo, and the babel plugin). */
export const bundleEnv = (token: string | undefined): NodeJS.ProcessEnv =>
  token
    ? { ...process.env, EXPO_PUBLIC_LYNKEUS_TOKEN: process.env.EXPO_PUBLIC_LYNKEUS_TOKEN || token, LYNKEUS_TOKEN: process.env.LYNKEUS_TOKEN || token }
    : process.env;

/** Why a bundle that still carries no token after bundling: the app's entry does not read it where the bundler sets it. */
export const NO_TOKEN_FIX =
  "the app's entry must pass it to the agent: auto({ token: process.env.EXPO_PUBLIC_LYNKEUS_TOKEN }) in Expo, or 'lynkeus-agent/babel' in babel.config.js with LYNKEUS_TOKEN set in React Native (`lynkeus init` writes both)";

const MAX_OUTPUT = 64 * 1024;

const spawnBundle: Bundle = (bundler, args, o) =>
  new Promise((resolve) => {
    let output = '';
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-MAX_OUTPUT);
    };
    // The bundler inlines this process's environment (EXPO_PUBLIC_*, the backend's address) as a release build does.
    const child = spawn(bundler, args, { cwd: o.cwd, env: o.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'], signal: o.signal });
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', (error) => resolve({ code: null, output: `${output}${error.message}` }));
    child.on('close', (code) => resolve({ code, output }));
  });

export type FreshBundle = { ok: true; note?: string } | { ok: false; text: string };

/**
 * Makes sure a FastSim host command runs the app's current code: a stale bundle is bundled again with the
 * fastsim-bundle beside the command's fastsim-run, and when that is not there or fails, the run is refused with the
 * command to run. A run never goes on to report on code older than the app's.
 */
export const freshBundle = async (
  command: string,
  appDir: string,
  o: { skip?: string[]; log?: (line: string) => void; signal?: AbortSignal; bundle?: Bundle; envPath?: string; token?: string } = {},
): Promise<FreshBundle> => {
  // A bundle with no token keeps its agent off, unless the host hands it the token: as stale as one on old code.
  const tokenless = (b: string) => !kitGivesToken(command, appDir) && bundleToken(b, o.token) === 'missing';
  const dir = fastsimBundleDir(command, appDir);
  const stale = staleBundle(command, appDir, o.skip) ?? (dir && tokenless(dir) ? { ...bundleFacts(dir, appDir), newest: '' } : undefined);
  if (!stale) return { ok: true };
  const bundler = fastsimBundler(command, appDir, o.envPath ?? process.env.PATH);
  const again = `${o.token ? 'EXPO_PUBLIC_LYNKEUS_TOKEN="$(cat .lynkeus/token)" ' : ''}${rebundleCommand(stale, bundler)}`;
  const older = stale.newest
    ? `the FastSim bundle at ${stale.bundle} is older than ${stale.newest}`
    : `the FastSim bundle at ${stale.bundle} carries no Lynkeus token, so its app's agent stays off and never attaches (it was bundled without EXPO_PUBLIC_LYNKEUS_TOKEN)`;
  if (!bundler)
    return { ok: false, text: `${older}, and no fastsim-bundle is beside the host command's fastsim-run; bundle it again, then run again:\n  ${again}` };
  o.log?.(`${older}; bundling it again: ${again}`);
  const t0 = Date.now();
  // Read before the bundler starts: a file edited while it runs is then still a change next time.
  const inputs = bundleInputs(stale.bundle, stale.app);
  const before = inputs && snapshotInputs(stale.app, inputs);
  const hbc = path.join(stale.bundle, 'app.hbc');
  const builtBefore = fs.statSync(hbc, { throwIfNoEntry: false })?.mtimeMs;
  const done = await (o.bundle ?? spawnBundle)(bundler, [stale.app, stale.bundle, stale.platform], {
    cwd: stale.app,
    signal: o.signal,
    env: bundleEnv(o.token),
  });
  const builtNow = fs.statSync(hbc, { throwIfNoEntry: false })?.mtimeMs;
  if (done.code === 0 && before && builtNow !== undefined && builtNow !== builtBefore) keepInputs(stale.bundle, builtNow, before);
  if (done.code !== 0) {
    const tail = done.output.trim().split('\n').slice(-15).join('\n');
    return {
      ok: false,
      text: `${older}, and bundling it again failed (${done.code === null ? 'it did not finish' : `exit ${done.code}`}); fix that and run:\n  ${again}${tail ? `\n${tail}` : ''}`,
    };
  }
  const still = staleBundle(command, appDir, o.skip);
  if (!still && tokenless(stale.bundle))
    return {
      ok: false,
      text: `the FastSim bundle at ${stale.bundle} still carries no Lynkeus token after bundling it again with EXPO_PUBLIC_LYNKEUS_TOKEN and LYNKEUS_TOKEN set: ${NO_TOKEN_FIX}`,
    };
  if (still)
    return {
      ok: false,
      text: `the FastSim bundle at ${still.bundle} is still older than ${still.newest} after bundling it again (is that file dated in the future?); the run would test old code`,
    };
  return {
    ok: true,
    note: `bundled ${stale.bundle} again in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${stale.newest ? `it was older than ${stale.newest}` : 'it carried no Lynkeus token'}`,
  };
};

// Files at the app's root that configure the tools and are not in the bundle the app runs: a change to one does not
// make the JavaScript on a device old.
const ROOT_CONFIG = /^(?:package|tsconfig(?:\.[\w-]+)?|app|eas|lynkeus\.config|jsconfig)\.json$|\.config\.[cm]?[jt]s$|^\.eslintrc/;
// Metro takes a moment to rebuild and push an edit; a file saved this recently may still be on its way.
const IN_FLIGHT_MS = 1500;

export type JsAgeNow = { loadedMs: number; refreshedMs?: number };
export type StaleJs = { newest: string; changedAgoS: number; codeAgoS: number; refreshed: boolean };

/**
 * Whether the JavaScript an app on a device runs is older than the app's source: its newest source file changed after
 * the bundle loaded and after the last Fast Refresh. `js` was measured `atMs` (this computer's clock); undefined when
 * the code is current or nothing tells.
 */
export const staleDeviceJs = (appDir: string, js: JsAgeNow, atMs: number, skip: string[] = []): StaleJs | undefined => {
  const newest = newestSource(appDir, skip, (file) => path.dirname(file) === path.resolve(appDir) && ROOT_CONFIG.test(path.basename(file)));
  if (!newest) return undefined;
  const codeAt = atMs - Math.min(js.loadedMs, js.refreshedMs ?? Number.POSITIVE_INFINITY);
  if (newest.mtimeMs <= codeAt + IN_FLIGHT_MS) return undefined;
  return {
    newest: path.relative(appDir, newest.file),
    changedAgoS: Math.max(0, Math.round((atMs - newest.mtimeMs) / 1000)),
    codeAgoS: Math.max(0, Math.round((atMs - codeAt) / 1000)),
    refreshed: js.refreshedMs !== undefined,
  };
};

/** The warning a run gives about an app on a device running older JavaScript than its source. */
export const staleJsWarning = (stale: StaleJs, where: string): string =>
  `⚠ the app on ${where} runs JavaScript older than ${stale.newest} (changed ${stale.changedAgoS} s ago; the app's code is from ${stale.codeAgoS} s ago, its ${stale.refreshed ? 'last Fast Refresh' : 'load, with no Fast Refresh since'}): the cases test the code as it was. Reload the app (r in Metro, or relaunch it), check that Fast Refresh is on and Metro reaches the app, then run again`;

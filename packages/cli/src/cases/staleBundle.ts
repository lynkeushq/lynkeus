import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SOURCE = /\.(?:[cm]?[jt]sx?|json)$/;
const TEST = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const NOT_APP_CODE = new Set(['node_modules', 'ios', 'android', 'build', 'dist', 'coverage', 'web-build', '__tests__', '__mocks__']);
// A walk that big is not an app's own code any more; a bundle is better left unchecked than a run held up.
const MAX_ENTRIES = 20_000;

/** The bundle folder a `fastsim-run <bundle dir> {port}` host command names, resolved; undefined for any other command. */
export const fastsimBundleDir = (command: string, cwd: string): string | undefined => {
  const match = /fastsim-run["']?\s+("[^"]+"|'[^']+'|[^\s"']+)/.exec(command);
  if (!match?.[1]) return undefined;
  const given = match[1].replace(/^["']|["']$/g, '').replace(/^~(?=\/)/, os.homedir());
  if (given.includes('{') || given.includes('$')) return undefined;
  return path.resolve(cwd, given);
};

/** The app's newest source file and when it changed, leaving out dependencies, native projects, tests and `skip`. */
export const newestSource = (appDir: string, skip: string[] = []): { file: string; mtimeMs: number } | undefined => {
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
      } else if (entry.isFile() && SOURCE.test(entry.name) && !TEST.test(entry.name)) {
        const { mtimeMs } = fs.statSync(full);
        if (!newest || mtimeMs > newest.mtimeMs) newest = { file: full, mtimeMs };
      }
    }
  };
  walk(appDir);
  return newest;
};

/**
 * A warning when the FastSim bundle a host command runs is older than the app's code: the run would test the app as
 * it was. The app is the one fastsim-bundle recorded in the bundle's bundle.json, else `appDir`.
 */
export const staleBundleWarning = (command: string, appDir: string, skip: string[] = []): string | undefined => {
  const bundle = fastsimBundleDir(command, appDir);
  if (!bundle) return undefined;
  let built: number;
  try {
    built = fs.statSync(path.join(bundle, 'app.hbc')).mtimeMs;
  } catch {
    return undefined;
  }
  let app = appDir;
  try {
    const recorded = (JSON.parse(fs.readFileSync(path.join(bundle, 'bundle.json'), 'utf8')) as { app?: unknown }).app;
    if (typeof recorded === 'string' && fs.existsSync(recorded)) app = recorded;
  } catch {
    // A bundle made before fastsim-bundle recorded its app: the project's folder is the app.
  }
  const newest = newestSource(app, skip);
  if (!newest || newest.mtimeMs <= built) return undefined;
  return `⚠ the bundle at ${bundle} is older than ${path.relative(app, newest.file)}; run fastsim-bundle again, or the run tests the app as it was`;
};

/**
 * The files a FastSim bundle was made from, and whether any of them changed since: a bundle is stale when one of its
 * own inputs changed in content, not when any file in the app's folder is newer (lynkeus.config.json, a file nothing
 * imports). The list comes from the bundle's source map when it has one (Metro's own), else from the app's imports
 * walked from its entry. Kept with each input's hash in `<bundle>/inputs.json`, so a check is a stat per input and a
 * hash only of those dated after the bundle.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';

const MANIFEST = 'inputs.json';
// A walk that reaches this many files is not reading an app any more; the caller falls back to dates.
const MAX_FILES = 5000;
const CODE = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs'];
const PLATFORM = ['.ios', '.android', '.native', ''];
const SOURCE = /\.(?:[cm]?[jt]sx?|json)$/;
const TEST = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const ASSET_SCALE = /@\d(?:\.\d)?x(?=\.[^.]+$)/;
// What the bundler reads besides the code: its own config, the app config Expo inlines, the dependencies, the env files Expo loads.
const CONFIG =
  /^(?:package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|babel\.config\.[cm]?js|\.babelrc(?:\.json)?|metro\.config\.[cm]?[jt]s|app\.json|app\.config\.[cm]?[jt]s|tsconfig\.json|jsconfig\.json|\.env(?:\.[\w.-]+)?)$/;
// Loose on purpose: a clause with comments in it still reads, and a string that only looks like an import adds a file.
const IMPORT = /(?:\bimport\s*(?:[^'";]*?\sfrom\s*)?|\bexport\s[^'";]*?\sfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)['"]([^'"\n]+)['"]/g;
const CONTEXT = /\brequire\.context\s*\(\s*['"]([^'"\n]+)['"]/g;

export type Inputs = { files: string[]; dirs: string[] };
type Manifest = { built: number; files: Record<string, string>; dirs: Record<string, string[]> };

const stat = (file: string) => fs.statSync(file, { throwIfNoEntry: false });
const isFile = (file: string) => stat(file)?.isFile() === true;
const hash = (file: string): string | undefined => {
  try {
    return createHash('sha1').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return undefined;
  }
};
// tsconfig.json allows comments and trailing commas; a `/*` inside a string ("@/*") is no comment.
const withoutComments = (text: string): string => {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close < 0 ? text.length : close + 1;
    } else out += c;
  }
  return out;
};
const readJson = (file: string): Record<string, unknown> | undefined => {
  try {
    return JSON.parse(withoutComments(fs.readFileSync(file, 'utf8')).replace(/,(\s*[}\]])/g, '$1')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
};

/** A source file's own folder entries that count as code or JSON, for telling a new file from a known one. */
const sourcesIn = (dir: string): string[] => {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.') && (e.isDirectory() || (SOURCE.test(e.name) && !TEST.test(e.name))))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
};

const allSources = (dir: string, out: string[], dirs: string[]): void => {
  dirs.push(dir);
  for (const name of sourcesIn(dir)) {
    const full = path.join(dir, name);
    if (name === 'node_modules') continue;
    if (stat(full)?.isDirectory()) allSources(full, out, dirs);
    else out.push(full);
  }
};

/** The file a relative or aliased specifier names: every platform's variant, since a superset is safe. */
const resolveFile = (base: string): string[] => {
  if (isFile(base) && !CODE.some((ext) => base.endsWith(ext))) return [base, ...scaled(base)];
  for (const candidate of [base, path.join(base, 'index')]) {
    const found = PLATFORM.flatMap((p) => CODE.map((ext) => `${candidate}${p}${ext}`)).filter(isFile);
    if (isFile(`${candidate}.json`)) found.push(`${candidate}.json`);
    if (found.length) return found;
  }
  return isFile(base) ? [base] : [];
};

// An image required as `./logo.png` is bundled with its `@2x`, `@3x` siblings.
const scaled = (file: string): string[] => {
  const ext = path.extname(file);
  const stem = path.basename(file, ext);
  try {
    return fs
      .readdirSync(path.dirname(file))
      .filter((name) => name !== path.basename(file) && name.replace(ASSET_SCALE, '') === `${stem}${ext}`)
      .map((name) => path.join(path.dirname(file), name));
  } catch {
    return [];
  }
};

const packageName = (spec: string) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!);
const installed = (app: string, spec: string): boolean => {
  const name = packageName(spec);
  if (builtinModules.includes(name.replace(/^node:/, ''))) return true;
  for (let dir = app; ; dir = path.dirname(dir)) {
    if (stat(path.join(dir, 'node_modules', name))) return true;
    if (path.dirname(dir) === dir) return false;
  }
};

/** tsconfig/jsconfig `paths` and `baseUrl`, which Expo's Metro resolves. */
const aliasesOf = (app: string): { paths: [string, string[]][]; baseUrl?: string } => {
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const options = readJson(path.join(app, name))?.compilerOptions as { baseUrl?: unknown; paths?: unknown } | undefined;
    if (!options) continue;
    const baseUrl = typeof options.baseUrl === 'string' ? path.resolve(app, options.baseUrl) : undefined;
    const paths = Object.entries((options.paths ?? {}) as Record<string, unknown>).flatMap(([key, to]) =>
      Array.isArray(to) ? [[key, to.filter((t): t is string => typeof t === 'string')] as [string, string[]]] : [],
    );
    return { paths, ...(baseUrl ? { baseUrl } : {}) };
  }
  return { paths: [] };
};

/**
 * The app's own files its bundle is made from, walked from its entry through every import; undefined when that cannot
 * be told (no entry, an import that is neither a file nor an installed package: a Babel alias), and dates decide.
 */
export const walkInputs = (app: string): Inputs | undefined => {
  const pkg = readJson(path.join(app, 'package.json'));
  const main = pkg?.main;
  // A package the app depends on is one, installed or not (a hoisted or a pnpm layout, or none yet).
  const declared = new Set(['dependencies', 'devDependencies', 'peerDependencies'].flatMap((k) => Object.keys((pkg?.[k] ?? {}) as object)));
  const files = new Set<string>();
  const dirs: string[] = [];
  const queue: string[] = [];
  const add = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    if (CODE.some((ext) => file.endsWith(ext))) queue.push(file);
  };
  // Expo Router's entry requires every file under the app's routes folder (require.context), as Expo's AppEntry the App file.
  if (typeof main === 'string' && /^expo-router\/entry/.test(main)) {
    const routes = ['app', 'src/app'].map((d) => path.join(app, d)).find((d) => stat(d)?.isDirectory());
    if (!routes) return undefined;
    const found: string[] = [];
    allSources(routes, found, dirs);
    found.forEach(add);
  } else {
    const entry =
      typeof main === 'string' && /^expo\/AppEntry/.test(main)
        ? resolveFile(path.join(app, 'App'))
        : typeof main === 'string' && main && !installed(app, main)
          ? resolveFile(path.join(app, main))
          : ['index.js', 'index.ts', 'index.tsx']
              .map((f) => path.join(app, f))
              .filter(isFile)
              .slice(0, 1);
    if (!entry.length) return undefined;
    entry.forEach(add);
  }
  const { paths, baseUrl } = aliasesOf(app);
  const aliased = (spec: string): string[] | undefined => {
    for (const [key, targets] of paths) {
      const star = key.indexOf('*');
      const hit = star < 0 ? (spec === key ? '' : undefined) : spec.startsWith(key.slice(0, star)) ? spec.slice(star) : undefined;
      if (hit === undefined) continue;
      for (const target of targets) {
        const found = resolveFile(path.resolve(baseUrl ?? app, target.replace('*', hit)));
        if (found.length) return found;
      }
    }
    if (baseUrl) {
      const found = resolveFile(path.join(baseUrl, spec));
      if (found.length) return found;
    }
    return undefined;
  };
  while (queue.length) {
    if (files.size > MAX_FILES) return undefined;
    const file = queue.shift()!;
    let text: string;
    try {
      // Comments go first, so an apostrophe in one inside an import's braces does not hide the import.
      text = fs
        .readFileSync(file, 'utf8')
        .replace(/(^|\s)\/\*[\s\S]*?\*\//g, '$1')
        .replace(/(^|\s)\/\/[^\n]*/g, '$1');
    } catch {
      continue;
    }
    for (const [, spec] of text.matchAll(CONTEXT)) {
      const dir = path.resolve(path.dirname(file), spec!);
      if (!stat(dir)?.isDirectory()) continue;
      const found: string[] = [];
      allSources(dir, found, dirs);
      found.forEach(add);
    }
    for (const [, spec] of text.matchAll(IMPORT)) {
      if (spec!.startsWith('.') || spec!.startsWith('/')) {
        resolveFile(path.resolve(path.dirname(file), spec!)).forEach(add);
        continue;
      }
      const found = aliased(spec!);
      if (found) found.forEach(add);
      else if (!declared.has(packageName(spec!)) && !installed(app, spec!)) return undefined;
    }
  }
  return { files: [...files], dirs };
};

/** The app's own files a source map beside the bundle lists (Metro's list), when there is one. */
const fromSourceMap = (bundle: string, app: string): Inputs | undefined => {
  for (const name of ['app.js.map', 'app.hbc.map', 'app.map']) {
    const map = readJson(path.join(bundle, name));
    if (!Array.isArray(map?.sources)) continue;
    const root = typeof map.sourceRoot === 'string' ? map.sourceRoot : '';
    const files = (map.sources as unknown[])
      .filter((s): s is string => typeof s === 'string')
      .map((s) => path.resolve(app, root, s.replace(/^file:\/\//, '')))
      .filter((f) => !path.relative(app, f).startsWith('..') && !f.split(path.sep).includes('node_modules'));
    return { files, dirs: [] };
  }
  return undefined;
};

const configFiles = (app: string): string[] => {
  try {
    return fs
      .readdirSync(app)
      .filter((name) => CONFIG.test(name))
      .map((name) => path.join(app, name));
  } catch {
    return [];
  }
};

/** What a bundle in `bundle` made from `app` reads: undefined when that cannot be told. */
export const bundleInputs = (bundle: string, app: string): Inputs | undefined => {
  const found = fromSourceMap(bundle, app) ?? walkInputs(app);
  if (!found) return undefined;
  return { files: [...new Set([...found.files, ...configFiles(app)])], dirs: found.dirs };
};

const rel = (app: string, file: string) => path.relative(app, file);

/** Each input's hash and each walked folder's entries, as they are now: kept beside a bundle made from them. */
export const snapshotInputs = (app: string, inputs: Inputs): Omit<Manifest, 'built'> => ({
  files: Object.fromEntries(inputs.files.map((f) => [rel(app, f), hash(f) ?? ''])),
  dirs: Object.fromEntries(inputs.dirs.map((d) => [rel(app, d), sourcesIn(d)])),
});

export const keepInputs = (bundle: string, built: number, snapshot: Omit<Manifest, 'built'>): void => {
  try {
    fs.writeFileSync(path.join(bundle, MANIFEST), `${JSON.stringify({ built, ...snapshot })}\n`);
  } catch {
    // A bundle folder that cannot be written is checked by its inputs' dates next time.
  }
};

const readManifest = (bundle: string, built: number): Manifest | undefined => {
  const kept = readJson(path.join(bundle, MANIFEST)) as Partial<Manifest> | undefined;
  return kept && kept.built === built && kept.files && kept.dirs ? (kept as Manifest) : undefined;
};

/**
 * The first input of the bundle that changed since it was made, relative to `app`; `null` when none did; undefined
 * when the inputs cannot be told (the caller decides by dates then). A bundle with no kept inputs is judged by its
 * inputs' dates once, and its inputs are kept when it is current.
 */
export const changedInput = (bundle: string, app: string, built: number): string | null | undefined => {
  const kept = readManifest(bundle, built);
  if (!kept) {
    const inputs = bundleInputs(bundle, app);
    if (!inputs) return undefined;
    const newer = inputs.files.find((f) => (stat(f)?.mtimeMs ?? Number.POSITIVE_INFINITY) > built);
    if (newer) return rel(app, newer);
    keepInputs(bundle, built, snapshotInputs(app, inputs));
    return null;
  }
  for (const [file, sum] of Object.entries(kept.files)) {
    const full = path.join(app, file);
    const at = stat(full);
    if (!at) return file;
    if (at.mtimeMs > built && hash(full) !== sum) return file;
  }
  // A config file added since (an app.config.ts, a .env.local).
  const config = configFiles(app).find((f) => !(rel(app, f) in kept.files));
  if (config) return rel(app, config);
  // A file added where every file is bundled (Expo Router's routes, a require.context folder).
  for (const [dir, names] of Object.entries(kept.dirs)) {
    const now = sourcesIn(path.join(app, dir));
    const added = now.find((n) => !names.includes(n));
    if (added || now.length !== names.length) return path.join(dir, added ?? '');
  }
  // A file added beside an input can take its place: `Button.ios.tsx` beside `Button.tsx`.
  const byDir = new Map<string, string[]>();
  for (const file of Object.keys(kept.files)) byDir.set(path.dirname(file), [...(byDir.get(path.dirname(file)) ?? []), path.basename(file)]);
  const stem = (name: string) => name.replace(/(\.(?:ios|android|native))?\.[cm]?[jt]sx?$/, '');
  for (const [dir, names] of byDir) {
    if ((stat(path.join(app, dir))?.mtimeMs ?? 0) <= built) continue;
    const stems = new Set(names.map(stem));
    const added = sourcesIn(path.join(app, dir)).find((n) => !names.includes(n) && CODE.some((ext) => n.endsWith(ext)) && stems.has(stem(n)));
    if (added) return path.join(dir, added);
  }
  return null;
};

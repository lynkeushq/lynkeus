/**
 * What `headless` reads off the app instead of assuming it: the environment variable its API address comes from
 * (if any), and which installed packages ship code jest must transpile.
 */
import fs from 'node:fs';
import path from 'node:path';

const SKIP = new Set(['node_modules', 'ios', 'android', 'build', 'dist', 'web-build', 'coverage', '__tests__', '__mocks__']);
const CODE = /\.[cm]?[jt]sx?$/;
const MAX_FILES = 3000;

const sourceFiles = (root: string): string[] => {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) walk(full);
      } else if (CODE.test(e.name) && !/\.(test|spec)\.[jt]sx?$/.test(e.name)) out.push(full);
    }
  };
  walk(root);
  return out;
};

const ADDRESS = /process\.env\.([A-Z][A-Z0-9_]*)/g;
const LOOKS_LIKE_ADDRESS = /(URL|URI|HOST|ENDPOINT|ORIGIN|DOMAIN)/;

/** The env var the app most often reads an address from (`process.env.EXPO_PUBLIC_API_URL`), or undefined when it reads none. */
export const detectApiEnv = (root: string): string | undefined => {
  const counts = new Map<string, number>();
  for (const file of sourceFiles(root)) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const m of text.matchAll(ADDRESS)) {
      const name = m[1]!;
      if (name.startsWith('LYNKEUS_') || !LOOKS_LIKE_ADDRESS.test(name)) continue;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
};

// What every React Native app has untranspiled, by convention of the ecosystem, whatever it depends on.
const ALWAYS = ['(jest-)?react-native[^/]*', '@react-native[^/]*', 'expo(nent)?', '@expo(nent)?/.*', 'expo-.*', '@unimodules', 'unimodules', 'lynkeus-[^/]+'];

type Manifest = {
  type?: string;
  main?: unknown;
  module?: string;
  'react-native'?: unknown;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

const readJson = (file: string): Manifest | undefined => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Manifest;
  } catch {
    return undefined;
  }
};

const ESM = /^\s*(import\s[^(]|export\s)/m;
const FLOW_OR_JSX = /@flow\b|<[A-Z][\w.]*[\s/>]/;

/** Whether the file jest would load from the package is something only a transform makes runnable. */
const needsTransform = (dir: string, manifest: Manifest): boolean => {
  if (manifest.type === 'module') return true;
  const rn = manifest['react-native'];
  const entry = typeof rn === 'string' ? rn : typeof manifest.main === 'string' ? manifest.main : 'index.js';
  for (const candidate of [entry, `${entry}.js`, path.join(entry, 'index.js')]) {
    try {
      const text = fs.readFileSync(path.join(dir, candidate), 'utf8').slice(0, 20000);
      return ESM.test(text) || FLOW_OR_JSX.test(text);
    } catch {
      // try the next spelling
    }
  }
  return false;
};

const literal = (name: string) => name.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

/**
 * The packages jest must transpile: the ecosystem's own, and every package the app depends on (directly or through
 * another) whose entry is ES modules, Flow or JSX. Read from node_modules, so a dependency added later is covered.
 */
export const transformPackages = (root: string, limit = 1500): string[] => {
  const found = new Set<string>();
  const seen = new Set<string>();
  // The host's own packages too, which an app has as development dependencies.
  const queue = [...Object.keys({ ...readJson(path.join(root, 'package.json'))?.dependencies }), 'lynkeus-headless', '@testing-library/react-native'];
  const dirOf = (name: string): string | undefined => {
    for (let dir = root; ; dir = path.dirname(dir)) {
      const candidate = path.join(dir, 'node_modules', name);
      if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
      if (path.dirname(dir) === dir) return undefined;
    }
  };
  while (queue.length && seen.size < limit) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const dir = dirOf(name);
    const manifest = dir ? readJson(path.join(dir, 'package.json')) : undefined;
    if (!dir || !manifest) continue;
    // Babel transpiling itself (or its plugins) fails; they run in Node as they ship.
    if (!/^(@babel\/|babel-)/.test(name) && needsTransform(dir, manifest)) found.add(name);
    queue.push(...Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies }));
  }
  return [...ALWAYS, ...[...found].sort().map(literal)];
};

/** The transformIgnorePatterns that let those through, under a flat node_modules or pnpm's .pnpm store. */
export const transformIgnorePattern = (root: string): string => `node_modules/(?!(?:\\.pnpm/[^/]+/node_modules/)?(${transformPackages(root).join('|')})/)`;

const withoutComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

/**
 * What the app's jest setup files mock: stand-ins that isolate a unit test (i18n answering keys, a store, a
 * reshaped React Native `Image`), wrong for a host that runs the whole app. The host takes them back; what the app
 * needs mocked to be hosted goes in the headless entry, and native modules nobody mocks get the host's own answers.
 * A setup file that reads LYNKEUS_HEADLESS already decides for itself and is left alone. Read statically from the
 * config's setupFiles and setupFilesAfterEnv.
 */
export const setupMocks = (root: string, config: string): string[] => {
  const files = [...config.matchAll(/setupFiles(?:AfterEnv)?['"]?\s*:\s*\[([^\]]*)\]/g)].flatMap((m) =>
    [...m[1]!.matchAll(/['"]([^'"]+)['"]/g)].map((f) => f[1]!),
  );
  const mocks = new Set<string>();
  for (const spec of files) {
    if (!spec.startsWith('.') && !spec.startsWith('<rootDir>')) continue;
    const base = path.resolve(root, spec.replace('<rootDir>', '.'));
    const file = [base, ...['.ts', '.tsx', '.js', '.jsx'].map((e) => base + e)].find((f) => fs.existsSync(f) && fs.statSync(f).isFile());
    if (!file) continue;
    const text = withoutComments(fs.readFileSync(file, 'utf8'));
    if (text.includes('LYNKEUS_HEADLESS')) continue;
    for (const m of text.matchAll(/jest\.(?:do)?[mM]ock\(\s*['"]([^'"]+)['"]/g))
      mocks.add(m[1]!.startsWith('.') ? path.resolve(path.dirname(file), m[1]!) : m[1]!);
  }
  return [...mocks];
};

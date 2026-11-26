/**
 * The app's root component, found the way the app itself registers it: the entry (package.json's `main`, else
 * index.*) hands a component to `registerRootComponent` or `AppRegistry.registerComponent`, and that component is
 * imported from somewhere, as a default or a named export. Read statically, so `headless init` can write an entry
 * that requires exactly that file, in the case the file system has it (macOS finds `app/App.tsx` for `app/app.tsx`,
 * jest does not).
 */
import fs from 'node:fs';
import path from 'node:path';

const EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js'];
const INDEX_CANDIDATES = ['index.js', 'index.tsx', 'index.ts', 'index.jsx'];
const APP_CANDIDATES = ['App.tsx', 'App.jsx', 'App.js', 'app/App.tsx', 'app/app.tsx', 'src/App.tsx', 'src/App.jsx', 'src/App.js', 'src/app.tsx'];

/**
 * The root component: its file relative to the project and its export, and the entry that registers it, when the
 * component was found through one.
 */
export type AppComponent = { file: string; exportName: string; entry?: string };

/** The path as the file system spells it, or undefined when it does not exist in exactly that case. */
export const exactCase = (root: string, rel: string): string | undefined => {
  let dir = root;
  for (const segment of rel.split(/[\\/]/).filter(Boolean)) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return undefined;
    }
    if (!names.includes(segment)) return undefined;
    dir = path.join(dir, segment);
  }
  return rel;
};

const resolveFile = (root: string, rel: string): string | undefined => {
  const base = rel.replace(/\\/g, '/');
  for (const candidate of [base, ...EXTENSIONS.map((e) => base + e), ...EXTENSIONS.map((e) => `${base}/index${e}`)]) {
    const found = exactCase(root, candidate);
    if (found && fs.statSync(path.join(root, found)).isFile()) return found;
  }
  return undefined;
};

/** tsconfig's `paths`, as prefix → folder relative to the project: `@/*` → `app/`. */
const aliases = (root: string): [string, string][] => {
  try {
    const text = fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    const options = (JSON.parse(text) as { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } }).compilerOptions;
    const base = options?.baseUrl ?? '.';
    return Object.entries(options?.paths ?? {})
      .filter(([alias, [target]]) => alias.endsWith('*') && target?.endsWith('*'))
      .map(([alias, [target]]): [string, string] => [alias.slice(0, -1), path.join(base, target!.slice(0, -1))])
      .sort(([a], [b]) => b.length - a.length);
  } catch {
    return [];
  }
};

const resolveSpecifier = (root: string, fromFile: string, spec: string): string | undefined => {
  if (spec.startsWith('.')) return resolveFile(root, path.join(path.dirname(fromFile), spec));
  for (const [prefix, folder] of aliases(root)) if (spec.startsWith(prefix)) return resolveFile(root, path.join(folder, spec.slice(prefix.length)));
  return undefined;
};

const IDENT = '[A-Za-z_$][\\w$]*';

/** The identifier the entry registers as the root component. */
const registered = (text: string): string | undefined =>
  new RegExp(`registerRootComponent\\(\\s*(${IDENT})`).exec(text)?.[1] ??
  new RegExp(`registerComponent\\([^,]+,\\s*\\(\\)\\s*=>\\s*(${IDENT})`).exec(text)?.[1];

/** Where the entry imports `name` from, and under which export. */
const importOf = (text: string, name: string): { spec: string; exportName: string } | undefined => {
  for (const m of text.matchAll(/import\s+([^'";]+?)\s+from\s+['"]([^'"]+)['"]/g)) {
    const clause = m[1]!;
    const spec = m[2]!;
    if (new RegExp(`^${name}\\b`).test(clause.trim())) return { spec, exportName: 'default' };
    const named = /\{([^}]*)\}/.exec(clause)?.[1];
    for (const part of named?.split(',') ?? []) {
      const [imported, local] = part.trim().split(/\s+as\s+/);
      if ((local ?? imported)?.trim() === name) return { spec, exportName: imported!.trim() };
    }
  }
  const required = new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*require\\(\\s*['"]([^'"]+)['"]\\s*\\)`).exec(text);
  if (required) return { spec: required[1]!, exportName: 'default' };
  const destructured = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*['"]([^'"]+)['"]/.exec(text);
  for (const part of destructured?.[1]?.split(',') ?? []) {
    const [imported, local] = part.trim().split(/\s*:\s*/);
    if ((local ?? imported)?.trim() === name) return { spec: destructured![2]!, exportName: imported!.trim() };
  }
  return undefined;
};

/** Default when the file has a default export; else the named export called App, or the only exported component. */
export const exportOf = (root: string, file: string): string => {
  let text = '';
  try {
    text = fs.readFileSync(path.join(root, file), 'utf8');
  } catch {
    return 'default';
  }
  if (/export\s+default\b|export\s*\{[^}]*\bas\s+default\b/.test(text)) return 'default';
  const named = [...text.matchAll(new RegExp(`export\\s+(?:const|let|function|class)\\s+(${IDENT})`, 'g'))].map((m) => m[1]!);
  return named.find((n) => n === 'App') ?? named.find((n) => /^[A-Z]/.test(n)) ?? 'default';
};

/** The project's entry file, unless the app is an Expo Router app (its entry is the router's own). */
export const entryFile = (root: string, main?: string): string | undefined => {
  if (main && !main.startsWith('expo-router') && !main.includes('node_modules')) {
    const found = resolveFile(root, main.replace(/^\.\//, ''));
    if (found) return found;
  }
  return INDEX_CANDIDATES.find((c) => exactCase(root, c));
};

/** The root component the app registers, or the first standard App file there is, in the case it has on disk. */
export const findAppComponent = (root: string, main?: string): AppComponent | undefined => {
  const entry = entryFile(root, main);
  const text = entry ? fs.readFileSync(path.join(root, entry), 'utf8') : '';
  // An Expo Router app's root is the router over its route files, not a component.
  if (main?.startsWith('expo-router') || /['"]expo-router\/entry['"]/.test(text)) return undefined;
  const name = registered(text);
  const from = name ? importOf(text, name) : undefined;
  const file = from ? resolveSpecifier(root, entry!, from.spec) : undefined;
  if (file) return { file, exportName: from!.exportName, entry };
  const candidate = APP_CANDIDATES.find((c) => exactCase(root, c));
  return candidate ? { file: candidate, exportName: exportOf(root, candidate) } : undefined;
};

// Where entries were written before they went next to the cases: a project that has one keeps it.
const LEGACY_ENTRY = 'qa/headless.tsx';

/** The headless entry: the one given, one already written, else beside the project's cases (a folder Lynkeus owns). */
export const headlessEntryOf = (root: string, config: { entry?: string; cases?: { dir?: string } }, given?: string): string => {
  if (given ?? config.entry) return (given ?? config.entry)!;
  if (fs.existsSync(path.join(root, LEGACY_ENTRY))) return LEGACY_ENTRY;
  return path.join(config.cases?.dir ?? 'cases', 'headless.tsx').replace(/\\/g, '/');
};

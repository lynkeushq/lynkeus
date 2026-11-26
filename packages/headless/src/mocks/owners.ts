// Whether a missing native module is one the code reading it cannot do without. `if (NativeModules.X)` is how a library
// checks for an optional module (expo-constants for the dev launcher's), and also how one picks the module it ships
// over a proxy that throws "doesn't seem to be linked". The two read alike; what tells them apart is whose module it
// is: a library whose own native code (or TurboModule spec) defines X needs it, and only then does the fallback stand in.
import fs from 'node:fs';
import path from 'node:path';

const NATIVE_DIRS = ['ios', 'android', 'apple', 'common', 'cpp', 'shared'];
const NATIVE_FILE = /\.(m|mm|h|hpp|swift|java|kt|cpp|c)$/;
const SKIP = new Set(['node_modules', 'Pods', 'build', '.gradle', '.cxx', 'DerivedData', '__tests__']);
const SCRIPT_FILE = /\.[cm]?[jt]sx?$/;
const MAX_FILES = 4000;

/** Where the reading code lives: an installed package, or the app's own source. */
export type Reader = { package?: string; dir: string };

const texts = new Map<string, string>();

const collect = (dir: string, accept: RegExp, out: string[], keep: (text: string) => string = (t) => t) => {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= MAX_FILES) return;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP.has(e.name) && !e.name.startsWith('.')) collect(full, accept, out, keep);
    } else if (accept.test(e.name)) {
      try {
        out.push(keep(fs.readFileSync(full, 'utf8')));
      } catch {
        // unreadable: not a claim
      }
    }
  }
};

const TURBO_SPEC = /TurboModuleRegistry\.get(?:Enforcing)?\s*(?:<[^>]*>)?\(\s*['"][^'"]+['"]/g;

/** The native sources of a package (or app), and the TurboModule specs in its JavaScript, read once. */
const claimsOf = (dir: string, app: boolean): string => {
  const cached = texts.get(dir);
  if (cached !== undefined) return cached;
  const parts: string[] = [];
  for (const sub of NATIVE_DIRS) collect(path.join(dir, sub), NATIVE_FILE, parts);
  // An app's specs are in its source folders; a package's anywhere it ships them.
  if (!app) collect(dir, SCRIPT_FILE, parts, (text) => (text.match(TURBO_SPEC) ?? []).join('\n'));
  const text = parts.join('\n');
  texts.set(dir, text);
  return text;
};

export const owners = {
  /** Replaceable in tests, where the reader is a test file with no native side. */
  owns: (reader: Reader, module: string): boolean => new RegExp(`\\b${module}\\b`).test(claimsOf(reader.dir, reader.package === undefined)),
};

const NOT_THE_READER = /^(react-native|lynkeus-headless|lynkeus-agent|expo-modules-core|jest-[^/]+|@(react-native|jest|babel)\/.+)$/;

/** The code that read the module, from the stack: the first frame that is neither React Native, jest nor this host. */
export const readerOf = (root: string = process.cwd()): Reader | undefined => {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 40;
  const stack = new Error().stack ?? '';
  Error.stackTraceLimit = limit;
  for (const line of stack.split('\n').slice(1)) {
    const file = /\(?((?:[A-Za-z]:)?[/\\][^\s()]+?):\d+:\d+\)?\s*$/.exec(line)?.[1];
    if (!file) continue;
    // The last node_modules segment: pnpm nests the package under .pnpm/<name>@<version>/node_modules/.
    const installed = /^(.*node_modules[/\\]((?:@[^/\\]+[/\\])?[^/\\]+))[/\\]/.exec(file);
    if (installed) {
      const name = installed[2]!.replace(/\\/g, '/');
      if (!NOT_THE_READER.test(name)) return { package: name, dir: installed[1]! };
      continue;
    }
    if (
      file.startsWith(root) &&
      !file.includes(`${path.sep}.lynkeus${path.sep}`) &&
      !/[/\\]lynkeus-headless[/\\]|packages[/\\]headless[/\\](src|lib)[/\\](?!__tests__)/.test(file)
    )
      return { dir: root };
  }
  return undefined;
};

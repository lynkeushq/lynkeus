/**
 * Which runtime a folder's app is built with, read from its files alone: no runtime's code is loaded to decide. The one
 * place outside a runtime's directory that knows what each runtime's project looks like.
 */
import fs from 'node:fs';
import path from 'node:path';

export const RUNTIMES = ['react-native', 'flutter'] as const;
export type RuntimeId = (typeof RUNTIMES)[number];

/**
 * React Native code: react-native among the dependencies, dev or peer dependencies of the folder's package.json. Such
 * a folder keeps its React Native behavior even with a Flutter pubspec beside it; a peer dependency is a React Native
 * library or a monorepo package, whose Flutter example module is not the project.
 */
export const hasReactNative = (root: string): boolean => {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as Partial<
      Record<'dependencies' | 'devDependencies' | 'peerDependencies', Record<string, string>>
    >;
    return !!(manifest.dependencies?.['react-native'] ?? manifest.devDependencies?.['react-native'] ?? manifest.peerDependencies?.['react-native']);
  } catch {
    return false;
  }
};

/** The top-level `dependencies:` block of a pubspec: its header line and the line after its last entry. */
const dependenciesBlock = (lines: string[]): { header: number; end: number } | undefined => {
  const header = lines.findIndex((line) => /^dependencies:\s*(#.*)?$/.test(line));
  if (header < 0) return undefined;
  let end = lines.length;
  for (let i = header + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i]!) && !lines[i]!.startsWith('#')) {
      end = i;
      break;
    }
  }
  return { header, end };
};

/** A pubspec whose dependencies take flutter from the SDK, on two lines or as `flutter: { sdk: flutter }`. */
export const isFlutterPubspec = (text: string): boolean => {
  const lines = text.split(/\r?\n/);
  const block = dependenciesBlock(lines);
  if (!block) return false;
  const body = lines.slice(block.header + 1, block.end).join('\n');
  return /^[ \t]+flutter:\s*(\n[ \t]+sdk:\s*flutter\b|\{\s*sdk:\s*flutter\s*\})/m.test(body);
};

/** The package's name, as `pubspec.yaml` gives it. */
export const pubspecName = (text: string): string | undefined => /^name:\s*['"]?([A-Za-z_]\w*)['"]?\s*(#.*)?$/m.exec(text)?.[1];

const pubspecOf = (root: string): string | undefined => {
  try {
    return fs.readFileSync(path.join(root, 'pubspec.yaml'), 'utf8');
  } catch {
    return undefined;
  }
};

const flutterPubspec = (root: string): boolean => {
  const pubspec = pubspecOf(root);
  return pubspec !== undefined && isFlutterPubspec(pubspec) && pubspecName(pubspec) !== undefined;
};

/** Flutter for a named Flutter pubspec in a folder that is not also a React Native app; React Native otherwise. */
export const runtimeOf = (root: string): RuntimeId => (!hasReactNative(root) && flutterPubspec(root) ? 'flutter' : 'react-native');

/** `--runtime` when given (one of the runtimes), else the folder's. */
export const runtimeFlag = (flag: unknown, root: string): RuntimeId => {
  if (flag === undefined) return runtimeOf(root);
  if (!RUNTIMES.includes(flag as RuntimeId)) throw new Error(`the runtime is ${RUNTIMES.join(' or ')}, not ${String(flag)}`);
  return flag as RuntimeId;
};

/** `lynkeus init --runtime`: the flag wins, and Flutter needs a Flutter pubspec to set up; otherwise the folder's. */
export const chooseRuntime = (root: string, requested?: string): RuntimeId => {
  if (requested !== undefined && !RUNTIMES.includes(requested as RuntimeId)) throw new Error(`--runtime is ${RUNTIMES.join(' or ')}, not ${requested}`);
  if (requested === 'react-native') return 'react-native';
  if (requested === 'flutter') {
    if (!flutterPubspec(root))
      throw new Error(
        '--runtime flutter needs a pubspec.yaml here whose dependencies include flutter (sdk: flutter); run from the app’s folder or pass --root',
      );
    return 'flutter';
  }
  return runtimeOf(root);
};

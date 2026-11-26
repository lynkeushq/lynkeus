// A library that has native code and ships a jest mock of its own knows best what its JavaScript expects from the
// native side: the host uses that mock for every such dependency of the app it does not mock already.
import fs from 'node:fs';
import path from 'node:path';

import { log } from '../runtime.js';
import type { MockFactory } from './factories.js';

declare const jest: { requireActual(name: string): unknown };

// Where libraries put the mock (react-native-keyboard-controller/jest, react-native-permissions/mock,
// react-native-safe-area-context/jest/mock), most specific first.
const MOCK_PATHS = ['jest/mock', 'mock', 'jest'];

// A setup file mocks the library's own internals (react-native-gesture-handler/jestSetup); it is run, not used as the module.
const SETUP_PATHS = ['jestSetup', 'jest-setup', 'jest/setup'];

// Reanimated's mock lacks the newer APIs apps call; the host keeps the module real and defers its completions.
const OWN_MOCK_FALLS_SHORT = new Set(['react-native-reanimated']);

type Manifest = { dependencies?: Record<string, string> };

const packageDir = (root: string, name: string): string | undefined => {
  for (let dir = root; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (path.dirname(dir) === dir) return undefined;
  }
};

// Only native libraries: a JavaScript one that ships a mock (for its own users' tests) works as it is.
export const hasNativeCode = (dir: string): boolean => {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return false;
  }
  return entries.some((e) => e === 'ios' || e === 'android' || e === 'expo-module.config.json' || e.endsWith('.podspec'));
};

const resolveFrom = (root: string, id: string): string | undefined => {
  try {
    return require.resolve(id, { paths: [root] });
  } catch {
    return undefined;
  }
};

const firstOf = (root: string, name: string, subs: string[]): string | undefined => {
  for (const sub of subs) {
    const file = resolveFrom(root, `${name}/${sub}`);
    if (file) return file;
  }
  return undefined;
};

export const mockPathOf = (root: string, name: string): string | undefined => firstOf(root, name, MOCK_PATHS);

export type Shipped = { factories: Record<string, MockFactory>; setups: Record<string, string> };

/**
 * For the app's native dependencies not in `taken`: module name → a factory that loads the library's own mock, and
 * module name → the setup file to run where the library ships that instead.
 */
export const shippedMocks = (taken: Set<string>, root: string = process.cwd()): Shipped => {
  let manifest: Manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as Manifest;
  } catch {
    return { factories: {}, setups: {} };
  }
  const factories: Record<string, MockFactory> = {};
  const setups: Record<string, string> = {};
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    if (taken.has(name) || OWN_MOCK_FALLS_SHORT.has(name)) continue;
    const dir = packageDir(root, name);
    // A package with a jest preset (react-native) is the environment the mocks run in, not a library to stand in for.
    if (!dir || !hasNativeCode(dir) || ['jest-preset.js', 'jest-preset.json'].some((f) => fs.existsSync(path.join(dir, f)))) continue;
    const file = mockPathOf(root, name);
    if (!file) {
      const setup = firstOf(root, name, SETUP_PATHS);
      if (setup) setups[name] = setup;
      continue;
    }
    factories[name] = () => {
      const mock = require(file) as unknown;
      // Some ship a setup file that mocks the library's internals and exports nothing: the library itself then stays.
      if (typeof mock === 'object' && mock !== null && Object.keys(mock).length === 0) {
        log(`${name}: ${path.relative(root, file)} exports nothing (a setup file); keeping the library`);
        return jest.requireActual(name);
      }
      return mock;
    };
  }
  return { factories, setups };
};

/** React Native, bare or Expo: the runtime Lynkeus started with. */
import fs from 'node:fs';
import path from 'node:path';

import {
  type BuildDevice,
  headlessMissing,
  installAgent,
  mountAgent,
  reactNativeExtractor,
  readRouteParams,
  type RuntimeAdapter,
  setupChecks,
} from '../api.js';
import { readIdentifierChange } from './identifiers.js';
import { readStringTable } from './strings.js';

const isExpo = (root: string): boolean => {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return !!(manifest.dependencies?.expo ?? manifest.devDependencies?.expo);
  } catch {
    return false;
  }
};

/**
 * Expo's `run:android --device` takes an emulator's AVD name, not its adb serial; a phone is named by its model, which
 * adb does not say reliably, so with one device up none is named. React Native's CLI takes the serial and the udid.
 */
const devBuild = (root: string, device: BuildDevice): string[] => {
  if (isExpo(root)) {
    const named = device.platform === 'ios' ? device.id : (device.avd ?? (device.only ? undefined : device.name));
    return ['npx', 'expo', `run:${device.platform}`, ...(named ? ['--device', named] : []), '--no-bundler'];
  }
  return device.platform === 'ios'
    ? ['npx', 'react-native', 'run-ios', '--udid', device.id, '--no-packager']
    : ['npx', 'react-native', 'run-android', '--deviceId', device.id, '--no-packager'];
};

export const reactNative: RuntimeAdapter = {
  id: 'react-native',
  init: (root, { install }) => {
    const installed = install ? installAgent(root) : undefined;
    // An app that imports a package it does not have does not build: the mount waits for the install.
    if (installed && !installed.ok) return [installed.text];
    const lines = [...(installed ? [installed.text] : []), ...mountAgent(root)];
    lines.push('next: build the app again and open it, then `lynkeus status` (over MCP: the status tool) to see that it attaches');
    lines.push('      or, with no native build at all: `lynkeus headless init` runs the app in Node in a minute');
    return lines;
  },
  setupChecks,
  attachFix: 'open a development build made after `lynkeus init`, with Metro restarted (`--reset-cache`); or `lynkeus headless start` for no simulator',
  headlessCheck: (root, entry) => {
    const unloadable = headlessMissing(root);
    return {
      what: unloadable.length ? 'the app can run headless, in Node with no simulator' : 'the app can run headless (jest, Testing Library, lynkeus-headless)',
      ok: !unloadable.length && fs.existsSync(path.join(root, entry)),
      fix: '`lynkeus headless init` installs what it needs and writes its entry; optional',
    };
  },
  graphMissing: (root) =>
    fs.existsSync(path.join(root, 'tsconfig.json')) ? undefined : `No tsconfig.json under ${root}: run this inside a React Native app (or pass --root).`,
  buildGraph: async (root) => (await reactNativeExtractor()).extractScreenGraph({ root }),
  sources: { pattern: /\.[cm]?[jt]sx?$/, relative: false },
  stringTable: readStringTable,
  identifierChange: readIdentifierChange,
  routeParams: (appRoot, paramsFile) => readRouteParams(appRoot, paramsFile),
  fastsimBuild: (platform) => {
    if (platform !== 'ios' && platform !== 'android') throw new Error(`the platform is ios or android, not ${platform}`);
    return platform;
  },
  hostCommandEnv: () => ({}),
  devBuild,
  bundler: (root, { port, resetCache }) =>
    isExpo(root)
      ? ['npx', 'expo', 'start', '--dev-client', '--port', String(port), ...(resetCache ? ['--clear'] : [])]
      : ['npx', 'react-native', 'start', '--port', String(port), ...(resetCache ? ['--reset-cache'] : [])],
  runner: { shortPullsBelow: false, waitTextIsText: false },
};

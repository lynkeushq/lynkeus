import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { Screen } from 'lynkeus-protocol';

import { freePorts } from '../cases/portClaim.js';
import { agentInstallCommand, headlessSpecs, importStyle, managerCommand, mountAgent, type PathProbe } from '../commands/init.js';
import { runTargets } from '../commands/runTargets.js';
import { ensureLynkeusIgnore, LYNKEUS_GITIGNORE } from '../config.js';
import { CLI_VERSION } from '../device/agentVersion.js';
import { appIdsOf, finishDevMenuOnboarding, onboardedPrefs, usesDevClient } from '../device/devMenu.js';
import type { DeviceInfo } from '../device/devices.js';
import { describeScreen, nativeCover } from '../device/driver.js';
import { reactNative } from '../runtimes/react-native/index.js';

const tmp = (prefix: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

const write = (root: string, files: Record<string, string>) => {
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
};

/** A pnpm 9 project as `pnpm install` leaves it, with no packageManager in package.json (Ignite's template). */
const pnpmApp = (extra: Record<string, string> = {}) => {
  const root = tmp('lynkeus-pnpm-');
  write(root, {
    'package.json': JSON.stringify({ name: 'shop', dependencies: { expo: '55.0.5' } }),
    'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
    'node_modules/.modules.yaml': 'hoistPattern:\n  - "*"\nlayoutVersion: 5\nnodeLinker: hoisted\npackageManager: pnpm@9.15.9\npendingBuilds: []\n',
    ...extra,
  });
  return root;
};

const probe = (pnpms: ReturnType<PathProbe['pnpms']>, corepack = true): PathProbe => ({ pnpms: () => pnpms, corepack: () => corepack });

test('a pnpm project is run with the pnpm that made its node_modules, not the latest corepack fetches', () => {
  const root = pnpmApp();
  // Only corepack's shim on PATH: it would download the latest pnpm, whose other major refuses this node_modules.
  assert.deepEqual(managerCommand(root, probe([{ file: '/node/bin/pnpm', corepack: true }])), ['corepack', 'pnpm@9.15.9']);
  assert.deepEqual(managerCommand(root, probe([{ file: '/node/bin/pnpm', corepack: true }], false)), ['npx', '--yes', 'pnpm@9.15.9']);
  // A pnpm of the same major on PATH (mise, Homebrew) is used as it is, even behind corepack's shim.
  assert.deepEqual(
    managerCommand(
      root,
      probe([
        { file: '/node/bin/pnpm', corepack: true },
        { file: '/mise/shims/pnpm', corepack: false, version: '9.12.0' },
      ]),
    ),
    ['/mise/shims/pnpm'],
  );
  assert.deepEqual(managerCommand(root, probe([{ file: '/opt/pnpm', corepack: false, version: '10.4.0' }])), ['corepack', 'pnpm@9.15.9']);
});

test('a project that names its package manager, or another manager, is left to it', () => {
  const declared = pnpmApp({ 'package.json': JSON.stringify({ name: 'shop', packageManager: 'pnpm@10.4.0' }) });
  assert.deepEqual(managerCommand(declared, probe([])), ['pnpm']);
  const npm = tmp('lynkeus-npm-');
  write(npm, { 'package.json': '{}', 'package-lock.json': '{}' });
  assert.deepEqual(managerCommand(npm, probe([])), ['npm']);
});

test('the agent is added at this CLI’s version with the project’s manager, not through Expo’s installer', () => {
  const command = agentInstallCommand(pnpmApp(), probe([{ file: '/node/bin/pnpm', corepack: true }]));
  assert.deepEqual(command, ['corepack', 'pnpm@9.15.9', 'add', `lynkeus-agent@${CLI_VERSION}`]);
  const npm = tmp('lynkeus-npm-');
  write(npm, { 'package.json': JSON.stringify({ dependencies: { expo: '55.0.5' } }), 'package-lock.json': '{}' });
  assert.deepEqual(agentInstallCommand(npm), ['npm', 'install', `lynkeus-agent@${CLI_VERSION}`]);
});

test('the headless packages are pinned: lynkeus-headless to the CLI, jest-expo to the SDK’s range', () => {
  const root = pnpmApp({ 'node_modules/expo/package.json': '{"name":"expo"}', 'node_modules/expo/bundledNativeModules.json': '{"jest-expo":"~55.0.9"}' });
  assert.deepEqual(headlessSpecs(root, ['jest', 'lynkeus-headless', 'jest-expo']), ['jest', `lynkeus-headless@${CLI_VERSION}`, 'jest-expo@~55.0.9']);
});

test('init does not mount the agent when installing it failed: the app would not build', () => {
  const root = tmp('lynkeus-failed-');
  const index = "import { AppRegistry } from 'react-native'\nAppRegistry.registerComponent('demo', () => () => null)\n";
  write(root, { 'package.json': JSON.stringify({ name: 'demo' }), 'package-lock.json': '{}', 'index.js': index });
  const bin = tmp('lynkeus-bin-');
  fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\necho "npm error code E404" >&2\necho "npm error 404 Not Found - lynkeus-agent" >&2\nexit 1\n', {
    mode: 0o755,
  });
  const saved = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${saved}`;
  try {
    const lines = reactNative.init(root, { install: true, headless: false });
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /could not install lynkeus-agent .*404 Not Found.*not mounted until it is installed/);
    assert.equal(fs.readFileSync(path.join(root, 'index.js'), 'utf8'), index);
    assert.ok(!fs.existsSync(path.join(root, '.lynkeus', 'token')));
  } finally {
    process.env.PATH = saved;
  }
});

test('the mount follows the entry’s quotes and semicolons, after a multi-line import', () => {
  assert.deepEqual(importStyle('import "a"\nimport { b } from "b" // why\n'), { quote: '"', semi: false });
  assert.deepEqual(importStyle("import a from 'a';\nimport 'b';\n"), { quote: "'", semi: true });
  const root = tmp('lynkeus-quotes-');
  write(root, {
    'package.json': JSON.stringify({ name: 'shop', dependencies: { expo: '55.0.5' } }),
    'index.tsx': 'import "@expo/metro-runtime"\nimport {\n  registerRootComponent,\n} from "expo"\n\nregisterRootComponent(App)\n',
  });
  mountAgent(root);
  const text = fs.readFileSync(path.join(root, 'index.tsx'), 'utf8');
  assert.match(text, /^import \{ auto \} from "lynkeus-agent\/auto"$/m);
  assert.match(text, /^auto\(\{ token: process\.env\.EXPO_PUBLIC_LYNKEUS_TOKEN \}\)$/m);
  assert.ok(text.indexOf('} from "expo"') < text.indexOf('lynkeus-agent/auto'));
});

test('an Expo app whose .gitignore lacks .env*.local gets the line; one that has it is left alone', () => {
  const ignite = tmp('lynkeus-ignite-');
  write(ignite, {
    'package.json': JSON.stringify({ name: 'shop', dependencies: { expo: '55.0.5' } }),
    'index.js': "import 'expo'\n",
    '.gitignore': 'node_modules/\n.expo/*\n',
  });
  const notes = mountAgent(ignite);
  assert.ok(notes.includes('added .env*.local to .gitignore, so the token in .env.local stays out of git'));
  assert.match(fs.readFileSync(path.join(ignite, '.gitignore'), 'utf8'), /^node_modules\/\n\.expo\/\*\n\n# .*\n\.env\*\.local\n$/);
  const expo = tmp('lynkeus-expo-template-');
  write(expo, {
    'package.json': JSON.stringify({ name: 'shop', dependencies: { expo: '55.0.5' } }),
    'index.js': "import 'expo'\n",
    '.gitignore': '# local env files\n.env*.local\n',
  });
  assert.ok(mountAgent(expo).includes('.gitignore already keeps .env.local out of git'));
  assert.equal(fs.readFileSync(path.join(expo, '.gitignore'), 'utf8'), '# local env files\n.env*.local\n');
});

test('.lynkeus keeps out of git everything but what a team shares', () => {
  const root = tmp('lynkeus-ignore-');
  execFileSync('git', ['init', '-q'], { cwd: root });
  // A project set up before: its .gitignore kept only the token out.
  write(root, { '.lynkeus/.gitignore': 'token\n' });
  ensureLynkeusIgnore(root);
  assert.equal(fs.readFileSync(path.join(root, '.lynkeus/.gitignore'), 'utf8'), LYNKEUS_GITIGNORE);
  const files = [
    'token',
    'runs/2026-11-26/run.json',
    'fastsim-ios/app.js',
    'jest-cache/abc/x',
    'flakes.json',
    'graph.json',
    'screens/Home.json',
    'snapshots/home.tree.txt',
    'funnels/signup.json',
    'lint/home.json',
    'lint.json',
  ];
  write(root, Object.fromEntries(files.map((f) => [`.lynkeus/${f}`, '{}'])));
  const ignored = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .map((l) => l.slice(3))
    .sort();
  assert.deepEqual(ignored, [
    '.lynkeus/.gitignore',
    '.lynkeus/funnels/signup.json',
    '.lynkeus/lint.json',
    '.lynkeus/lint/home.json',
    '.lynkeus/snapshots/home.tree.txt',
  ]);
  // One the project wrote itself keeps its lines, and the token out.
  write(root, { '.lynkeus/.gitignore': 'runs/\n' });
  ensureLynkeusIgnore(root);
  assert.equal(fs.readFileSync(path.join(root, '.lynkeus/.gitignore'), 'utf8'), 'runs/\ntoken\n');
});

test('hosts side by side get free driver ports, past the one an attached app dials', async () => {
  const dir = tmp('lynkeus-ports-');
  const busy = net.createServer();
  const taken = await new Promise<number>((resolve) => busy.listen(0, '127.0.0.1', () => resolve((busy.address() as net.AddressInfo).port)));
  try {
    fs.writeFileSync(path.join(dir, `lynkeus-port-${taken + 2}.pid`), '1');
    const ports = await freePorts(2, taken - 1, dir);
    assert.equal(ports.length, 2);
    assert.ok(!ports.includes(taken) && !ports.includes(taken + 2) && ports.every((p) => p > taken - 1));
  } finally {
    busy.close();
  }
});

const sim: DeviceInfo = { id: 'AAAA-1111', name: 'iPhone 17 Pro', platform: 'ios', type: 'simulator', connected: true };
const emulator: DeviceInfo = { id: 'emulator-5554', name: 'emulator-5554', platform: 'android', type: 'emulator', connected: true };
const headlessReady = { what: 'headless', ok: true };

test('status lists where cases run, reverses Android to the port, and marks what is missing without a ✓', () => {
  const none = runTargets({ port: 8123, simulators: [], android: [], headless: { what: 'h', ok: false, fix: 'init' }, fastsim: [] });
  assert.ok(none.checks.every((c) => !c.ok && c.optional));
  assert.match(none.checks.find((c) => c.what.startsWith('Lynkeus FastSim'))!.what, /not installed/);
  assert.match(none.advice, /^day to day: .*; in CI: headless/);
  const up = runTargets({
    attached: 'shop-trial',
    port: 8200,
    simulators: [sim],
    android: [{ ...emulator, reversed: true }],
    headless: headlessReady,
    fastsim: [{ version: '0.9.0', variant: 'ios' }],
  });
  assert.deepEqual(
    up.checks.map((c) => `${c.ok ? '✓' : '○'} ${c.what}`),
    [
      '✓ iOS Simulator: iPhone 17 Pro (booted)',
      '✓ Android emulator: emulator-5554 (adb reverse tcp:8200 done)',
      '✓ headless, in Node with no simulator: ready',
      '✓ Lynkeus FastSim: 0.9.0, ios',
    ],
  );
  assert.equal(
    up.advice,
    'day to day: the attached app (shop-trial); in CI: FastSim hosts side by side (`case run --jobs <n> --host-command`, see its README)',
  );
});

test('the dev menu is found by expo-dev-client, and the app’s ids from app.json, app.config or the native projects', () => {
  const root = tmp('lynkeus-devmenu-');
  write(root, { 'package.json': JSON.stringify({ dependencies: { 'expo-dev-client': '~55.0.11' } }) });
  assert.ok(usesDevClient(root));
  assert.deepEqual(appIdsOf(root), { ios: undefined, android: undefined });
  write(root, { 'app.json': JSON.stringify({ ios: { bundleIdentifier: 'com.shop' }, android: { package: 'com.shop.android' } }) });
  assert.deepEqual(appIdsOf(root), { ios: 'com.shop', android: 'com.shop.android' });
  assert.deepEqual(appIdsOf(root, 'com.configured'), { ios: 'com.configured', android: 'com.configured' });
  fs.rmSync(path.join(root, 'app.json'));
  write(root, { 'app.config.ts': "export default {\n  ios: {\n    bundleIdentifier: 'com.fromconfig',\n  },\n}\n" });
  write(root, { 'android/app/build.gradle': "android {\n    defaultConfig {\n        applicationId 'com.fromgradle'\n    }\n}\n" });
  assert.deepEqual(appIdsOf(root), { ios: 'com.fromconfig', android: 'com.fromgradle' });
  fs.rmSync(path.join(root, 'app.config.ts'));
  write(root, {
    'ios/Shop.xcodeproj/project.pbxproj': '\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = "$(PRODUCT_NAME)";\n\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = com.frompbx;\n',
  });
  assert.equal(appIdsOf(root).ios, 'com.frompbx');
  assert.ok(!usesDevClient(tmp('lynkeus-nodevmenu-')));
});

test('the Android dev menu preferences get the onboarding finished and the button hidden, keeping the rest', () => {
  const xml = onboardedPrefs(
    '<?xml version=\'1.0\' encoding=\'utf-8\' standalone=\'yes\' ?>\n<map>\n    <boolean name="motionGestureEnabled" value="false" />\n    <boolean name="isOnboardingFinished" value="false" />\n</map>\n',
  );
  assert.match(xml, /<boolean name="motionGestureEnabled" value="false" \/>/);
  assert.match(xml, /<boolean name="isOnboardingFinished" value="true" \/>/);
  assert.match(xml, /<boolean name="showFab" value="false" \/>/);
  assert.equal(xml.match(/isOnboardingFinished/g)?.length, 1);
  assert.match(onboardedPrefs(''), /^<\?xml.*\n<map>\n {4}<boolean name="isOnboardingFinished" value="true" \/>/);
});

test('on a simulator the dev menu is marked onboarded through simctl, once; a phone is left alone', async () => {
  const bin = tmp('lynkeus-xcrun-');
  const log = path.join(bin, 'log');
  // get_app_container answers (the app is installed); the first read finds nothing set.
  fs.writeFileSync(
    path.join(bin, 'xcrun'),
    `#!/bin/sh\necho "$*" >> "${log}"\ncase "$*" in\n  *"defaults read"*) [ -f "${bin}/set" ] && echo 1 && exit 0; exit 1 ;;\n  *"defaults write"*) touch "${bin}/set" ;;\nesac\n`,
    { mode: 0o755 },
  );
  const saved = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${saved}`;
  try {
    assert.equal(await finishDevMenuOnboarding(sim, { ios: 'com.shop' }), 'done');
    assert.equal(await finishDevMenuOnboarding(sim, { ios: 'com.shop' }), 'already');
    assert.equal(await finishDevMenuOnboarding({ ...sim, type: 'physical' }, { ios: 'com.shop' }), undefined);
    assert.deepEqual(fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).slice(0, 4), [
      'simctl get_app_container AAAA-1111 com.shop data',
      'simctl spawn AAAA-1111 defaults read com.shop EXDevMenuIsOnboardingFinished',
      'simctl spawn AAAA-1111 defaults write com.shop EXDevMenuIsOnboardingFinished -bool YES',
      'simctl spawn AAAA-1111 defaults write com.shop EXDevMenuShowFloatingActionButton -bool NO',
    ]);
  } finally {
    process.env.PATH = saved;
  }
});

const screenOf = (elements: Partial<Screen['elements'][number]>[], presenting?: Screen['presenting']): Screen =>
  ({
    route: 'Welcome',
    path: ['Welcome'],
    commit: 1,
    busy: false,
    costMs: 1,
    window: { w: 402, h: 874 },
    presenting,
    elements: elements.map((e, i) => ({ i, kind: 'button', enabled: true, frame: { x: 0, y: i * 50, w: 100, h: 40 }, ...e })),
  }) as Screen;

test('every control covered at once is named as a native view over the app, not just ~covered', () => {
  const covered = screenOf([
    { testId: 'next', covered: true },
    { kind: 'input', testId: 'email', covered: true },
    { kind: 'text', text: 'Welcome' },
  ]);
  assert.match(nativeCover(covered) ?? '', /^a native view outside React Native covers the app/);
  assert.match(describeScreen(covered).split('\n')[1] ?? '', /^! a native view outside React Native covers the app/);
  // One control a touch reaches, or the app's own modal on top: the app is not covered from outside.
  assert.equal(nativeCover(screenOf([{ testId: 'next', covered: true }, { testId: 'back' }])), undefined);
  assert.equal(nativeCover(screenOf([{ testId: 'next', covered: true }], { i: 0, modal: true })), undefined);
  assert.equal(nativeCover(screenOf([{ kind: 'text', text: 'only text' }])), undefined);
});

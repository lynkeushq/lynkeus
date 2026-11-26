import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { exactCase, findAppComponent, headlessEntryOf } from '../commands/appEntry.js';
import { detectApiEnv, setupMocks, transformPackages } from '../commands/appEnv.js';
import { doctor, satisfies } from '../commands/doctor.js';
import { hostTestFlag } from '../commands/headless.js';

const project = (files: Record<string, string>): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-detect-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
};

test('the root component is the one the entry registers, named or default, in the case it has on disk', () => {
  const ignite = project({
    'package.json': JSON.stringify({ main: 'index.tsx' }),
    'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./app/*'] } } }),
    'index.tsx': 'import { registerRootComponent } from "expo"\nimport { App } from "@/app"\nregisterRootComponent(App)\n',
    'app/app.tsx': 'export function App() { return null }\n',
  });
  assert.deepEqual(findAppComponent(ignite, 'index.tsx'), { file: 'app/app.tsx', exportName: 'App', entry: 'index.tsx' });
  // macOS finds app/App.tsx for app/app.tsx; jest's resolver does not.
  assert.equal(exactCase(ignite, 'app/App.tsx'), undefined);

  const bare = project({
    'index.js': "import { AppRegistry } from 'react-native'\nimport Root, { other } from './src/Root'\nAppRegistry.registerComponent('demo', () => Root)\n",
    'src/Root.tsx': 'export default () => null\n',
  });
  assert.deepEqual(findAppComponent(bare), { file: 'src/Root.tsx', exportName: 'default', entry: 'index.js' });

  const renamed = project({
    'index.js': "import { AppRegistry } from 'react-native'\nimport { Shell as Main } from './src/shell'\nAppRegistry.registerComponent('demo', () => Main)\n",
    'src/shell.tsx': 'export const Shell = () => null\n',
  });
  assert.equal(findAppComponent(renamed)?.exportName, 'Shell');

  const noEntry = project({ 'App.tsx': 'export const App = () => null\n' });
  assert.deepEqual(findAppComponent(noEntry), { file: 'App.tsx', exportName: 'App' });
  assert.equal(findAppComponent(project({ 'index.js': "import 'expo-router/entry'\n" })), undefined);
});

test('the headless entry defaults to an existing one, else to the cases folder', () => {
  assert.equal(headlessEntryOf(project({ 'qa/headless.tsx': '' }), {}), 'qa/headless.tsx');
  assert.equal(headlessEntryOf(project({}), {}), 'cases/headless.tsx');
  assert.equal(headlessEntryOf(project({}), { cases: { dir: 'e2e' } }), 'e2e/headless.tsx');
  assert.equal(headlessEntryOf(project({}), { entry: 'x/y.tsx' }), 'x/y.tsx');
});

test('the API env var is the one the app reads an address from, or none', () => {
  const root = project({
    'src/api.ts': 'const base = process.env.EXPO_PUBLIC_API_URL\nconst again = process.env.EXPO_PUBLIC_API_URL\nconst flag = process.env.EXPO_PUBLIC_FLAG\n',
    'node_modules/x/index.js': 'process.env.OTHER_URL',
  });
  assert.equal(detectApiEnv(root), 'EXPO_PUBLIC_API_URL');
  assert.equal(detectApiEnv(project({ 'app/a.ts': 'const url = "https://api.example.com"' })), undefined);
});

test('jest transpiles the dependencies that ship ES modules, Flow or JSX, and not the ones that ship CommonJS', () => {
  const root = project({
    'package.json': JSON.stringify({ dependencies: { 'esm-lib': '1', 'cjs-lib': '1' } }),
    'node_modules/esm-lib/package.json': JSON.stringify({ main: 'index.js', dependencies: { 'deep-jsx': '1' } }),
    'node_modules/esm-lib/index.js': 'export const a = 1\n',
    'node_modules/deep-jsx/package.json': JSON.stringify({ 'react-native': 'src/index.js' }),
    'node_modules/deep-jsx/src/index.js': 'const V = () => <View />\n',
    'node_modules/cjs-lib/package.json': JSON.stringify({ main: 'index.js' }),
    'node_modules/cjs-lib/index.js': 'module.exports = 1\n',
  });
  const packages = transformPackages(root);
  assert.ok(packages.includes('esm-lib') && packages.includes('deep-jsx'));
  assert.ok(!packages.includes('cjs-lib'));
});

test('the host takes back what the app’s jest setup mocks, unless the setup decides for headless itself', () => {
  const root = project({
    'test/setup.ts': "jest.mock('i18next', () => ({}))\njest.doMock('react-native', () => ({}))\njest.mock('../app/i18n/index.ts', () => ({}))\n",
    'test/headless-aware.ts': "if (!process.env.LYNKEUS_HEADLESS) jest.mock('store', () => ({}))\n",
  });
  assert.deepEqual(setupMocks(root, 'module.exports = { setupFiles: ["<rootDir>/test/setup.ts"] }'), [
    'i18next',
    'react-native',
    path.join(root, 'app/i18n/index.ts'),
  ]);
  assert.deepEqual(setupMocks(root, 'module.exports = { setupFilesAfterEnv: ["./test/headless-aware.ts"] }'), []);
});

test('the host file is outside every default testMatch, and named by the flag the app’s config allows', () => {
  const plain = project({ 'jest.config.js': 'module.exports = { preset: "jest-expo" }' });
  assert.equal(hostTestFlag(plain, 'headless.host.tsx'), '--testMatch=**/.lynkeus/host/headless.host.tsx');
  const regex = project({ 'jest.config.js': 'module.exports = { testRegex: "/__tests__/.*\\\\.test\\\\.tsx?$" }' });
  assert.equal(hostTestFlag(regex, 'headless.host.tsx'), '--testRegex=/\\.lynkeus/host/headless\\.host\\.tsx$');
  assert.doesNotMatch('headless.host.tsx', /\.(test|spec)\.[jt]sx?$/);
});

test('doctor answers each native dependency the way the host will, and checks the Testing Library range', () => {
  const root = project({
    'package.json': JSON.stringify({
      name: 'demo',
      dependencies: { 'with-mock': '1', 'with-setup': '1', bare: '1', 'pure-js': '1', 'react-native-mmkv': '1' },
    }),
    'node_modules/with-mock/package.json': JSON.stringify({ name: 'with-mock' }),
    'node_modules/with-mock/ios/x.m': '',
    'node_modules/with-mock/jest/index.js': 'module.exports = {}',
    'node_modules/with-setup/package.json': JSON.stringify({ name: 'with-setup' }),
    'node_modules/with-setup/android/x.kt': '',
    'node_modules/with-setup/jestSetup.js': '',
    'node_modules/bare/package.json': JSON.stringify({ name: 'bare' }),
    'node_modules/bare/bare.podspec': '',
    'node_modules/pure-js/package.json': JSON.stringify({ name: 'pure-js' }),
    'node_modules/react-native-mmkv/package.json': JSON.stringify({ name: 'react-native-mmkv' }),
    'node_modules/react-native-mmkv/ios/x.mm': '',
    'node_modules/@testing-library/react-native/package.json': JSON.stringify({ version: '11.5.0' }),
    'node_modules/lynkeus-headless/package.json': JSON.stringify({ peerDependencies: { '@testing-library/react-native': '>=12.0.0' } }),
  });
  const out = doctor(root, 'cases/headless.tsx').join('\n');
  assert.match(out, /✓ with-mock\s+its own jest mock/);
  assert.match(out, /✓ with-setup\s+its own jest setup/);
  assert.match(out, /✓ react-native-mmkv\s+Lynkeus default mock/);
  assert.match(out, /⚠ bare\s+no mock: what it asks its native side is answered empty by default/);
  assert.match(out, /jest\.mock\('bare', \(\) => \(\{/);
  assert.doesNotMatch(out, /pure-js/);
  assert.match(out, /@testing-library\/react-native 11\.5\.0 is outside what lynkeus-headless supports \(>=12\.0\.0\)/);
  assert.ok(satisfies('13.3.3', '>=12.0.0') && satisfies('14.1.0', '^14.0.1') && !satisfies('12.9.0', '>=13 || ^14.0.0'));
});

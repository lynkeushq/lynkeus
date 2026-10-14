import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { init, mountAgent, setupChecks } from '../commands/init.js';
import { explainError } from '../knowledge/errors.js';

const tmpApp = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-init-'));
  fs.mkdirSync(path.join(root, 'app'));
  fs.writeFileSync(path.join(root, 'app', 'App.tsx'), 'export default () => null');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'demo' }));
  fs.writeFileSync(
    path.join(root, 'index.js'),
    "import { AppRegistry } from 'react-native'\nimport App from './app/App'\n\nAppRegistry.registerComponent('demo', () => App)\n",
  );
  return root;
};

test('init writes an entry that requires the app and refuses non-local backends', () => {
  const root = tmpApp();
  const notes = init(root, { entry: 'qa/headless.tsx', apiEnv: 'API_URL', auto: false, force: false });
  const entry = fs.readFileSync(path.join(root, 'qa/headless.tsx'), 'utf8');
  assert.match(entry, /require\('\.\.\/app\/App'\)/);
  assert.match(entry, /process\.env\.API_URL/);
  assert.match(entry, /installDefaultMocks/);
  assert.ok(notes.some((n) => n.includes('wrote qa/headless.tsx')));
  // Second run leaves it alone.
  const again = init(root, { entry: 'qa/headless.tsx', apiEnv: 'API_URL', auto: false, force: false });
  assert.ok(again.some((n) => n.includes('left as is')));
});

test('init --auto adds the mount after the imports, once', () => {
  const root = tmpApp();
  init(root, { entry: 'qa/headless.tsx', apiEnv: 'API_URL', auto: true, force: false });
  init(root, { entry: 'qa/headless.tsx', apiEnv: 'API_URL', auto: true, force: false });
  const index = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
  assert.equal(index.split('lynkeus-agent/auto').length, 2);
  assert.ok(index.indexOf('auto(') < index.indexOf('registerComponent'));
  assert.ok(index.indexOf("import App from './app/App'") < index.indexOf('lynkeus-agent/auto'));
});

test('the error catalog names the module behind a TurboModule crash', () => {
  const [e] = explainError(
    "Invariant Violation: TurboModuleRegistry.getEnforcing(...): 'RNCWebView' could not be found. Verify that a module by this name is registered",
  );
  assert.ok(e);
  assert.match(e.cause, /RNCWebView/);
  assert.equal(explainError('all good').length, 0);
});

test('an Expo Router app gets an entry that mounts the agent, then the router, and reads the token Expo lets through', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-expo-'));
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'demo', main: 'expo-router/entry', dependencies: { expo: '~57.0.0', 'expo-router': '~57.0.0' } }),
  );
  const notes = mountAgent(root);
  const index = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
  assert.match(index, /auto\(\{ token: process\.env\.EXPO_PUBLIC_LYNKEUS_TOKEN \}\)/);
  assert.ok(index.indexOf('lynkeus-agent/auto') < index.indexOf("import 'expo-router/entry'"));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.main, 'index.js');
  assert.equal(manifest.dependencies.expo, '~57.0.0');
  assert.ok(notes.some((n) => n.includes('not in Expo Go')));
  assert.ok(notes.some((n) => n.includes('EXPO_PUBLIC_LYNKEUS_TOKEN')));
  // The token is made once, kept out of git, and handed to Expo the only way it takes one.
  const token = fs.readFileSync(path.join(root, '.lynkeus', 'token'), 'utf8').trim();
  assert.match(token, /^[0-9a-f]{48}$/);
  assert.equal(fs.readFileSync(path.join(root, '.lynkeus', '.gitignore'), 'utf8'), 'token\n');
  assert.equal(fs.readFileSync(path.join(root, '.env.local'), 'utf8'), `EXPO_PUBLIC_LYNKEUS_TOKEN=${token}\n`);
  assert.ok(notes.some((n) => n.includes('made a token')));
  // A second run changes nothing.
  assert.ok(mountAgent(root).some((n) => n.includes('already mounts the agent')));
  assert.equal(fs.readFileSync(path.join(root, '.lynkeus', 'token'), 'utf8').trim(), token);
  assert.equal(fs.readFileSync(path.join(root, '.env.local'), 'utf8'), `EXPO_PUBLIC_LYNKEUS_TOKEN=${token}\n`);
  assert.equal(fs.readFileSync(path.join(root, 'index.js'), 'utf8'), index);
});

test('an Expo app with its own entry keeps it, and a bare React Native app reads LYNKEUS_TOKEN', () => {
  const expo = tmpApp();
  fs.writeFileSync(path.join(expo, 'package.json'), JSON.stringify({ name: 'demo', dependencies: { expo: '~57.0.0' } }));
  mountAgent(expo);
  assert.match(fs.readFileSync(path.join(expo, 'index.js'), 'utf8'), /EXPO_PUBLIC_LYNKEUS_TOKEN/);
  const bare = tmpApp();
  const notes = mountAgent(bare);
  assert.match(fs.readFileSync(path.join(bare, 'index.js'), 'utf8'), /auto\(\{ token: process\.env\.LYNKEUS_TOKEN \}\)/);
  assert.ok(!notes.some((n) => n.includes('Expo')));
  assert.ok(notes.some((n) => n.includes("add 'lynkeus-agent/babel' to the plugins")));
});

test('a bare React Native app gets the plugin that carries the token into the bundle', () => {
  const withPlugins = tmpApp();
  fs.writeFileSync(
    path.join(withPlugins, 'babel.config.js'),
    "module.exports = {\n  presets: ['module:@react-native/babel-preset'],\n  plugins: ['react-native-worklets/plugin'],\n};\n",
  );
  const notes = mountAgent(withPlugins);
  assert.match(fs.readFileSync(path.join(withPlugins, 'babel.config.js'), 'utf8'), /plugins: \['lynkeus-agent\/babel', 'react-native-worklets\/plugin'\]/);
  assert.ok(notes.some((n) => n.includes('added lynkeus-agent/babel to babel.config.js')));
  assert.ok(notes.some((n) => n.includes('--reset-cache')));

  const presetsOnly = tmpApp();
  fs.writeFileSync(path.join(presetsOnly, 'babel.config.js'), "module.exports = {\n  presets: ['module:@react-native/babel-preset'],\n};\n");
  mountAgent(presetsOnly);
  const config = fs.readFileSync(path.join(presetsOnly, 'babel.config.js'), 'utf8');
  assert.match(config, /^ {2}plugins: \['lynkeus-agent\/babel'\],\n {2}presets:/m);
  // A second run changes nothing.
  assert.ok(mountAgent(presetsOnly).some((n) => n.includes('already has lynkeus-agent/babel')));
  assert.equal(fs.readFileSync(path.join(presetsOnly, 'babel.config.js'), 'utf8'), config);
});

test('status names what a project lacks, and nothing once init has run', () => {
  const root = tmpApp();
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'demo', dependencies: { 'react-native': '0.83.0' } }));
  fs.writeFileSync(path.join(root, 'babel.config.js'), "module.exports = { presets: ['module:@react-native/babel-preset'] };\n");
  const before = setupChecks(root);
  assert.deepEqual(
    before.filter((c) => !c.ok).map((c) => c.what),
    ['lynkeus-agent is a dependency', 'the app mounts the agent', 'babel.config.js has lynkeus-agent/babel', 'the project has a token'],
  );
  assert.ok(before.every((c) => c.ok || c.fix));
  mountAgent(root);
  const after = setupChecks(root).filter((c) => !c.ok);
  assert.deepEqual(
    after.map((c) => c.what),
    ['lynkeus-agent is a dependency'],
  );
});

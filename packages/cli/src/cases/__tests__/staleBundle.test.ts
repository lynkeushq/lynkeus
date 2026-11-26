import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { fastsimBundleDir, staleBundleWarning } from '../staleBundle.js';

const at = (file: string, seconds: number, body = '') => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  fs.utimesSync(file, seconds, seconds);
};

const project = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-bundle-'));
  at(path.join(root, 'app', 'screens', 'Home.tsx'), 1000);
  at(path.join(root, '.lynkeus', 'fastsim-ios', 'app.hbc'), 2000);
  return root;
};

test('the bundle folder is read from a fastsim-run host command, quoted or not', () => {
  assert.equal(fastsimBundleDir('/kit/bin/fastsim-run .lynkeus/b {port}', '/app'), '/app/.lynkeus/b');
  assert.equal(fastsimBundleDir('"/k it/bin/fastsim-run" "/a b/c" {port}', '/app'), '/a b/c');
  assert.equal(fastsimBundleDir('lynkeus headless start', '/app'), undefined);
  assert.equal(fastsimBundleDir('$KIT/bin/fastsim-run $BUNDLE {port}', '/app'), undefined);
});

test('a bundle newer than every source says nothing', () => {
  const root = project();
  assert.equal(staleBundleWarning('fastsim-run .lynkeus/fastsim-ios {port}', root), undefined);
});

test('a source changed after the bundle names the file and the fix', () => {
  const root = project();
  at(path.join(root, 'app', 'screens', 'Login.tsx'), 3000);
  const warning = staleBundleWarning('fastsim-run .lynkeus/fastsim-ios {port}', root) ?? '';
  assert.match(warning, /older than app\/screens\/Login\.tsx/);
  assert.match(warning, /fastsim-bundle again/);
});

test('dependencies, native projects, tests and the cases folder do not count', () => {
  const root = project();
  at(path.join(root, 'node_modules', 'x', 'index.js'), 3000);
  at(path.join(root, 'ios', 'Pods', 'a.json'), 3000);
  at(path.join(root, 'app', 'Home.test.tsx'), 3000);
  at(path.join(root, 'cases', 'fixtures.mjs'), 3000);
  assert.equal(staleBundleWarning('fastsim-run .lynkeus/fastsim-ios {port}', root, [path.join(root, 'cases')]), undefined);
});

test('the app fastsim-bundle recorded is the one checked', () => {
  const root = project();
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-app-'));
  at(path.join(app, 'index.js'), 3000);
  fs.writeFileSync(path.join(root, '.lynkeus', 'fastsim-ios', 'bundle.json'), JSON.stringify({ app }));
  assert.match(staleBundleWarning('fastsim-run .lynkeus/fastsim-ios {port}', root) ?? '', /older than index\.js/);
});

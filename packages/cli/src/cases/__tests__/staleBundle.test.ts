import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { type Bundle, fastsimBundleDir, fastsimBundler, freshBundle, rebundleCommand, staleBundle } from '../staleBundle.js';

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

const RUN = 'fastsim-run .lynkeus/fastsim-ios {port}';

test('a bundle newer than every source says nothing', () => {
  const root = project();
  assert.equal(staleBundle(RUN, root), undefined);
});

test('a source changed after the bundle names the file', () => {
  const root = project();
  at(path.join(root, 'app', 'screens', 'Login.tsx'), 3000);
  const stale = staleBundle(RUN, root);
  assert.equal(stale?.newest, path.join('app', 'screens', 'Login.tsx'));
  assert.equal(stale?.app, root);
  assert.equal(stale?.platform, 'ios');
});

test('dependencies, native projects, tests and the cases folder do not count', () => {
  const root = project();
  at(path.join(root, 'node_modules', 'x', 'index.js'), 3000);
  at(path.join(root, 'ios', 'Pods', 'a.json'), 3000);
  at(path.join(root, 'app', 'Home.test.tsx'), 3000);
  at(path.join(root, 'cases', 'fixtures.mjs'), 3000);
  assert.equal(staleBundle(RUN, root, [path.join(root, 'cases')]), undefined);
});

test('the app and platform fastsim-bundle recorded are the ones checked', () => {
  const root = project();
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-app-'));
  at(path.join(app, 'index.js'), 3000);
  fs.writeFileSync(path.join(root, '.lynkeus', 'fastsim-ios', 'bundle.json'), JSON.stringify({ app, platform: 'android' }));
  const stale = staleBundle(RUN, root);
  assert.equal(stale?.newest, 'index.js');
  assert.equal(stale?.app, app);
  assert.equal(stale?.platform, 'android');
});

test('an older bundle with no bundle.json takes its platform from host.args', () => {
  const root = project();
  fs.writeFileSync(path.join(root, '.lynkeus', 'fastsim-ios', 'host.args'), '--bundle app.hbc --platform android\n');
  at(path.join(root, 'index.js'), 3000);
  assert.equal(staleBundle(RUN, root)?.platform, 'android');
});

const kit = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-kit-'));
  fs.mkdirSync(path.join(dir, 'bin'));
  for (const name of ['fastsim-run', 'fastsim-bundle']) fs.writeFileSync(path.join(dir, 'bin', name), '#!/bin/sh\n', { mode: 0o755 });
  return dir;
};

test("the bundler is the fastsim-bundle beside the command's fastsim-run, or on the PATH for a bare one", () => {
  const k = kit();
  assert.equal(fastsimBundler(`${k}/bin/fastsim-run b {port}`, '/app', ''), path.join(k, 'bin', 'fastsim-bundle'));
  assert.equal(fastsimBundler(`"${k}/bin/fastsim-run" "b c" {port}`, '/app', ''), path.join(k, 'bin', 'fastsim-bundle'));
  assert.equal(fastsimBundler('fastsim-run b {port}', '/app', path.join(k, 'bin')), path.join(k, 'bin', 'fastsim-bundle'));
  assert.equal(fastsimBundler('fastsim-run b {port}', '/app', ''), undefined);
  assert.equal(fastsimBundler('/nowhere/bin/fastsim-run b {port}', '/app', ''), undefined);
  assert.equal(fastsimBundler('$KIT/bin/fastsim-run b {port}', '/app', ''), undefined);
});

test('the command to bundle again is quoted for a shell', () => {
  assert.equal(
    rebundleCommand({ bundle: '/a b/out', app: '/app', platform: 'android', newest: 'x.ts' }, '/kit/bin/fastsim-bundle'),
    "/kit/bin/fastsim-bundle /app '/a b/out' android",
  );
  assert.match(
    rebundleCommand({ bundle: '/out', app: '/app', platform: 'ios', newest: 'x.ts' }, undefined),
    /^<FastSim folder>\/bin\/fastsim-bundle \/app \/out ios$/,
  );
});

test('a current bundle runs as it is, without bundling', async () => {
  const root = project();
  let called = false;
  const bundle: Bundle = async () => {
    called = true;
    return { code: 0, output: '' };
  };
  assert.deepEqual(await freshBundle(RUN, root, { bundle }), { ok: true });
  assert.equal(called, false);
});

test('a stale bundle is bundled again with the kit, for the recorded app and platform, and the run goes on', async () => {
  const root = project();
  const k = kit();
  at(path.join(root, 'app', 'screens', 'Login.tsx'), 3000);
  const lines: string[] = [];
  const seen: { bundler: string; args: string[]; cwd: string }[] = [];
  const bundle: Bundle = async (bundler, args, o) => {
    seen.push({ bundler, args, cwd: o.cwd });
    fs.utimesSync(path.join(root, '.lynkeus', 'fastsim-ios', 'app.hbc'), 4000, 4000);
    return { code: 0, output: 'bundled' };
  };
  const fresh = await freshBundle(`${k}/bin/fastsim-run .lynkeus/fastsim-ios {port}`, root, { bundle, log: (l) => lines.push(l) });
  assert.equal(fresh.ok, true);
  assert.match(fresh.ok ? (fresh.note ?? '') : '', /bundled .*fastsim-ios again in .* s: it was older than app\/screens\/Login\.tsx/);
  assert.deepEqual(seen, [{ bundler: path.join(k, 'bin', 'fastsim-bundle'), args: [root, path.join(root, '.lynkeus', 'fastsim-ios'), 'ios'], cwd: root }]);
  assert.match(lines[0] ?? '', /older than app\/screens\/Login\.tsx; bundling it again: .*fastsim-bundle/);
});

test('a stale bundle with no fastsim-bundle at hand refuses the run and gives the command', async () => {
  const root = project();
  at(path.join(root, 'index.js'), 3000);
  const fresh = await freshBundle('/nowhere/bin/fastsim-run .lynkeus/fastsim-ios {port}', root, { envPath: '' });
  assert.equal(fresh.ok, false);
  const text = fresh.ok ? '' : fresh.text;
  assert.match(text, /older than index\.js/);
  assert.match(text, new RegExp(`<FastSim folder>/bin/fastsim-bundle ${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} .*fastsim-ios ios`));
});

test('a bundling that fails refuses the run with its output and the command', async () => {
  const root = project();
  const k = kit();
  at(path.join(root, 'index.js'), 3000);
  const bundle: Bundle = async () => ({ code: 1, output: 'react-native bundle failed; its output is in out/bundle.log\n' });
  const fresh = await freshBundle(`${k}/bin/fastsim-run .lynkeus/fastsim-ios {port}`, root, { bundle });
  assert.equal(fresh.ok, false);
  const text = fresh.ok ? '' : fresh.text;
  assert.match(text, /bundling it again failed \(exit 1\)/);
  assert.match(text, /fastsim-bundle /);
  assert.match(text, /react-native bundle failed/);
});

test('a bundle still older after bundling is refused, not run', async () => {
  const root = project();
  const k = kit();
  at(path.join(root, 'index.js'), 3000);
  const bundle: Bundle = async () => ({ code: 0, output: '' });
  const fresh = await freshBundle(`${k}/bin/fastsim-run .lynkeus/fastsim-ios {port}`, root, { bundle });
  assert.equal(fresh.ok, false);
  assert.match(fresh.ok ? '' : fresh.text, /still older than index\.js/);
});

test('the real bundler runs and its exit code decides', async () => {
  const root = project();
  const k = kit();
  at(path.join(root, 'index.js'), 3000);
  fs.writeFileSync(path.join(k, 'bin', 'fastsim-bundle'), `#!/bin/sh\ntouch "$2/app.hbc"\necho "bundled $1 for $3"\n`, { mode: 0o755 });
  const fresh = await freshBundle(`${k}/bin/fastsim-run .lynkeus/fastsim-ios {port}`, root);
  assert.equal(fresh.ok, true, fresh.ok ? '' : fresh.text);
  fs.writeFileSync(path.join(k, 'bin', 'fastsim-bundle'), '#!/bin/sh\necho "no node_modules" >&2\nexit 2\n', { mode: 0o755 });
  at(path.join(root, 'index.js'), Date.now() / 1000 + 5);
  const failed = await freshBundle(`${k}/bin/fastsim-run .lynkeus/fastsim-ios {port}`, root);
  assert.match(failed.ok ? '' : failed.text, /exit 2[\s\S]*no node_modules/);
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { flutterChecks, flutterHeadlessCheck, startOrder } from '../commands/flutterStatus.js';

const PUBSPEC = (extra = '') => `name: shop_app\ndependencies:\n  flutter:\n    sdk: flutter\n${extra}`;

const project = (files: Record<string, string>): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-fstatus-'));
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
};

const fakeSdk = (version: string): string => {
  const sdk = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-sdk-'));
  fs.mkdirSync(path.join(sdk, 'bin', 'cache'), { recursive: true });
  fs.writeFileSync(path.join(sdk, 'bin', 'flutter'), '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(sdk, 'bin', 'cache', 'flutter.version.json'), JSON.stringify({ frameworkVersion: version }));
  return sdk;
};

const setEnv = (env: Record<string, string | undefined>) => {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
};

const withEnv = <T>(env: Record<string, string | undefined>, run: () => T): T => {
  const before = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  setEnv(env);
  try {
    return run();
  } finally {
    setEnv(before);
  }
};

const byWhat = (checks: ReturnType<typeof flutterChecks>, pattern: RegExp) => checks.find((c) => pattern.test(c.what));

test('a set up Flutter project passes every check and names the Flutter version', () => {
  const root = project({
    'pubspec.yaml': PUBSPEC('  lynkeus_agent:\n    path: ../agent\n'),
    'lib/main.dart': 'void main() {\n  LynkeusAgent.start();\n  runApp(A());\n}\n',
    '.lynkeus/token': 'abc\n',
    '.lynkeus/.gitignore': 'token\n',
  });
  const checks = withEnv({ LYNKEUS_TOKEN: undefined, FLUTTER_ROOT: fakeSdk('3.50.1') }, () => flutterChecks(root));
  assert.ok(
    checks.every((c) => c.ok),
    JSON.stringify(checks),
  );
  assert.match(byWhat(checks, /Flutter is found/)!.what, /3\.50\.1/);
  assert.ok(!checks.some((c) => /babel|metro/i.test(c.what + (c.fix ?? ''))));
});

test('a bare Flutter project fails each check with its fix', () => {
  const root = project({ 'pubspec.yaml': PUBSPEC(), 'lib/main.dart': 'void main() => runApp(A());\n' });
  const checks = withEnv({ LYNKEUS_TOKEN: undefined, FLUTTER_ROOT: '/nonexistent', PATH: '/nonexistent' }, () => flutterChecks(root));
  const failed = checks.filter((c) => !c.ok);
  assert.deepEqual(
    failed.map((c) => c.what.replace(/^.*pubspec.yaml depends/, 'pubspec')),
    ['pubspec on lynkeus_agent', 'lib/main.dart starts the agent', 'the project has a token', 'Flutter is found'],
  );
  assert.ok(failed.every((c) => c.fix));
  assert.match(byWhat(checks, /pubspec/)!.fix!, /lynkeus init/);
  assert.match(byWhat(checks, /Flutter is found/)!.fix!, /FLUTTER_ROOT/);
});

test('a token that git would commit is flagged, and so is a missing main.dart', () => {
  const root = project({ 'pubspec.yaml': PUBSPEC(), '.lynkeus/token': 'abc\n' });
  const checks = withEnv({ LYNKEUS_TOKEN: undefined, FLUTTER_ROOT: fakeSdk('3.50.1') }, () => flutterChecks(root));
  assert.equal(byWhat(checks, /kept out of git/)!.ok, false);
  assert.match(byWhat(checks, /main\.dart/)!.fix!, /no lib\/main\.dart/);
});

test('headless is hosted when lynkeus_headless is a dependency', () => {
  assert.equal(flutterHeadlessCheck(project({ 'pubspec.yaml': PUBSPEC() })).ok, false);
  assert.equal(flutterHeadlessCheck(project({ 'pubspec.yaml': PUBSPEC('  lynkeus_headless:\n    path: ../h\n') })).ok, true);
});

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'lib', 'cli.js');
const status = (root: string) =>
  spawnSync('node', [cli, 'status', '--offline', '--root', root], { encoding: 'utf8', env: { ...process.env, LYNKEUS_TOKEN: '' } }).stdout;

test('`lynkeus status` reads a Flutter project as Flutter and a React Native one as before', () => {
  const flutter = status(project({ 'pubspec.yaml': PUBSPEC() }));
  assert.match(flutter, /depends on lynkeus_agent/);
  assert.doesNotMatch(flutter, /package\.json|babel/i);
  const rn = status(project({ 'package.json': JSON.stringify({ name: 'demo', dependencies: { 'react-native': '0.80.0' } }) }));
  assert.match(rn, /lynkeus-agent is a dependency/);
  assert.match(rn, /babel\.config\.js has lynkeus-agent\/babel/);
  assert.doesNotMatch(rn, /pubspec/);
});

test('the agent must start before ensureInitialized(): a pass, a fail with the line to move, and no check without a binding call', () => {
  const run = (main: string) =>
    withEnv({ LYNKEUS_TOKEN: undefined, FLUTTER_ROOT: fakeSdk('3.50.1') }, () =>
      byWhat(flutterChecks(project({ 'pubspec.yaml': PUBSPEC('  lynkeus_agent:\n    path: x\n'), 'lib/main.dart': main })), /before the binding/),
    );
  const good = run('void main() async {\n  LynkeusAgent.start();\n  WidgetsFlutterBinding.ensureInitialized();\n  runApp(A());\n}\n');
  assert.equal(good?.ok, true);
  const bad = run('void main() async {\n  WidgetsFlutterBinding.ensureInitialized();\n  LynkeusAgent.start();\n  runApp(A());\n}\n');
  assert.equal(bad?.ok, false);
  assert.match(bad!.fix!, /line 3\) above WidgetsFlutterBinding\.ensureInitialized\(\) \(line 2\)/);
  assert.match(bad!.fix!, /FastSim/);
  assert.equal(run('void main() {\n  LynkeusAgent.start();\n  runApp(A());\n}\n'), undefined);
  assert.equal(startOrder('// ensureInitialized() later\nvoid main() {\n  LynkeusAgent.start();\n  ensureInitialized();\n}\n')?.ok, true);
});

test('the companion check follows pubspec.lock: needed and missing fails with the plugin and its failure, set up passes, not needed adds nothing', () => {
  const lock = (packages: string[]) =>
    `packages:\n${packages.map((name) => `  ${name}:\n    dependency: transitive\n    source: hosted\n    version: "2.4.1"\n`).join('')}sdks:\n  dart: ">=3.8.0 <4.0.0"\n`;
  const run = (packages: string[], extra: string, main: string) =>
    withEnv({ LYNKEUS_TOKEN: undefined, FLUTTER_ROOT: fakeSdk('3.50.1') }, () =>
      flutterChecks(project({ 'pubspec.yaml': PUBSPEC(`  lynkeus_agent:\n    path: x\n${extra}`), 'lib/main.dart': main, 'pubspec.lock': lock(packages) })),
    );
  const started = 'void main() {\n  LynkeusAgent.start();\n  runApp(A());\n}\n';
  const missing = byWhat(run(['sqflite_platform_interface'], '', started), /lynkeus_plugins is set up/);
  assert.equal(missing?.ok, false);
  assert.match(missing!.fix!, /databaseFactory not initialized/);
  assert.match(missing!.fix!, /LynkeusPlugins\.ensureInitialized\(\)/);
  const ready = 'void main() {\n  LynkeusAgent.start();\n  LynkeusPlugins.ensureInitialized();\n  runApp(A());\n}\n';
  assert.equal(byWhat(run(['sqflite_platform_interface'], '  lynkeus_plugins:\n    path: y\n', ready), /lynkeus_plugins is set up/)?.ok, true);
  const early = 'void main() {\n  LynkeusPlugins.ensureInitialized();\n  LynkeusAgent.start();\n  runApp(A());\n}\n';
  assert.equal(byWhat(run(['sqflite_platform_interface'], '  lynkeus_plugins:\n    path: y\n', early), /lynkeus_plugins is set up/)?.ok, false);
  assert.equal(byWhat(run(['http'], '', started), /lynkeus_plugins/), undefined);
  const view = byWhat(run(['webview_flutter'], '', started), /native view/);
  assert.equal(view?.ok, true);
});

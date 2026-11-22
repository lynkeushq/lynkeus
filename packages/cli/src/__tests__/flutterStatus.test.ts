import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { flutterChecks, flutterHeadlessCheck } from '../commands/flutterStatus.js';

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

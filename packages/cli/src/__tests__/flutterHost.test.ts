import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { findFlutter, flutterHostEnv, flutterHostTest, flutterNetworkEnv, flutterProject, writeFlutterHost } from '../commands/flutterHost.js';
import { hostedHeadless } from '../device/agentVersion.js';

const project = (pubspec: string | undefined, extra: Record<string, string> = {}): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-flutter-'));
  if (pubspec !== undefined) fs.writeFileSync(path.join(root, 'pubspec.yaml'), pubspec);
  for (const [file, text] of Object.entries(extra)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
};

const APP = `name: shop_app
description: "A shop."
publish_to: 'none'

dependencies:
  flutter:
    sdk: flutter
  material_ui: ^1.11.0

dev_dependencies:
  flutter_test:
    sdk: flutter
  lynkeus_headless:
    path: ../lynkeus_headless
`;

test('a pubspec that takes flutter from the SDK is a Flutter app, hosted when it depends on lynkeus_headless', () => {
  assert.deepEqual(flutterProject(project(APP)), { name: 'shop_app', hosted: true });
  assert.deepEqual(flutterProject(project(APP.replace(/ {2}lynkeus_headless:\n {4}path: \.\.\/lynkeus_headless\n/, ''))), {
    name: 'shop_app',
    hosted: false,
  });
});

test('a React Native app, a pure Dart package or no pubspec is not a Flutter app', () => {
  assert.equal(flutterProject(project(undefined, { 'package.json': '{"name":"rn"}' })), undefined);
  assert.equal(flutterProject(project('name: tool\ndependencies:\n  path: ^1.9.0\n')), undefined);
  // `flutter` named somewhere other than as the SDK dependency does not count.
  assert.equal(flutterProject(project('name: x\ndependencies:\n  flutter_lints: ^6.0.0\nflutter:\n  uses-material-design: true\n')), undefined);
});

test('a Flutter pubspec beside a React Native package.json is the React Native app, as init decides', () => {
  const rn = (deps: string) => ({ 'package.json': `{"name":"rn","${deps}":{"react-native":"0.80.0"}}` });
  assert.equal(flutterProject(project(APP, rn('dependencies'))), undefined);
  assert.equal(flutterProject(project(APP, rn('devDependencies'))), undefined);
  assert.deepEqual(flutterProject(project(APP, { 'package.json': '{"name":"tools","devDependencies":{"prettier":"3"}}' })), {
    name: 'shop_app',
    hosted: true,
  });
});

test('the host file goes under .lynkeus, one per port, and git ignores it', () => {
  const root = project(APP, { 'lib/main.dart': 'void main() {}\n' });
  const file = writeFlutterHost(root, { name: 'shop_app', hosted: true }, 'lib/main.dart', 8140);
  assert.equal(path.relative(root, file), path.join('.lynkeus', 'host', 'lynkeus_host_8140_test.dart'));
  assert.match(fs.readFileSync(file, 'utf8'), /import 'package:shop_app\/main\.dart' as app;/);
  assert.match(fs.readFileSync(path.join(root, '.lynkeus', '.gitignore'), 'utf8'), /^host\/$/m);
  writeFlutterHost(root, { name: 'shop_app', hosted: true }, 'lib/main.dart', undefined);
  assert.equal(fs.readFileSync(path.join(root, '.lynkeus', '.gitignore'), 'utf8').match(/host\//g)?.length, 1);
  assert.match(flutterHostTest({ name: 'a', hosted: true }, 'lib/app/main_dev.dart'), /package:a\/app\/main_dev\.dart/);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /configureHost/);
});

test("a project's own stand-ins in test/lynkeus_host.dart are passed to the host", () => {
  const root = project(APP, { 'lib/main.dart': 'void main() {}\n', 'test/lynkeus_host.dart': 'void configureHost(Object host) {}\n' });
  const text = fs.readFileSync(writeFlutterHost(root, { name: 'shop_app', hosted: true }, 'lib/main.dart', undefined), 'utf8');
  assert.match(text, /import '\.\.\/\.\.\/test\/lynkeus_host\.dart' as project;/);
  assert.match(text, /configure: project\.configureHost/);
});

test('a plugin with no channel default that the lock shows is registered for the platform the host plays', () => {
  const lock = 'packages:\n  flutter_local_notifications:\n    dependency: "direct main"\n    version: "23.0.2"\n';
  const root = project(APP, { 'lib/main.dart': 'void main() {}\n', 'pubspec.lock': lock });
  const text = fs.readFileSync(writeFlutterHost(root, { name: 'shop_app', hosted: true }, 'lib/main.dart', undefined), 'utf8');
  assert.match(text, /^import 'package:flutter_local_notifications\/flutter_local_notifications\.dart' as flutter_local_notifications;$/m);
  assert.match(text, /registerPlugins: _registerPlugins\);/);
  assert.match(text, /flutter_local_notifications\.AndroidFlutterLocalNotificationsPlugin\.registerWith\(\);/);
  assert.match(text, /flutter_local_notifications\.IOSFlutterLocalNotificationsPlugin\.registerWith\(\);/);
  const work = 'packages:\n  workmanager:\n    version: "0.10.10"\n  workmanager_android:\n    version: "0.10.9"\n  workmanager_apple:\n    version: "0.9.11"\n';
  const scheduled = fs.readFileSync(
    writeFlutterHost(project(APP, { 'lib/main.dart': 'void main() {}\n', 'pubspec.lock': work }), { name: 'shop_app', hosted: true }, 'lib/main.dart', undefined),
    'utf8',
  );
  assert.match(scheduled, /^import 'package:workmanager_android\/workmanager_android\.dart' as workmanager_android;$/m);
  assert.match(scheduled, /workmanager_android\.WorkmanagerAndroid\.registerWith\(\);/);
  assert.match(scheduled, /workmanager_apple\.WorkmanagerApple\.registerWith\(\);/);
  const plain = project(APP, { 'lib/main.dart': 'void main() {}\n', 'pubspec.lock': 'packages:\n  http:\n    version: "1.2.0"\n' });
  assert.doesNotMatch(fs.readFileSync(writeFlutterHost(plain, { name: 'shop_app', hosted: true }, 'lib/main.dart', undefined), 'utf8'), /registerPlugins/);
});

test('finds the SDK from FLUTTER_ROOT, and hands the host its fonts and port', () => {
  const sdk = project(undefined, { 'bin/flutter': '#!/bin/sh\n' });
  fs.chmodSync(path.join(sdk, 'bin', 'flutter'), 0o755);
  const found = findFlutter(sdk, { FLUTTER_ROOT: sdk, PATH: '' });
  assert.equal(found?.root, fs.realpathSync(sdk));
  const env = flutterHostEnv(found!, 'tok', undefined, { networkHosts: ['127.0.0.1', 'api.local'] });
  assert.equal(env.LYNKEUS_PORT, '8123');
  assert.equal(env.LYNKEUS_NETWORK_HOSTS, '127.0.0.1,api.local');
  assert.equal(env.LYNKEUS_FONTS, path.join(fs.realpathSync(sdk), 'bin', 'cache', 'artifacts', 'material_fonts'));
});

test('a Flutter host counts as headless, as the jest host does', () => {
  assert.equal(hostedHeadless({ app: { runtime: 'flutter-headless' } }), true);
  assert.equal(hostedHeadless({ app: { runtime: 'headless' } }), true);
  assert.equal(hostedHeadless({ app: { runtime: 'flutter' } }), false);
  assert.equal(hostedHeadless(null), false);
});

test("a FastSim host command gets the project's network hosts, and nothing when the config names none", () => {
  assert.deepEqual(flutterNetworkEnv({ networkHosts: ['127.0.0.1', 'api.local'] }), { LYNKEUS_NETWORK_HOSTS: '127.0.0.1,api.local' });
  assert.deepEqual(flutterNetworkEnv({ networkHosts: [] }), {});
  assert.deepEqual(flutterNetworkEnv(undefined), {});
});

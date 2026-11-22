import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { addAgentToMain, addAgentToPubspec, AGENT_DEPENDENCY, detectRuntime, isFlutterPubspec, setupApp } from '../commands/initFlutter.js';

const PUBSPEC = `name: demo
description: A demo.
# keep this
version: 1.0.0+1

environment:
  sdk: ^3.8.0

dependencies:
  # the framework
  flutter:
    sdk: flutter
  cupertino_icons: ^1.0.8

dev_dependencies:
  flutter_test:
    sdk: flutter
`;

const tmp = (files: Record<string, string>) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-flutter-'));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  }
  return root;
};

test('a Flutter pubspec is one whose dependencies include flutter', () => {
  assert.ok(isFlutterPubspec(PUBSPEC));
  assert.ok(isFlutterPubspec('name: a\ndependencies:\n  flutter: { sdk: flutter }\n'));
  assert.ok(!isFlutterPubspec('name: a\ndependencies:\n  http: ^1.0.0\n'));
  // Only dev_dependencies does not make an app.
  assert.ok(!isFlutterPubspec('name: a\ndev_dependencies:\n  flutter:\n    sdk: flutter\n'));
  assert.ok(!isFlutterPubspec('name: a\n'));
});

test('the dependency goes under dependencies and everything else stays byte for byte', () => {
  const edit = addAgentToPubspec(PUBSPEC);
  assert.ok(edit.done);
  const lines = edit.text.split('\n');
  const at = lines.indexOf('dependencies:');
  assert.deepEqual(
    lines.slice(at + 1, at + 1 + AGENT_DEPENDENCY.length),
    AGENT_DEPENDENCY.map((l) => `  ${l}`).map((l) => l),
  );
  assert.equal(edit.text.replace(AGENT_DEPENDENCY.map((l) => `  ${l}\n`).join(''), ''), PUBSPEC);
});

test('the pubspec edit follows the file’s indentation and line endings, whatever section comes first', () => {
  const text = 'name: a\r\ndev_dependencies:\r\n  flutter_test:\r\n    sdk: flutter\r\n\r\ndependencies:\r\n    flutter:\r\n        sdk: flutter\r\n';
  const edit = addAgentToPubspec(text);
  assert.ok(edit.done);
  assert.ok(edit.text.includes('dependencies:\r\n    lynkeus_agent:\r\n      git:\r\n'));
  assert.ok(!/[^\r]\n/.test(edit.text));
  // dev_dependencies is left alone.
  assert.ok(edit.text.startsWith('name: a\r\ndev_dependencies:\r\n  flutter_test:'));
});

test('a pubspec that already has the agent, or no dependencies, is not guessed at', () => {
  const had = addAgentToPubspec(PUBSPEC.replace('  cupertino_icons', '  lynkeus_agent:\n    path: ../agent\n  cupertino_icons'));
  assert.ok(had.done);
  assert.match(had.note, /already/);
  assert.ok(!had.text.includes('git:'));
  const none = addAgentToPubspec('name: a\n');
  assert.ok(!none.done);
  assert.match(none.note, /add this under dependencies/);
});

test('main.dart: an arrow main becomes a block that starts the agent first', () => {
  const src = "import 'package:flutter/material.dart';\n\nvoid main() => runApp(const MyApp(title: 'a (b)'));\n\nclass MyApp {}\n";
  const edit = addAgentToMain(src);
  assert.ok(edit.done);
  assert.equal(
    edit.text,
    "import 'package:flutter/material.dart';\nimport 'package:lynkeus_agent/lynkeus_agent.dart';\n\nvoid main() {\n  LynkeusAgent.start();\n  runApp(const MyApp(title: 'a (b)'));\n}\n\nclass MyApp {}\n",
  );
});

test('main.dart: a block main gets the call right before runApp, after ensureInitialized', () => {
  const src =
    "import 'package:flutter/widgets.dart';\nimport 'app.dart';\n\nvoid main() async {\n  WidgetsFlutterBinding.ensureInitialized();\n  await setup();\n  runApp(\n    const App(),\n  );\n}\n";
  const edit = addAgentToMain(src);
  assert.ok(edit.done);
  assert.ok(edit.text.includes("import 'app.dart';\nimport 'package:lynkeus_agent/lynkeus_agent.dart';\n"));
  assert.ok(edit.text.includes('  await setup();\n  LynkeusAgent.start();\n  runApp(\n'));
});

test('main.dart: multi-line imports and a file with no imports', () => {
  const multi = addAgentToMain("import 'a.dart'\n    show A;\n\nvoid main() {\n  runApp(A());\n}\n");
  assert.ok(multi.text.includes("    show A;\nimport 'package:lynkeus_agent/lynkeus_agent.dart';\n"));
  const bare = addAgentToMain('void main() {\n  runApp(A());\n}\n');
  assert.ok(bare.text.startsWith("import 'package:lynkeus_agent/lynkeus_agent.dart';\n\nvoid main()"));
});

test('main.dart: already started is left alone; no recognizable runApp prints the lines', () => {
  const started = "import 'package:lynkeus_agent/lynkeus_agent.dart';\nvoid main() {\n  LynkeusAgent.start();\n  runApp(A());\n}\n";
  const same = addAgentToMain(started);
  assert.equal(same.text, started);
  assert.ok(same.done);
  for (const src of ['void main() {\n  runZonedGuarded(() => runApp(A()), (e, s) {});\n}\n', 'void main() {}\n']) {
    const edit = addAgentToMain(src);
    assert.ok(!edit.done);
    assert.equal(edit.text, src);
    assert.match(edit.note, /import 'package:lynkeus_agent\/lynkeus_agent.dart';/);
    assert.match(edit.note, /LynkeusAgent\.start\(\);/);
  }
});

test('runtime detection: Flutter by pubspec, React Native wins a mixed folder unless asked', () => {
  const flutter = tmp({ 'pubspec.yaml': PUBSPEC });
  const mixed = tmp({ 'pubspec.yaml': PUBSPEC, 'package.json': JSON.stringify({ dependencies: { 'react-native': '0.80.0' } }) });
  const rn = tmp({ 'package.json': JSON.stringify({ dependencies: { 'react-native': '0.80.0' } }) });
  assert.equal(detectRuntime(flutter), 'flutter');
  assert.equal(detectRuntime(mixed), 'react-native');
  assert.equal(detectRuntime(mixed, 'flutter'), 'flutter');
  assert.equal(detectRuntime(flutter, 'react-native'), 'react-native');
  assert.equal(detectRuntime(rn), 'react-native');
  assert.throws(() => detectRuntime(rn, 'flutter'), /needs a pubspec/);
  assert.throws(() => detectRuntime(rn, 'dart'), /react-native or flutter/);
});

test('flutter init edits, makes the token, ignores it, and a second run changes nothing', () => {
  const root = tmp({ 'pubspec.yaml': PUBSPEC, 'lib/main.dart': "import 'package:flutter/material.dart';\n\nvoid main() => runApp(const MaterialApp());\n" });
  const env = process.env.LYNKEUS_TOKEN;
  delete process.env.LYNKEUS_TOKEN;
  try {
    const notes = setupApp(root, { install: true });
    assert.ok(notes.some((n) => n.includes('added lynkeus_agent to pubspec.yaml')));
    assert.ok(notes.some((n) => n.includes('.lynkeus/token')));
    assert.ok(notes.some((n) => n.includes('--dart-define=LYNKEUS_TOKEN=$(cat .lynkeus/token)')));
    assert.ok(!notes.join('\n').match(/metro|babel/i));
    assert.match(fs.readFileSync(path.join(root, '.lynkeus/token'), 'utf8'), /^[0-9a-f]{48}\n$/);
    assert.ok(fs.readFileSync(path.join(root, '.lynkeus/.gitignore'), 'utf8').split('\n').includes('token'));
    const snapshot = ['pubspec.yaml', 'lib/main.dart', '.lynkeus/token', '.lynkeus/.gitignore'].map((f) => fs.readFileSync(path.join(root, f), 'utf8'));
    const again = setupApp(root, { install: true });
    assert.ok(again.some((n) => n.includes('already depends')));
    assert.ok(again.some((n) => n.includes('already starts')));
    assert.ok(!again.some((n) => n.includes('made a token')));
    assert.deepEqual(
      ['pubspec.yaml', 'lib/main.dart', '.lynkeus/token', '.lynkeus/.gitignore'].map((f) => fs.readFileSync(path.join(root, f), 'utf8')),
      snapshot,
    );
  } finally {
    if (env !== undefined) process.env.LYNKEUS_TOKEN = env;
  }
});

test('flutter init with --no-install leaves pubspec.yaml alone; a missing main.dart prints the lines', () => {
  const root = tmp({ 'pubspec.yaml': PUBSPEC });
  const notes = setupApp(root, { install: false });
  assert.equal(fs.readFileSync(path.join(root, 'pubspec.yaml'), 'utf8'), PUBSPEC);
  assert.ok(notes.some((n) => n.includes('no lib/main.dart')));
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { lockedVersions, pluginsNeeded } from '../commands/flutterPlugins.js';
import {
  addAgentToMain,
  addAgentToPubspec,
  addHeadlessToPubspec,
  addPluginsToMain,
  addPluginsToPubspec,
  AGENT_DEPENDENCY,
  detectRuntime,
  isFlutterPubspec,
  pluginsDependencyLike,
  pubspecName,
  setupApp,
} from '../commands/initFlutter.js';

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

test('main.dart: a plain block main gets the call right before runApp', () => {
  const edit = addAgentToMain("import 'package:flutter/widgets.dart';\n\nvoid main() {\n  setup();\n  runApp(\n    const App(),\n  );\n}\n");
  assert.ok(edit.done);
  assert.ok(edit.text.includes('  setup();\n  LynkeusAgent.start();\n  runApp(\n'));
});

test('main.dart: the agent starts before the first ensureInitialized(), in the same block', () => {
  const async = addAgentToMain(
    "import 'package:flutter/widgets.dart';\nimport 'app.dart';\n\nvoid main() async {\n  WidgetsFlutterBinding.ensureInitialized();\n  await setup();\n  runApp(const App());\n}\n",
  );
  assert.ok(async.done);
  assert.ok(async.text.includes('void main() async {\n  LynkeusAgent.start();\n  WidgetsFlutterBinding.ensureInitialized();\n  await setup();\n'));
  assert.ok(async.text.includes("import 'package:flutter/widgets.dart';\nimport 'package:lynkeus_agent/lynkeus_agent.dart';\nimport 'app.dart';\n"));
  const zone = addAgentToMain(
    'void main() {\n  runZonedGuarded(() async {\n    WidgetsFlutterBinding.ensureInitialized();\n    await setup();\n    runApp(const App());\n  }, (e, s) {});\n}\n',
  );
  assert.ok(zone.text.includes('  runZonedGuarded(() async {\n    LynkeusAgent.start();\n    WidgetsFlutterBinding.ensureInitialized();\n'));
  const closure = addAgentToMain(
    'void main() {\n  handleError(() async {\n    // ensureInitialized() comes next\n    final binding = WidgetsFlutterBinding.ensureInitialized();\n    runApp(const App());\n  });\n}\n',
  );
  assert.ok(
    closure.text.includes(
      '  handleError(() async {\n    // ensureInitialized() comes next\n    LynkeusAgent.start();\n    final binding = WidgetsFlutterBinding',
    ),
  );
});

test('main.dart: a start() already before ensureInitialized() is left alone; one after it is reported, not moved', () => {
  const right = 'void main() async {\n  LynkeusAgent.start();\n  WidgetsFlutterBinding.ensureInitialized();\n  runApp(A());\n}\n';
  assert.equal(addAgentToMain(right).text, right);
  assert.ok(addAgentToMain(right).done);
  const wrong = 'void main() async {\n  WidgetsFlutterBinding.ensureInitialized();\n  LynkeusAgent.start();\n  runApp(A());\n}\n';
  const edit = addAgentToMain(wrong);
  assert.equal(edit.text, wrong);
  assert.ok(!edit.done);
  assert.match(edit.note, /move the LynkeusAgent\.start\(\.\.\.\) line above it/);
  assert.match(edit.note, /FastSim/);
});

test('main.dart: the import lands in its sorted place among the package imports', () => {
  const sorted = addAgentToMain(
    "import 'dart:async';\nimport 'package:flutter/material.dart';\nimport 'package:lynkeus_core/x.dart';\nimport 'package:provider/provider.dart';\nimport 'app.dart';\n\nvoid main() {\n  runApp(A());\n}\n",
  );
  assert.ok(
    sorted.text.startsWith(
      "import 'dart:async';\nimport 'package:flutter/material.dart';\nimport 'package:lynkeus_agent/lynkeus_agent.dart';\nimport 'package:lynkeus_core/x.dart';\n",
    ),
  );
  const last = addAgentToMain("import 'package:flutter/material.dart';\nimport 'app.dart';\n\nvoid main() {\n  runApp(A());\n}\n");
  assert.ok(last.text.startsWith("import 'package:flutter/material.dart';\nimport 'package:lynkeus_agent/lynkeus_agent.dart';\nimport 'app.dart';\n"));
  const multi = addAgentToMain("import 'package:a/a.dart'\n    show A;\n\nvoid main() {\n  runApp(A());\n}\n");
  assert.ok(multi.text.includes("    show A;\nimport 'package:lynkeus_agent/lynkeus_agent.dart';\n"));
});

test('main.dart: dart-only, relative-only and no imports', () => {
  const dart = addAgentToMain("import 'dart:async';\n\nvoid main() {\n  runApp(A());\n}\n");
  assert.ok(dart.text.startsWith("import 'dart:async';\n\nimport 'package:lynkeus_agent/lynkeus_agent.dart';\n"));
  const relative = addAgentToMain("import 'app.dart';\n\nvoid main() {\n  runApp(A());\n}\n");
  assert.ok(relative.text.startsWith("import 'package:lynkeus_agent/lynkeus_agent.dart';\n\nimport 'app.dart';\n"));
  const bare = addAgentToMain('void main() {\n  runApp(A());\n}\n');
  assert.ok(bare.text.startsWith("import 'package:lynkeus_agent/lynkeus_agent.dart';\n\nvoid main()"));
});

test('main.dart: the app name from the pubspec goes into start()', () => {
  const edit = addAgentToMain('void main() => runApp(A());\n', 'shop_app');
  assert.ok(edit.text.includes("  LynkeusAgent.start(app: {'name': 'shop_app'});\n  runApp(A());"));
  assert.match(addAgentToMain('void main() {}\n', 'shop_app').note, /LynkeusAgent\.start\(app: \{'name': 'shop_app'\}\);/);
  assert.equal(pubspecName(PUBSPEC), 'demo');
  assert.equal(pubspecName("name: 'quoted_app' # comment\n"), 'quoted_app');
});

test('the headless dependency goes in dev_dependencies, whatever is in it', () => {
  const plain = addHeadlessToPubspec(PUBSPEC);
  assert.ok(plain.text.includes('dev_dependencies:\n  lynkeus_headless:\n    git:\n'));
  assert.ok(plain.text.includes('path: flutter/lynkeus_headless'));
  const commented = addHeadlessToPubspec(
    'name: a\ndependencies:\n  flutter:\n    sdk: flutter\n\ndev_dependencies:\n  # tests\n  # more\n  flutter_test:\n    sdk: flutter\n',
  );
  assert.ok(commented.done);
  assert.ok(commented.text.includes('dev_dependencies:\n  lynkeus_headless:'));
  const onlyComments = addHeadlessToPubspec(
    'name: a\ndependencies:\n  flutter:\n    sdk: flutter\ndev_dependencies:   # none yet\n  # nothing\n\nflutter:\n  uses-material-design: true\n',
  );
  assert.ok(onlyComments.done);
  assert.ok(onlyComments.text.includes('dev_dependencies:   # none yet\n  lynkeus_headless:'));
  assert.ok(onlyComments.text.includes('\nflutter:\n  uses-material-design: true\n'));
  const missing = addHeadlessToPubspec('name: a\ndependencies:\n  flutter:\n    sdk: flutter\n');
  assert.ok(missing.done);
  assert.ok(
    missing.text.endsWith(
      '\n\ndev_dependencies:\n  lynkeus_headless:\n    git:\n      url: https://github.com/lynkeushq/lynkeus.git\n      path: flutter/lynkeus_headless\n',
    ),
  );
  const had = addHeadlessToPubspec(`${PUBSPEC}  lynkeus_headless:\n    path: ../h\n`);
  assert.match(had.note, /already depends/);
});

test('init --headless adds lynkeus_headless, names the app, and notes the git dependency', () => {
  const root = tmp({ 'pubspec.yaml': PUBSPEC, 'lib/main.dart': 'void main() => runApp(A());\n' });
  const notes = setupApp(root, { install: true, headless: true });
  const pubspec = fs.readFileSync(path.join(root, 'pubspec.yaml'), 'utf8');
  assert.ok(pubspec.includes('lynkeus_headless:'));
  assert.ok(fs.readFileSync(path.join(root, 'lib/main.dart'), 'utf8').includes("LynkeusAgent.start(app: {'name': 'demo'});"));
  const text = notes.join('\n');
  assert.match(text, /lynkeus case run --host/);
  assert.match(text, /FLUTTER_ROOT/);
  assert.match(text, /dependency_overrides:\n\s+lynkeus_agent:\n\s+path: /);
  const plain = setupApp(tmp({ 'pubspec.yaml': PUBSPEC, 'lib/main.dart': 'void main() => runApp(A());\n' }), { install: true });
  assert.ok(!plain.join('\n').includes('case run --host'));
  const again = setupApp(root, { install: true, headless: true });
  assert.equal(fs.readFileSync(path.join(root, 'pubspec.yaml'), 'utf8'), pubspec);
  assert.ok(again.some((n) => n.includes('already depends on lynkeus_headless')));
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

const LOCK = (packages: Record<string, string>) =>
  `packages:\n${Object.entries(packages)
    .map(([name, version]) => `  ${name}:\n    dependency: transitive\n    description:\n      name: ${name}\n    source: hosted\n    version: "${version}"\n`)
    .join('')}sdks:\n  dart: ">=3.8.0 <4.0.0"\n`;

test('the lock says which plugins need the companion', () => {
  assert.equal(lockedVersions(LOCK({ a: '1.0.0', b: '2.1.0' })).get('b'), '2.1.0');
  const need = (packages: Record<string, string> | undefined) => pluginsNeeded(tmp(packages ? { 'pubspec.lock': LOCK(packages) } : {})).map((n) => n.package);
  assert.deepEqual(need({ sqflite_platform_interface: '2.4.1' }), ['sqflite_platform_interface 2.4.1']);
  assert.deepEqual(need({ shared_preferences_platform_interface: '2.4.0' }), ['shared_preferences_platform_interface 2.4.0']);
  assert.deepEqual(need({ shared_preferences_platform_interface: '2.3.2' }), []);
  assert.deepEqual(need({ shared_preferences_platform_interface: '2.10.0' }), ['shared_preferences_platform_interface 2.10.0']);
  assert.deepEqual(need({ http: '1.0.0' }), []);
  assert.deepEqual(need(undefined), []);
});

const withDeps = (extra: string) => PUBSPEC.replace('dependencies:\n', `dependencies:\n${extra}`);

test('the companion goes where lynkeus_agent comes from', () => {
  assert.deepEqual(pluginsDependencyLike(withDeps('  lynkeus_agent:\n    path: ../lynkeus/flutter/lynkeus_agent\n')), [
    'lynkeus_plugins:',
    '  path: ../lynkeus/flutter/lynkeus_plugins',
  ]);
  assert.deepEqual(
    pluginsDependencyLike(withDeps('  lynkeus_agent:\n    git:\n      url: https://example.com/l.git\n      ref: v1\n      path: flutter/lynkeus_agent\n')),
    ['lynkeus_plugins:', '  git:', '    url: https://example.com/l.git', '    ref: v1', '    path: flutter/lynkeus_plugins'],
  );
  assert.ok(addPluginsToPubspec(PUBSPEC).text.includes('  lynkeus_plugins:\n    git:'));
});

test('main.dart: the companion call follows start(), in its block, with its import; once', () => {
  const src =
    "import 'package:flutter/material.dart';\n\nvoid main() async {\n  LynkeusAgent.start(app: {'name': 'a'});\n  WidgetsFlutterBinding.ensureInitialized();\n  runApp(A());\n}\n";
  const edit = addPluginsToMain(src);
  assert.ok(edit.done);
  assert.ok(edit.text.includes("  LynkeusAgent.start(app: {'name': 'a'});\n  LynkeusPlugins.ensureInitialized();\n  WidgetsFlutterBinding"));
  assert.ok(edit.text.includes("import 'package:flutter/material.dart';\nimport 'package:lynkeus_plugins/lynkeus_plugins.dart';\n"));
  assert.equal(addPluginsToMain(edit.text).text, edit.text);
  assert.ok(!addPluginsToMain('void main() {}\n').done);
});

test('init adds the companion only when the lock shows a plugin that needs it, and says why', () => {
  const files = { 'pubspec.yaml': PUBSPEC, 'lib/main.dart': 'void main() => runApp(A());\n' };
  const none = tmp({ ...files, 'pubspec.lock': LOCK({ http: '1.0.0' }) });
  assert.ok(!setupApp(none, { install: true }).join('\n').includes('lynkeus_plugins'));
  assert.ok(!fs.readFileSync(path.join(none, 'lib/main.dart'), 'utf8').includes('LynkeusPlugins'));
  const root = tmp({ ...files, 'pubspec.lock': LOCK({ sqflite_platform_interface: '2.4.1' }) });
  const notes = setupApp(root, { install: true }).join('\n');
  assert.match(notes, /why: sqflite 2\.4 or later is in pubspec\.lock.*databaseFactory not initialized/);
  assert.match(notes, /lynkeus_plugins:\n\s+path: \/path\/to\/lynkeus\/flutter\/lynkeus_plugins/);
  assert.ok(fs.readFileSync(path.join(root, 'pubspec.yaml'), 'utf8').includes('lynkeus_plugins:\n    git:'));
  const main = fs.readFileSync(path.join(root, 'lib/main.dart'), 'utf8');
  assert.ok(main.includes("LynkeusAgent.start(app: {'name': 'demo'});\n  LynkeusPlugins.ensureInitialized();\n  runApp"));
  const before = [fs.readFileSync(path.join(root, 'pubspec.yaml'), 'utf8'), main];
  const again = setupApp(root, { install: true }).join('\n');
  assert.match(again, /already depends on lynkeus_plugins/);
  assert.doesNotMatch(again, /why:/);
  assert.deepEqual([fs.readFileSync(path.join(root, 'pubspec.yaml'), 'utf8'), fs.readFileSync(path.join(root, 'lib/main.dart'), 'utf8')], before);
  const manual = tmp({ ...files, 'pubspec.lock': LOCK({ sqflite_platform_interface: '2.4.1' }) });
  const hand = setupApp(manual, { install: false }).join('\n');
  assert.match(hand, /lynkeus_plugins is needed on a host/);
  assert.ok(!fs.readFileSync(path.join(manual, 'lib/main.dart'), 'utf8').includes('LynkeusPlugins'));
});

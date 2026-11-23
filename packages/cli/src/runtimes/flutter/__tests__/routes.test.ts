import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { flutterProject } from '../host.js';
import { changedSources, mapCommands } from '../../../commands/map.js';
import { runtimeAt } from '../../index.js';
import { flutterRouteParams } from '../routes.js';
import { smoke } from '../../../commands/smoke.js';
import type { Device } from '../../../device/driver.js';
import type { ScreenGraph } from '../../../knowledge/types.js';
import type { Base } from '../../../registry.js';

const PUBSPEC = 'name: both\ndependencies:\n  flutter:\n    sdk: flutter\n';

const tmp = (files: Record<string, string>): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-routes-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
};

const base = (root: string, lines: string[] = []): Base => ({
  root,
  config: {},
  device: () => Promise.reject(new Error('no device in this test')),
  graph: () => JSON.parse(fs.readFileSync(path.join(root, '.lynkeus', 'graph.json'), 'utf8')) as ScreenGraph,
  err: (line) => lines.push(line),
  attached: false,
});

const mapBuild = async (b: Base) => {
  const out = await mapCommands.find((c) => c.name === 'map build')!.run({ ...b, args: [], flags: {}, passthrough: [] });
  return typeof out === 'object' ? (out.code ?? 0) : 0;
};

const reactNativeAndFlutter = (key: 'dependencies' | 'peerDependencies' = 'dependencies') =>
  tmp({
    'package.json': JSON.stringify({ name: 'both', [key]: { 'react-native': '0.80.0' } }),
    'tsconfig.json': JSON.stringify({ compilerOptions: { jsx: 'react-jsx', strict: true }, include: ['app'] }),
    'app/navigation/Root.tsx':
      'import { Main } from \'../screens/Main\';\nexport const Root = () => <Stack.Navigator><Stack.Screen name="Main" component={Main} /></Stack.Navigator>;\n',
    'app/screens/Main.tsx': 'export const Main = () => <View testID="main" />;\n',
    'app/navigation/types.d.ts': "export type RootParamList = {\n  'Main': undefined;\n  'Detail': { id: string };\n};\n",
    'pubspec.yaml': PUBSPEC,
    'lib/main.dart': "void main() => runApp(MaterialApp(routes: {'/flutter': (_) => const FlutterPage()}));\nclass FlutterPage extends StatelessWidget {}\n",
  });

test('a folder that is React Native and Flutter keeps the React Native graph, from TypeScript', async () => {
  const root = reactNativeAndFlutter();
  assert.equal(flutterProject(root), undefined);
  const lines: string[] = [];
  assert.equal(await mapBuild(base(root, lines)), 0);
  const graph = base(root).graph();
  assert.deepEqual(Object.keys(graph.screens), ['Main']);
  assert.deepEqual(graph.screens.Main, { route: 'Main', component: 'Main', file: 'app/screens/Main.tsx', declaredIn: 'app/navigation/Root.tsx' });
  assert.ok(!Object.keys(graph.files).some((f) => f.endsWith('.dart')));
  assert.deepEqual(lines, []);
});

test('a React Native library with a Flutter example module, react-native only among its peers, keeps the React Native graph', async () => {
  const root = reactNativeAndFlutter('peerDependencies');
  assert.equal(flutterProject(root), undefined);
  assert.equal(await mapBuild(base(root)), 0);
  assert.deepEqual(Object.keys(base(root).graph().screens), ['Main']);
});

test('a React Native diff lists TypeScript sources from the repository root, never Dart ones', async () => {
  const root = reactNativeAndFlutter();
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'base');
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'change');
  assert.deepEqual(changedSources(root, 'HEAD~1', () => {}, (await runtimeAt(root)).sources).sort(), [
    'app/navigation/Root.tsx',
    'app/navigation/types.d.ts',
    'app/screens/Main.tsx',
  ]);
});

test('a Flutter project builds its graph from Dart, and lists its Dart sources relative to the app', async () => {
  const repo = tmp({
    'app/pubspec.yaml': PUBSPEC,
    'app/lib/main.dart': 'void main() => runApp(const MaterialApp(home: Home()));\nclass Home extends StatelessWidget {}\n',
  });
  const root = path.join(repo, 'app');
  assert.equal(await mapBuild(base(root)), 0);
  assert.deepEqual(Object.keys(base(root).graph().screens), ['/']);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'base');
  git('add', 'app/lib', 'app/pubspec.yaml');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'change');
  assert.deepEqual(
    changedSources(root, 'HEAD~1', () => {}, (await runtimeAt(root)).sources),
    ['lib/main.dart'],
  );
});

const fakeDevice = (opened: string[]): Device =>
  ({
    server: { connected: true },
    requests: async () => ({ inFlight: 0, requests: [] }),
    navigate: async (route: string) => {
      opened.push(route);
    },
    idle: async () => undefined,
    screen: async () => ({ route: opened.at(-1), path: [], elements: [{ kind: 'button', enabled: true, text: 'x' }] }),
  }) as unknown as Device;

const graphOf = (screens: ScreenGraph['screens']): ScreenGraph => ({ app: 'a', root: '/', extractedAt: '', screens, files: {}, warnings: [] });

test('smoke on React Native reads the ParamList and ignores the fields only a Flutter graph has', async () => {
  const root = reactNativeAndFlutter();
  const opened: string[] = [];
  const screen = (route: string) => ({ route, component: route, file: null, declaredIn: 'x' });
  await smoke({
    device: fakeDevice(opened),
    graph: graphOf({ Main: { ...screen('Main'), unnamed: true, params: ['id'] }, Detail: screen('Detail') }),
    appRoot: root,
    outDir: fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-smoke-')),
  });
  assert.deepEqual(opened, ['Main']);
});

test('smoke on Flutter opens the routes that need nothing, from the graph', async () => {
  const opened: string[] = [];
  const screen = (route: string) => ({ route, component: route, file: null, declaredIn: 'x' });
  const graph = graphOf({ '/': screen('/'), '/item/:id': { ...screen('/item/:id'), params: ['id'] }, Items: { ...screen('Items'), unnamed: true } });
  await smoke({
    device: fakeDevice(opened),
    graph,
    appRoot: tmp({}),
    outDir: fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-smoke-')),
    routeParams: flutterRouteParams(graph),
  });
  assert.deepEqual(opened, ['/']);
});

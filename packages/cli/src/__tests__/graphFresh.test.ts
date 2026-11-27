import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { mapCommands } from '../commands/map.js';
import { graphFile, loadGraph } from '../config.js';
import { type Base, register } from '../registry.js';
import { execute, graphStale } from '../runtime.js';

register(mapCommands);

const later = (file: string, by = 5000) => {
  const at = new Date(Date.now() + by);
  fs.utimesSync(file, at, at);
};

const project = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-graph-fresh-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fresh', dependencies: { 'react-native': '0.76.0' } }));
  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { jsx: 'react-jsx', strict: true }, include: ['src'] }));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'Home.tsx'), `export const Home = () => <Button testID="go" />;\n`);
  fs.writeFileSync(
    path.join(root, 'src', 'Nav.tsx'),
    `import { Home } from './Home';\nexport const Nav = () => <Stack.Navigator><Stack.Screen name="Home.Main" component={Home} /></Stack.Navigator>;\n`,
  );
  const base: Base = {
    root,
    config: {},
    attached: false,
    err: () => undefined,
    graph: () => loadGraph(root)!,
    device: () => Promise.reject(new Error('no app')),
  };
  return { root, base };
};

test('a command that reads the graph builds it when missing and again only when the source changed', async () => {
  const { root, base } = project();
  const first = await execute(['map', 'screens'], base);
  assert.equal(first.code, 0, first.error);
  assert.match(first.text ?? '', /Home\.Main/);
  const builtMs = fs.statSync(graphFile(root)).mtimeMs;

  await execute(['map', 'screens'], base);
  assert.equal(fs.statSync(graphFile(root)).mtimeMs, builtMs, 'nothing changed, so nothing was built');

  // A new screen in the navigator, saved after the graph was built.
  const nav = path.join(root, 'src', 'Nav.tsx');
  fs.writeFileSync(
    nav,
    `import { Home } from './Home';\nexport const Nav = () => <Stack.Navigator><Stack.Screen name="Home.Main" component={Home} /><Stack.Screen name="Home.Detail" component={Home} /></Stack.Navigator>;\n`,
  );
  later(nav);
  const after = await execute(['map', 'screens'], base);
  assert.match(after.text ?? '', /Home\.Detail/);
});

test('a graph is stale when a file it read changed or went, or a folder of its gained a file', () => {
  const { root } = project();
  const graph = { files: { 'src/Home.tsx': { selectors: [], navigates: [], imports: [] } } };
  const builtMs = Date.now() + 2000;
  for (const at of [path.join(root, 'src'), path.join(root, 'src', 'Home.tsx')]) fs.utimesSync(at, new Date(builtMs - 1000), new Date(builtMs - 1000));
  assert.equal(graphStale(root, graph, builtMs), false);
  fs.writeFileSync(path.join(root, 'src', 'New.tsx'), 'export {};\n');
  later(path.join(root, 'src'));
  assert.equal(graphStale(root, graph, builtMs), true);
  fs.utimesSync(path.join(root, 'src'), new Date(builtMs - 1000), new Date(builtMs - 1000));
  later(path.join(root, 'src', 'Home.tsx'));
  assert.equal(graphStale(root, graph, builtMs), true);
  assert.equal(graphStale(root, { files: { 'src/Gone.tsx': graph.files['src/Home.tsx'] } }, builtMs), true);
});

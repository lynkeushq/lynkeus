import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { coverageOf, impactOf, withIdCases } from '../../cases/coverage.js';
import type { Case } from '../../cases/format.js';
import { reachOfChanges } from '../../commands/map.js';
import { readIdentifierChange } from '../../runtimes/react-native/identifiers.js';
import { casesNamingIds, narrowIdentifierChanges, SUBSTITUTION } from '../identifiers.js';
import type { ScreenGraph } from '../types.js';

const WELCOME = `import { Button, Text, View } from "react-native"

export function WelcomeScreen({ navigation }) {
  return (
    <View testID="welcome-screen">
      <Text accessibilityLabel="Welcome">Hi</Text>
      <Button testID="next-screen-button" onPress={() => navigation.navigate("Demo")} title="Next" />
    </View>
  )
}
`;

test('a file that only renamed a testID names the old and new IDs', async () => {
  const renamed = WELCOME.replace('"next-screen-button"', '"welcome-continue-button"');
  assert.deepEqual(await readIdentifierChange(WELCOME, renamed, 'app/screens/Welcome.tsx'), {
    ids: ['next-screen-button', 'welcome-continue-button'],
    labels: [],
  });
  // In braces, as a template, or as an object property it is the same prop.
  const braced = WELCOME.replace('testID="next-screen-button"', `testID={\`next-\${"x"}\`}`).replace('testID="welcome-screen"', "testID={'welcome-screen'}");
  const braced2 = braced.replace(`next-\${"x"}`, `go-\${"x"}`);
  assert.deepEqual(await readIdentifierChange(braced, braced2, 'a.tsx'), { ids: [`next-${SUBSTITUTION}`, `go-${SUBSTITUTION}`], labels: [] });
  const props = 'const p = { testID: "a", style: s }\n';
  assert.deepEqual(await readIdentifierChange(props, props.replace('"a"', '"b"'), 'a.ts'), { ids: ['a', 'b'], labels: [] });
});

test('a label change names the old and new labels; comments and formatting change nothing', async () => {
  assert.deepEqual(await readIdentifierChange(WELCOME, WELCOME.replace('accessibilityLabel="Welcome"', 'accessibilityLabel="Hello"'), 'a.tsx'), {
    ids: [],
    labels: ['Welcome', 'Hello'],
  });
  const reformatted = `// the first screen\n${WELCOME.replace('<Text accessibilityLabel="Welcome">Hi</Text>', '<Text\n        accessibilityLabel="Welcome"\n      >Hi</Text>')}`;
  assert.deepEqual(await readIdentifierChange(WELCOME, reformatted, 'a.tsx'), { ids: [], labels: [] });
});

test('anything else that changed keeps the file, and two swapped testIDs count as changed', async () => {
  assert.equal(await readIdentifierChange(WELCOME, WELCOME.replace('title="Next"', 'title="Go"'), 'a.tsx'), undefined);
  assert.equal(await readIdentifierChange(WELCOME, WELCOME.replace('testID="next-screen-button" ', ''), 'a.tsx'), undefined);
  assert.equal(await readIdentifierChange(WELCOME, WELCOME.replace('"Demo"', '"Other"'), 'a.tsx'), undefined);
  // A testID read from a variable is code: changing it is not a rename Lynkeus can see.
  const variable = WELCOME.replace('testID="next-screen-button"', 'testID={id}');
  assert.equal(await readIdentifierChange(variable, variable.replace('testID={id}', 'testID={other}'), 'a.tsx'), undefined);
  const swapped = WELCOME.replace('"welcome-screen"', '"TMP"').replace('"next-screen-button"', '"welcome-screen"').replace('"TMP"', '"next-screen-button"');
  assert.deepEqual((await readIdentifierChange(WELCOME, swapped, 'a.tsx'))?.ids.sort(), ['next-screen-button', 'welcome-screen']);
});

test('narrowing drops a file whose change was only identifiers and keeps any other', async () => {
  const files: Record<string, [string, string]> = {
    'a.tsx': ['A', 'A2'],
    'b.tsx': ['B', 'B2'],
    'new.tsx': ['', 'N'],
  };
  const narrowed = await narrowIdentifierChanges(['a.tsx', 'b.tsx', 'new.tsx', 'gone.tsx'], {
    now: (f) => (f === 'gone.tsx' ? undefined : files[f]![1]),
    before: (f) => (f === 'new.tsx' ? undefined : files[f]?.[0]),
    change: async (_b, _a, f) => (f === 'a.tsx' ? { ids: ['x', 'y'], labels: [] } : undefined),
  });
  assert.deepEqual(narrowed.files, ['b.tsx', 'new.tsx', 'gone.tsx']);
  assert.deepEqual(narrowed.ids, [
    { id: 'x', file: 'a.tsx' },
    { id: 'y', file: 'a.tsx' },
  ]);
  assert.match(narrowed.notes[0]!, /^a\.tsx: only testIDs \(x, y\) changed, so it reaches the cases whose steps name them/);
});

const kase = (id: string, steps: Case['steps'], setup: Case['setup'] = []): Case => ({ file: `cases/${id}.md`, id, meta: {}, setup, teardown: [], steps });

test('a case names a testID in a step, a scoped or indexed target, or through a macro it calls', () => {
  const ids = [
    { id: 'next-screen-button', file: 'w.tsx' },
    { id: `item-${SUBSTITUTION}`, file: 'l.tsx' },
  ];
  const macros = { 'app.goToDemo': [{ 'app.press': '#next-screen-button' }], 'app.signedIn': [{ 'app.goToDemo': {} }] };
  const cases = [
    kase('direct', [{ verb: 'app.press', value: '#next-screen-button' }]),
    kase('indexed', [{ verb: 'app.press', value: { target: '#next-screen-button[1]' } }]),
    kase('macro', [{ verb: 'app.see', value: 'Demo' }], [{ verb: 'app.signedIn', value: {} }]),
    kase('templated', [{ verb: 'app.press', value: '#item-3' }]),
    kase('by-text', [{ verb: 'app.press', value: 'Next' }]),
    kase('prefix', [{ verb: 'app.press', value: '#next-screen-button-2' }]),
  ];
  assert.deepEqual(
    casesNamingIds(cases, ids, macros).map((h) => h.case.id),
    ['direct', 'indexed', 'macro', 'templated'],
  );
  const coverage = coverageOf(cases, ['Welcome']);
  const impact = withIdCases(impactOf([], coverage), cases, ids.slice(0, 1), macros);
  assert.deepEqual(
    impact.cases.map((c) => [c.id, c.via]),
    [
      ['direct', '#next-screen-button in w.tsx'],
      ['indexed', '#next-screen-button in w.tsx'],
      ['macro', '#next-screen-button in w.tsx'],
    ],
  );
});

test('reachOfChanges keeps a testID rename off the screens and hands its IDs on, while any other change still reaches them', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-ids-'));
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    const write = (f: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
      fs.writeFileSync(path.join(root, f), text);
    };
    write('app/screens/Welcome.tsx', WELCOME);
    write('app/components/Card.tsx', 'export const Card = () => null\n');
    git('init', '-q', '-b', 'main');
    git('add', '.');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'app');
    write('app/screens/Welcome.tsx', WELCOME.replace('"next-screen-button"', '"welcome-continue-button"'));
    const graph = {
      app: 'a',
      root,
      extractedAt: '',
      warnings: [],
      screens: { Welcome: { route: 'Welcome', component: 'WelcomeScreen', file: 'app/screens/Welcome.tsx', declaredIn: 'nav.tsx' } },
      files: {
        'app/screens/Welcome.tsx': { imports: ['app/components/Card.tsx'], selectors: [], navigates: [] },
        'app/components/Card.tsx': { imports: [], selectors: [], navigates: [] },
      },
    } as unknown as ScreenGraph;
    const runtime = { identifierChange: readIdentifierChange };
    const reach = await reachOfChanges(root, graph, ['app/screens/Welcome.tsx'], { base: 'main', runtime, relative: false });
    assert.deepEqual(reach.affected, []);
    assert.deepEqual(
      reach.ids.map((i) => i.id),
      ['next-screen-button', 'welcome-continue-button'],
    );
    assert.match(reach.notes[0]!, /only testIDs/);
    write('app/components/Card.tsx', 'export const Card = () => "x"\n');
    const both = await reachOfChanges(root, graph, ['app/screens/Welcome.tsx', 'app/components/Card.tsx'], { base: 'main', runtime, relative: false });
    assert.deepEqual(
      both.affected.map((a) => a.route),
      ['Welcome'],
    );
    // Without a reader every changed file reaches its screens, as before.
    const plain = await reachOfChanges(root, graph, ['app/screens/Welcome.tsx'], { base: 'main', runtime: {}, relative: false });
    assert.deepEqual(
      plain.affected.map((a) => a.route),
      ['Welcome'],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

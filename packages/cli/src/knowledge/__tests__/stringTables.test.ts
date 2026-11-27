import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { coverageOf, impactOf, withTextCases } from '../../cases/coverage.js';
import type { Case } from '../../cases/format.js';
import { reachOfChanges } from '../../commands/map.js';
import { readStringTable } from '../../runtimes/react-native/strings.js';
import { casesNamingText, diffStringTables, mentionsText, namesKey, narrowStringTables } from '../stringTables.js';
import type { ScreenGraph } from '../types.js';

const EN = `import demoEn from "./demo-en"

const en = {
  common: { ok: "OK!", cancel: "Cancel" },
  welcomeScreen: { readyForLaunch: "Your app, almost ready for launch!" },
  demoCommunityScreen: { title: "Community", tagLine: "Plug in to Infinite Red's community" },
  ...demoEn,
}

export default en
export type Translations = typeof en
`;

test('a file of object literals of strings is a string table, read by table and key path', async () => {
  const entries = await readStringTable(EN, 'app/i18n/en.ts');
  assert.deepEqual(
    entries?.map((e) => `${e.table}:${e.key.join('.')}=${e.value}`),
    [
      'en:common.ok=OK!',
      'en:common.cancel=Cancel',
      'en:welcomeScreen.readyForLaunch=Your app, almost ready for launch!',
      'en:demoCommunityScreen.title=Community',
      "en:demoCommunityScreen.tagLine=Plug in to Infinite Red's community",
    ],
  );
  const constant = await readStringTable(
    `export const strings = { 'home': { title: \`Home\` } } as const;\nexport default { other: 'x' } satisfies Record<string, string>;`,
    's.ts',
  );
  assert.deepEqual(
    constant?.map((e) => `${e.table}:${e.key.join('.')}`),
    ['strings:home.title', 'default:other'],
  );
});

test('a file that computes anything is not a string table', async () => {
  for (const source of [
    `export const t = (k: string) => k;\nconst en = { a: 'b' };`,
    `const en = { a: 'b', n: 1 };`,
    `const en = { a: 'b', [key]: 'c' };`,
    `const en = { a: 'b', b };`,
    `const en = { a: \`x\${y}\` };`,
    `export * from './other';\nconst en = { a: 'b' };`,
    `const n = 3;`,
    `import x from 'y';`,
  ])
    assert.equal(await readStringTable(source, 'x.ts'), undefined, source);
});

test('a diff of two readings names the strings added, removed and rewritten', () => {
  const e = (key: string, value: string) => ({ table: 'en', key: key.split('.'), value });
  assert.deepEqual(diffStringTables([e('a.b', 'One'), e('a.c', 'Two'), e('d', 'Gone')], [e('a.b', 'One'), e('a.c', 'Deux'), e('n', 'New')]), [
    { key: ['a', 'c'], before: 'Two', after: 'Deux' },
    { key: ['n'], after: 'New' },
    { key: ['d'], before: 'Gone' },
  ]);
});

test('a source names a key as a string, a member chain or a literal prefix of a built key', () => {
  const key = ['demoCommunityScreen', 'title'];
  assert.ok(namesKey('<Screen titleTx="demoCommunityScreen:title" />', key));
  assert.ok(namesKey("translate('demoCommunityScreen.title')", key));
  assert.ok(namesKey('t(`demoCommunityScreen/title`)', key));
  assert.ok(namesKey('const s = strings.demoCommunityScreen.title', key));
  assert.ok(namesKey('const s = strings?.demoCommunityScreen?.title', key));
  assert.ok(namesKey('t(`demoCommunityScreen.$' + '{which}`)', key));
  assert.ok(namesKey("t('demoCommunityScreen.' + which)", key));
  assert.ok(!namesKey('<Screen titleTx="demoCommunityScreen:tagLine" />', key));
  assert.ok(!namesKey('demoCommunityScreen.titleLong', key));
  assert.ok(!namesKey("t('demoCommunityScreen.title.more')", key));
});

const graph = (files: Record<string, string[]>, screens: Record<string, string>): Pick<ScreenGraph, 'files' | 'screens'> => ({
  files: Object.fromEntries(Object.entries(files).map(([f, imports]) => [f, { selectors: [], navigates: [], imports }])),
  screens: Object.fromEntries(Object.entries(screens).map(([route, file]) => [route, { route, component: route, file, declaredIn: 'nav.tsx' }])),
});

const APP = graph(
  {
    'app/i18n/en.ts': [],
    'app/i18n/i18n.ts': ['app/i18n/en.ts'],
    'app/components/Text.tsx': ['app/i18n/i18n.ts'],
    'app/screens/Community.tsx': ['app/components/Text.tsx'],
    'app/screens/Welcome.tsx': ['app/components/Text.tsx'],
    'app/screens/Podcasts.tsx': ['app/components/Text.tsx'],
  },
  { Community: 'app/screens/Community.tsx', Welcome: 'app/screens/Welcome.tsx', Podcasts: 'app/screens/Podcasts.tsx' },
);
const SOURCES: Record<string, string> = {
  'app/i18n/en.ts': EN.replace('title: "Community"', 'title: "Meet the community"'),
  'app/i18n/i18n.ts': 'import en from "./en"',
  'app/components/Text.tsx': 'export const Text = ({ tx }) => translate(tx)',
  'app/screens/Community.tsx': '<Text tx="demoCommunityScreen:title" /><Text tx="demoCommunityScreen:tagLine" />',
  'app/screens/Welcome.tsx': '<Text tx="welcomeScreen:readyForLaunch" />',
  'app/screens/Podcasts.tsx': '<Text text="Podcasts" />',
};
const reading = (now: Record<string, string>, before: Record<string, string>) => ({
  now: (f: string) => now[f],
  before: (f: string) => before[f],
  table: readStringTable,
});

test('a changed translation reaches the files that name its key, with its old and new text', async () => {
  const narrowed = await narrowStringTables(['app/i18n/en.ts', 'app/screens/Podcasts.tsx'], APP, reading(SOURCES, { ...SOURCES, 'app/i18n/en.ts': EN }));
  assert.deepEqual(narrowed.files.sort(), ['app/screens/Community.tsx', 'app/screens/Podcasts.tsx']);
  assert.deepEqual(
    narrowed.texts.map((t) => t.text),
    ['Community', 'Meet the community'],
  );
  assert.equal(narrowed.notes.length, 1);
  assert.match(narrowed.notes[0]!, /^app\/i18n\/en\.ts: only strings changed \(demoCommunityScreen\.title\)/);
});

test('a changed string no file names by its whole key keeps every importer, and says why', async () => {
  const now = { ...SOURCES, 'app/screens/Community.tsx': 'const { t } = useTranslation("demoCommunityScreen"); t("title")' };
  const narrowed = await narrowStringTables(['app/i18n/en.ts'], APP, reading(now, { ...now, 'app/i18n/en.ts': EN }));
  assert.deepEqual(narrowed.files, ['app/i18n/en.ts']);
  assert.deepEqual(narrowed.texts, []);
  assert.equal(narrowed.notes[0], 'app/i18n/en.ts: a string table, but no file names `demoCommunityScreen.title` by its whole key, so every importer counts');
});

test('code, a new file, an unchanged file and a file that was code at the base all keep every importer', async () => {
  const code = 'export const translate = (k) => k';
  const narrowed = await narrowStringTables(
    ['app/i18n/i18n.ts', 'app/i18n/new.ts', 'app/i18n/same.ts', 'app/i18n/was-code.ts'],
    APP,
    reading(
      { 'app/i18n/i18n.ts': code, 'app/i18n/new.ts': EN, 'app/i18n/same.ts': EN, 'app/i18n/was-code.ts': EN },
      { 'app/i18n/i18n.ts': `${code}\n`, 'app/i18n/same.ts': EN, 'app/i18n/was-code.ts': code },
    ),
  );
  assert.deepEqual(narrowed.files, ['app/i18n/i18n.ts', 'app/i18n/new.ts', 'app/i18n/same.ts', 'app/i18n/was-code.ts']);
  assert.deepEqual(narrowed.notes, ['app/i18n/was-code.ts: a string table now, but not at the base, so every importer counts']);
});

test('a step names a text when it is that text or part of it, placeholders aside', () => {
  assert.ok(mentionsText('Community', 'Community'));
  assert.ok(mentionsText('community', 'Meet the community'));
  assert.ok(mentionsText('Welcome back', 'Welcome back, {{name}}!'));
  assert.ok(!mentionsText('Podcasts', 'Community'));
  assert.ok(!mentionsText('a', 'a'));
});

const kase = (id: string, steps: Case['steps']): Case => ({ file: `cases/${id}.md`, id, meta: {}, setup: [], teardown: [], steps });

test('impact adds the cases that check a changed text, and only those, to the ones its screens reach', () => {
  const cases = [
    kase('demo-tabs', [{ verb: 'app.see', value: { text: 'Community' } }]),
    kase('welcome', [{ verb: 'app.nav', value: 'Welcome' }]),
    kase('podcasts', [{ verb: 'app.see', value: 'Podcasts' }]),
  ];
  const texts = [
    { text: 'Meet the community', file: 'app/i18n/en.ts' },
    { text: 'Community', file: 'app/i18n/en.ts' },
  ];
  assert.deepEqual(
    casesNamingText(cases, texts).map((h) => h.case.id),
    ['demo-tabs'],
  );
  const coverage = coverageOf(cases, ['Welcome', 'Community', 'Podcasts']);
  const impact = withTextCases(impactOf([], coverage), cases, texts);
  assert.deepEqual(impact.cases, [{ id: 'demo-tabs', file: 'cases/demo-tabs.md', routes: [], distance: 0, via: '"Community" in app/i18n/en.ts' }]);
  // The whole app is reached already: nothing to add.
  assert.equal(withTextCases(impactOf([], coverage, 'index.ts starts the app'), cases, texts).cases.length, 3);
});

test('reachOfChanges diffs a committed string table against the working tree and reaches only the screen naming the key', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-strings-'));
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    for (const [f, text] of Object.entries({ ...SOURCES, 'app/i18n/en.ts': EN })) {
      fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
      fs.writeFileSync(path.join(root, f), text);
    }
    git('init', '-q', '-b', 'main');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'empty');
    git('add', '.');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'app');
    fs.writeFileSync(path.join(root, 'app/i18n/en.ts'), SOURCES['app/i18n/en.ts']!);
    const full = { ...APP, app: 'a', root, extractedAt: '', warnings: [] } as ScreenGraph;
    const runtime = { stringTable: readStringTable };
    const reach = await reachOfChanges(root, full, ['app/i18n/en.ts'], { base: 'main', runtime, relative: false });
    assert.deepEqual(
      reach.affected.map((a) => a.route),
      ['Community'],
    );
    assert.equal(reach.texts.length, 2);
    // A runtime with no string table reader, or a base git does not know, keeps every importer.
    const plain = await reachOfChanges(root, full, ['app/i18n/en.ts'], { base: 'main', runtime: {}, relative: false });
    assert.deepEqual(plain.affected.map((a) => a.route).sort(), ['Community', 'Podcasts', 'Welcome']);
    const unknown = await reachOfChanges(root, full, ['app/i18n/en.ts'], { base: 'nope', runtime, relative: false });
    assert.equal(unknown.affected.length, 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

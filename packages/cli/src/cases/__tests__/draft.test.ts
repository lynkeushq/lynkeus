import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { draftCase, hereCase } from '../draft.js';
import { readCases } from '../format.js';

const parse = (text: string) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lk-draft-')), 'x.md');
  fs.writeFileSync(file, text);
  return readCases(file)[0]!;
};

test('a draft is a case that parses: the presses to the screen, then the check that it is there', () => {
  const text = draftCase({
    id: 'profile-theme',
    from: 'Home.Main',
    to: 'Profile.Main',
    path: [{ from: 'Home.Main', to: 'Profile.Main', press: 'profile-button', source: 'static' }],
  });
  const c = parse(text);
  assert.equal(c.id, 'profile-theme');
  assert.deepEqual(
    c.steps.map((s) => s.verb),
    ['app.press', 'app.wait', 'app.see'],
  );
});

test('the setup offers what the fixtures server describes, commented out, and never picks for the author', () => {
  const text = draftCase({
    id: 'x',
    from: 'A.Main',
    to: 'B.Main',
    path: undefined,
    fixtures: [{ name: 'create_user', summary: 'A user who can sign in', params: { country: { values: ['ar', 'mx'] } }, example: { country: 'ar' } }],
  });
  assert.match(text, /# - create_user: \{country: "ar"\}\s+# A user who can sign in — country \(ar\|mx\)/);
  assert.deepEqual(parse(text).setup, []);
  assert.match(text, /lynkeus crawl --to B\.Main/);
});

const element = (i: number, extra: Record<string, unknown>) => ({ i, kind: 'text', frame: { x: 0, y: 0, w: 10, h: 10 }, enabled: true, depth: 1, ...extra });

test('a case from the screen the app shows passes as it is: its route, then what is on it, testIDs first', () => {
  const screen = {
    route: 'Home',
    path: ['Home'],
    elements: [
      element(0, { text: 'Welcome back' }),
      element(1, { testId: 'balance' }),
      element(2, { testId: 'covered-one', covered: true }),
      element(3, { text: 'x' }),
    ],
    commit: 1,
    busy: false,
    window: { w: 390, h: 844 },
    costMs: 1,
  } as unknown as Parameters<typeof hereCase>[1];
  const c = parse(hereCase('home-opens', screen));
  assert.equal(c.id, 'home-opens');
  assert.deepEqual(
    c.setup.map((s) => s.verb),
    ['app.nav'],
  );
  assert.deepEqual(
    c.steps.map((s) => s.value),
    ['#balance', 'Welcome back'],
  );
});

test('an app with no navigation gets a case with no route to go to', () => {
  const screen = {
    path: [],
    elements: [element(0, { text: 'Open up App.tsx to start working on your app!' })],
    commit: 1,
    busy: false,
    window: { w: 390, h: 844 },
    costMs: 1,
  } as unknown as Parameters<typeof hereCase>[1];
  const c = parse(hereCase('first-screen', screen));
  assert.equal(c.setup.length, 0);
  assert.deepEqual(
    c.steps.map((s) => s.verb),
    ['app.see'],
  );
});

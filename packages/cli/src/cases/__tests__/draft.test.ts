import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { draftCase } from '../draft.js';
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

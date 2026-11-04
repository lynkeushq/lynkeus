import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { resultsOf, summaryOf } from '../commands/ci.js';

test('a run folder reads as each case by its last attempt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lk-ci-'));
  const lines = [
    { id: 'a', result: 'failed', attempt: 1 },
    { id: 'a', result: 'passed', attempt: 2 },
    { id: 'b', result: 'failed', title: 'B breaks' },
  ];
  fs.writeFileSync(path.join(dir, 'cases.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'));
  assert.deepEqual(
    resultsOf(dir).map((r) => [r.id, r.result]),
    [
      ['a', 'passed'],
      ['b', 'failed'],
    ],
  );
  assert.deepEqual(resultsOf(path.join(dir, 'none')), []);
});

test('the job summary says how many passed, lists what failed and links the report', () => {
  const s = summaryOf(
    [
      { id: 'a', result: 'passed' },
      { id: 'b', result: 'failed', title: 'B breaks' },
    ],
    'https://lynkeus.io/r/x',
    'All 2 case files.',
  );
  assert.match(s, /1\/2 cases passed, 1 failed/);
  assert.match(s, /\| `b` \| B breaks \|/);
  assert.match(s, /\[Open the report\]\(https:\/\/lynkeus\.io\/r\/x\)/);
});

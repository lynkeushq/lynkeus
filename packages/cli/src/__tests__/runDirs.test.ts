import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { ageOf, pruneRuns, sizeOf } from '../cases/runDirs.js';
import { keptOrDeleted } from '../commands/cases.js';

const run = (root: string, name: string, ageMs: number) => {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'frames'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'run.json'), '{}');
  fs.writeFileSync(path.join(dir, 'cases.jsonl'), '');
  fs.writeFileSync(path.join(dir, 'frames', 'a.avif'), Buffer.alloc(1000));
  const when = (Date.now() - ageMs) / 1000;
  fs.utimesSync(path.join(dir, 'run.json'), when, when);
  return dir;
};

test('ages read as days, hours or minutes', () => {
  assert.equal(ageOf('7d'), 7 * 86_400_000);
  assert.equal(ageOf('12h'), 12 * 3_600_000);
  assert.equal(ageOf('soon'), undefined);
});

test('prune deletes only runs older than asked, and nothing that is not a run', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lk-prune-'));
  const old = run(root, 'old', 10 * 86_400_000);
  const fresh = run(root, 'fresh', 60_000);
  fs.mkdirSync(path.join(root, 'notes'));
  const dry = pruneRuns(root, 7 * 86_400_000, true);
  assert.deepEqual(dry.removed, [old]);
  assert.ok(fs.existsSync(old));
  const done = pruneRuns(root, 7 * 86_400_000);
  assert.deepEqual(done.removed, [old]);
  assert.ok(!fs.existsSync(old) && fs.existsSync(fresh) && fs.existsSync(path.join(root, 'notes')));
  assert.ok(done.bytes >= 1000);
});

test('after a push the folder is deleted only when asked and every file was taken', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lk-after-'));
  const a = run(root, 'a', 0);
  assert.ok(sizeOf(a) >= 1000);
  assert.match(keptOrDeleted(a, 'keep', true), /on disk/);
  assert.match(keptOrDeleted(a, 'delete', false), /kept because/);
  assert.ok(fs.existsSync(a));
  assert.match(keptOrDeleted(a, 'delete', true), /deleted after the push/);
  assert.ok(!fs.existsSync(a));
});

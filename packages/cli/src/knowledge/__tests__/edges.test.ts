import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import * as edges from '../edges.js';

const lines = (file: string) => fs.readFileSync(file, 'utf8').trim().split('\n');

test('a sighting is one appended line; reading merges them and compaction keeps one per edge', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-edges-')), 'edges.jsonl');
  const store = edges.open(file);
  assert.equal(store.record({ from: 'B.Main', to: 'C.Main', via: 'next' }), true);
  assert.equal(store.record({ from: 'A.Main', to: 'B.Main', via: 'open' }), true);
  assert.equal(store.record({ from: 'B.Main', to: 'C.Main', via: 'next' }), false);
  assert.equal(fs.existsSync(file), false);
  assert.equal(lines(path.join(`${file}.parts`, `${process.pid}.jsonl`)).length, 3);
  assert.deepEqual(
    edges.load(file).map((e) => [e.from, e.seen]),
    [
      ['B.Main', 2],
      ['A.Main', 1],
    ],
  );

  store.compact();
  assert.deepEqual(
    fs
      .readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l).from),
    ['A.Main', 'B.Main'],
  );
  assert.equal(edges.prune(file, new Set(['A.Main', 'B.Main'])), 1);
});

test('runs side by side each append to a part of their own; a fold takes its own part and those of runs that are gone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-edges-'));
  const file = path.join(dir, 'edges.jsonl');
  const parts = `${file}.parts`;
  fs.mkdirSync(parts);
  // A run that was killed before folding (no process has this pid), one still running (this test's parent), and a torn line.
  const row = (from: string) => JSON.stringify({ from, to: 'X', via: 'v', seen: 1, last: '2026-11-01' });
  fs.writeFileSync(path.join(parts, '999999999.jsonl'), `${row('Dead')}\n${row('Dead')}\n`);
  fs.writeFileSync(path.join(parts, `${process.ppid}.jsonl`), `${row('Live')}\n{"from":"Torn`);
  edges.append(file, { from: 'Mine', to: 'X', via: 'v' });

  assert.deepEqual(
    edges
      .load(file)
      .map((e) => [e.from, e.seen])
      .sort(),
    [
      ['Dead', 2],
      ['Live', 1],
      ['Mine', 1],
    ],
  );
  edges.fold(file);
  assert.deepEqual(fs.readdirSync(parts), [`${process.ppid}.jsonl`]);
  assert.deepEqual(
    lines(file).map((l) => JSON.parse(l).from),
    ['Dead', 'Mine'],
  );
  assert.equal(edges.load(file).length, 3);
  assert.equal(fs.existsSync(`${file}.lock`), false);
});

test('a fold waits for a lock another process holds, and takes one its holder left behind long ago', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-edges-')), 'edges.jsonl');
  edges.append(file, { from: 'A', to: 'B', via: 'v' });
  fs.writeFileSync(`${file}.lock`, '1');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(`${file}.lock`, old, old);
  edges.fold(file);
  assert.deepEqual(
    lines(file).map((l) => JSON.parse(l).from),
    ['A'],
  );
  assert.equal(fs.existsSync(`${file}.lock`), false);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { describeStatus, type ProgressEvent, readEvents, RunState, statusLine, statusOf } from '../progress.js';

const at = (s: number) => new Date(Date.UTC(2026, 10, 13, 12, 0, s)).toISOString();
const t = (s: number) => Date.parse(at(s));

const start = (cases: { id: string; expectedMs?: number }[], jobs = 2): ProgressEvent => ({
  type: 'run-start',
  at: at(0),
  pid: 4242,
  total: cases.length,
  jobs,
  cases,
});

test('a run’s events say how many cases are done, what each job is on and in which section', () => {
  const run = new RunState();
  const events: ProgressEvent[] = [
    start([{ id: 'a' }, { id: 'b' }, { id: 'c' }]),
    { type: 'case-start', at: at(1), id: 'a', job: 0, attempt: 1, steps: 10, host: 'port 8201' },
    { type: 'case-start', at: at(1), id: 'b', job: 1, attempt: 1, steps: 4 },
    { type: 'step', at: at(2), id: 'a', job: 0, index: 6, steps: 10, section: 'steps', heading: '3 A wrong PIN', step: 'app.press #numpad-9-button' },
    { type: 'case-end', at: at(9), id: 'b', job: 1, attempt: 1, result: 'failed', ms: 8000, retrying: true },
    { type: 'case-start', at: at(9), id: 'b', job: 1, attempt: 2, steps: 4 },
    { type: 'case-end', at: at(17), id: 'b', job: 1, attempt: 2, result: 'failed', ms: 8000 },
  ];
  for (const e of events) run.apply(e);
  const s = run.status(t(20));
  assert.equal(s.state, 'running');
  assert.equal(s.done, 1);
  assert.equal(s.failed, 1);
  assert.equal(s.retried, 1);
  assert.deepEqual(s.failures, ['b']);
  assert.equal(s.running.length, 1);
  assert.equal(s.running[0]!.step?.heading, '3 A wrong PIN');
  assert.equal(s.running[0]!.step?.index, 6);
  // Nothing timed before: b's 8 s stands for each case left. a has spent 19 of its 8 s, c needs 8, over 2 jobs.
  assert.equal(s.etaFrom, 'average');
  assert.equal(s.etaMs, 4000);
  assert.match(statusLine(s), /^1\/3 ❌1 │ 20s · ~4s left │ 1: a §3 A wrong PIN · step 7\/10/);
  assert.match(describeStatus(s, '/runs/x/progress.ndjson'), /job 1: a on port 8201, 19s in — §3 A wrong PIN · step 7\/10: app.press #numpad-9-button/);
});

test('the time left comes from how long each case took when it last passed', () => {
  const run = new RunState();
  run.apply(
    start(
      [
        { id: 'a', expectedMs: 60_000 },
        { id: 'b', expectedMs: 30_000 },
        { id: 'c', expectedMs: 30_000 },
      ],
      1,
    ),
  );
  run.apply({ type: 'case-start', at: at(0), id: 'a', job: 0, attempt: 1, steps: 3 });
  const s = run.status(t(20));
  assert.equal(s.etaFrom, 'history');
  // a has 40 s left, then b and c: 100 s on one job.
  assert.equal(s.etaMs, 100_000);
});

test('with nothing to go on there is no estimate', () => {
  const run = new RunState();
  run.apply(start([{ id: 'a' }, { id: 'b' }]));
  run.apply({ type: 'case-start', at: at(0), id: 'a', job: 0, attempt: 1, steps: 3 });
  assert.equal(run.status(t(5)).etaMs, undefined);
});

test('a finished run says so, and one whose process is gone without finishing is stopped', () => {
  const finished = new RunState();
  finished.apply(start([{ id: 'a' }], 1));
  finished.apply({ type: 'case-end', at: at(3), id: 'a', job: 0, attempt: 1, result: 'passed', ms: 3000 });
  finished.apply({ type: 'run-end', at: at(4), passed: 1, failed: 0, unsupported: 0, ms: 4000, report: 'https://lynkeus.io/r/x' });
  const done = finished.status(t(100));
  assert.equal(done.state, 'finished');
  assert.equal(done.elapsedMs, 4000);
  assert.equal(done.report, 'https://lynkeus.io/r/x');

  const cut = new RunState();
  cut.apply(start([{ id: 'a' }, { id: 'b' }], 1));
  cut.apply({ type: 'case-start', at: at(2), id: 'a', job: 0, attempt: 1, steps: 3 });
  const stopped = cut.status(t(600), false);
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.elapsedMs, 2000);
  assert.deepEqual(stopped.running, []);
  assert.match(describeStatus(stopped), /^stopped: its process \(4242\) is gone without finishing/);
});

test('the file a run is still writing is read up to its last whole line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-progress-'));
  const file = path.join(dir, 'progress.ndjson');
  const first = start([{ id: 'a' }], 1);
  fs.writeFileSync(file, `${JSON.stringify({ ...first, pid: process.pid })}\n{"type":"case-st`);
  assert.equal(readEvents(file).length, 1);
  const s = statusOf(file);
  // Its process is this one, which is alive.
  assert.equal(s.state, 'running');
  assert.equal(s.total, 1);
});

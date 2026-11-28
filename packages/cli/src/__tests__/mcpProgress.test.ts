import assert from 'node:assert/strict';
import { test } from 'node:test';

import { caseCommands } from '../commands/cases.js';
import { growing, jobNotifier, progressNotifier, schemaFor } from '../mcp/server.js';

test('an MCP caller hears every event of a run, each case start, step and end, with a value that only grows', () => {
  const sent: { progress: number; total?: number; message?: string }[] = [];
  const notify = progressNotifier((p) => sent.push(p));
  const at = (ms: number) => new Date(1_800_000_000_000 + ms).toISOString();
  notify({ type: 'run-start', at: at(0), pid: 1, total: 2, jobs: 1, cases: [{ id: 'a' }, { id: 'b' }] });
  notify({ type: 'case-start', at: at(0), id: 'a', job: 0, attempt: 1, steps: 4 });
  notify({ type: 'step', at: at(1200), id: 'a', job: 0, index: 1, steps: 4, section: 'steps', step: 'app.press #go' });
  notify({ type: 'step', at: at(1255), id: 'a', job: 0, index: 1, steps: 4, section: 'steps', step: 'app.press #go', status: 'passed', ms: 55 });
  notify({ type: 'case-end', at: at(1300), id: 'a', job: 0, attempt: 1, result: 'passed', ms: 1300 });
  notify({ type: 'run-end', at: at(1300), passed: 1, failed: 0, unsupported: 0, ms: 1300 });
  assert.deepEqual(
    sent.map((s) => s.message),
    [
      '▶ 2 case(s), 1 at a time',
      '▶ a · 0/2 done',
      'a · step 2/4 app.press #go · +1.2 s',
      'a · step 2/4 ✅ app.press #go · 55 ms',
      '✅ a passed in 1.3 s · 1/2 done',
      '■ 1 passed, 0 failed in 1.3 s',
    ],
  );
  const values = sent.map((s) => s.progress);
  assert.ok(
    values.every((v, i) => i === 0 || v > values[i - 1]!),
    `values grow: ${values}`,
  );
  assert.equal(values[4], 1);
  assert.ok(sent.every((s) => s.total === 2));
});

test('lanes side by side interleave line by line, each headed by its lane and counting its own cases', () => {
  const sent: string[] = [];
  const notify = progressNotifier((p) => sent.push(p.message ?? ''));
  const at = new Date().toISOString();
  notify({
    type: 'run-start',
    at,
    pid: 1,
    total: 3,
    jobs: 2,
    cases: [
      { id: 'login (fastsim:ios)', lane: 'fastsim:ios' },
      { id: 'logout (fastsim:ios)', lane: 'fastsim:ios' },
      { id: 'login (fastsim:android)', lane: 'fastsim:android' },
    ],
  });
  notify({ type: 'case-start', at, id: 'login (fastsim:ios)', job: 0, attempt: 1, steps: 2, lane: 'fastsim:ios' });
  notify({ type: 'case-start', at, id: 'login (fastsim:android)', job: 1, attempt: 1, steps: 2, lane: 'fastsim:android' });
  notify({
    type: 'step',
    at,
    id: 'login (fastsim:android)',
    job: 1,
    index: 0,
    steps: 2,
    section: 'steps',
    step: 'app.fresh',
    status: 'failed',
    ms: 3000,
    lane: 'fastsim:android',
  });
  notify({ type: 'case-end', at, id: 'login (fastsim:ios)', job: 0, attempt: 1, result: 'passed', ms: 800, lane: 'fastsim:ios' });
  notify({ type: 'case-end', at, id: 'login (fastsim:android)', job: 1, attempt: 1, result: 'failed', ms: 3100, retrying: true, lane: 'fastsim:android' });
  notify({ type: 'case-start', at, id: 'login (fastsim:android)', job: 1, attempt: 2, steps: 2, lane: 'fastsim:android' });
  assert.deepEqual(sent, [
    '▶ 3 case(s) on fastsim:ios, fastsim:android, 2 at a time',
    '[fastsim:ios] ▶ login · 0/2 done',
    '[fastsim:android] ▶ login · 0/1 done',
    '[fastsim:android] login · step 1/2 ❌ app.fresh · 3.0 s',
    '[fastsim:ios] ✅ login passed in 800 ms · 1/2 done',
    '[fastsim:android] ❌ login failed in 3.1 s, retrying once · 0/1 done',
    '[fastsim:android] ▶ login (attempt 2) · 0/1 done',
  ]);
});

test('a step that runs long still beats: the run’s live line again, a hair higher, and never before the run started', () => {
  const sent: { progress: number; total?: number; message?: string }[] = [];
  const notify = progressNotifier((p) => sent.push(p));
  assert.equal(notify.beat(), false, 'no beat before the run starts');
  const at = new Date().toISOString();
  notify({ type: 'run-start', at, pid: 1, total: 2, jobs: 1, cases: [{ id: 'a' }, { id: 'b' }] });
  notify({ type: 'case-start', at, id: 'a', job: 0, attempt: 1, steps: 2 });
  notify({ type: 'step', at, id: 'a', job: 0, index: 0, steps: 2, section: 'steps', step: 'app.fresh' });
  const before = sent.length;
  assert.equal(notify.beat(), true);
  assert.equal(notify.beat(), true);
  const beats = sent.slice(before);
  assert.equal(beats.length, 2);
  assert.ok(beats[0]!.progress > sent[before - 1]!.progress && beats[1]!.progress > beats[0]!.progress);
  assert.match(beats[1]!.message!, /│ a steps · step 1\/2/);
  notify({ type: 'case-end', at, id: 'a', job: 0, attempt: 1, result: 'passed', ms: 100 });
  assert.equal(sent.at(-1)!.progress, 1);
});

test('case_run takes over MCP what the instructions tell a model to pass', () => {
  const run = caseCommands.find((c) => c.name === 'case run');
  assert.ok(run);
  const properties = Object.keys(schemaFor(run).properties);
  for (const name of ['out', 'screenshots', 'video', 'traces', 'push', 'host', 'host_heap', 'jobs', 'ports', 'host_command'])
    assert.ok(properties.includes(name), `case_run takes ${name}`);
});

test('a job beats with its last line and how long it has run; every value a call sends grows, whoever sends it', () => {
  const sent: { progress: number; message?: string }[] = [];
  const send = growing((p) => sent.push(p));
  const job = jobNotifier(send, Date.now() - 42_000);
  job.beat('setup');
  job('building the iOS app');
  job.beat('setup');
  send({ progress: 0.5, message: 'a run that starts after' });
  assert.deepEqual(
    sent.map((s) => s.progress),
    [1, 2, 3, 3.001],
  );
  assert.match(sent[0]!.message!, /^setup: still running, 42 s in$/);
  assert.match(sent[2]!.message!, /^building the iOS app: still running, 42 s in$/);
});

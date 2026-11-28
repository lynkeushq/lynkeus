import assert from 'node:assert/strict';
import { test } from 'node:test';

import { caseCommands } from '../commands/cases.js';
import { growing, jobNotifier, progressNotifier, schemaFor } from '../mcp/server.js';

test('an MCP caller hears a run’s progress as a value that only grows, out of its cases', () => {
  const sent: { progress: number; total?: number; message?: string }[] = [];
  const notify = progressNotifier((p) => sent.push(p));
  const at = new Date().toISOString();
  notify({ type: 'run-start', at, pid: 1, total: 2, jobs: 1, cases: [{ id: 'a' }, { id: 'b' }] });
  notify({ type: 'case-start', at, id: 'a', job: 0, attempt: 1, steps: 4 });
  notify({ type: 'step', at, id: 'a', job: 0, index: 1, steps: 4, section: 'steps', step: 'app.press #go' });
  notify({ type: 'step', at, id: 'a', job: 0, index: 1, steps: 4, section: 'steps', step: 'app.press #go', status: 'passed', ms: 10 });
  notify({ type: 'case-end', at, id: 'a', job: 0, attempt: 1, result: 'passed', ms: 100 });
  notify({ type: 'run-end', at, passed: 1, failed: 0, unsupported: 0, ms: 100 });
  assert.deepEqual(
    sent.map((s) => s.progress),
    [0, 0.5, 1],
  );
  assert.ok(sent.every((s) => s.total === 2));
  assert.match(sent[0]!.message!, /^0\/2/);
});

test('case_run takes over MCP what the instructions tell a model to pass', () => {
  const run = caseCommands.find((c) => c.name === 'case run');
  assert.ok(run);
  const properties = Object.keys(schemaFor(run).properties);
  for (const name of ['out', 'screenshots', 'video', 'traces', 'push', 'host', 'host_heap', 'jobs', 'ports', 'host_command'])
    assert.ok(properties.includes(name), `case_run takes ${name}`);
});

test('a step that runs long still beats: the run’s line again, a hair higher, and never before the run started', () => {
  const sent: { progress: number; total?: number; message?: string }[] = [];
  const notify = progressNotifier((p) => sent.push(p));
  assert.equal(notify.beat(), false, 'no beat before the run starts');
  const at = new Date().toISOString();
  notify({ type: 'run-start', at, pid: 1, total: 2, jobs: 1, cases: [{ id: 'a' }, { id: 'b' }] });
  notify({ type: 'case-start', at, id: 'a', job: 0, attempt: 1, steps: 2 });
  notify({ type: 'step', at, id: 'a', job: 0, index: 0, steps: 2, section: 'steps', step: 'app.fresh' });
  assert.equal(notify.beat(), true);
  assert.equal(notify.beat(), true);
  const values = sent.map((s) => s.progress);
  assert.deepEqual(values, [0, 0.5, 0.501, 0.502]);
  assert.match(sent.at(-1)!.message!, /│ a steps · step 1\/2/);
  // A case ending still moves it past the beats.
  notify({ type: 'case-end', at, id: 'a', job: 0, attempt: 1, result: 'passed', ms: 100 });
  assert.equal(sent.at(-1)!.progress, 1);
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

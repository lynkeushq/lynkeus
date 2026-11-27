import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { ciLanes, resultsOf, summaryOf } from '../commands/ci.js';

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

test('with cases.targets, CI runs each case on its declared headless and FastSim targets, lists device ones, and says which it cannot start', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lk-ci-lanes-')));
  const kits = fs.mkdtempSync(path.join(os.tmpdir(), 'lk-ci-kits-'));
  const kit = path.join(kits, '2026.11.17', 'darwin-arm64-ios');
  fs.mkdirSync(path.join(kit, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(kit, 'share'), { recursive: true });
  fs.writeFileSync(path.join(kit, '.sha256'), 'x');
  fs.writeFileSync(path.join(kit, 'share', 'platform'), 'ios');
  fs.writeFileSync(path.join(kit, 'bin', 'fastsim-run'), '');
  const bundle = path.join(root, '.lynkeus', 'fastsim-ios');
  fs.mkdirSync(bundle, { recursive: true });
  fs.writeFileSync(path.join(bundle, 'host.args'), '--platform ios\n');
  fs.writeFileSync(path.join(bundle, 'app.hbc'), '');
  fs.mkdirSync(path.join(root, 'cases'));
  const a = path.join(root, 'cases', 'a.md');
  const b = path.join(root, 'cases', 'b.md');
  fs.writeFileSync(a, '---\nid: a\n---\nsteps:\n  - app.wait: "#go"\n');
  fs.writeFileSync(b, '---\nid: b\ntargets: [ios, headless]\n---\nsteps:\n  - app.wait: "#go"\n');
  const headless = 'LYNKEUS_PORT={port} lynkeus headless start';

  assert.equal(ciLanes([a, b], { root, config: {}, headless, kits }), undefined);
  const plan = ciLanes([a, b], { root, config: { cases: { targets: ['fastsim:ios', 'fastsim:android', 'headless'] } }, headless, kits });
  assert.ok(plan && typeof plan !== 'string');
  assert.deepEqual(
    plan.lanes.map((l) => [l.target, l.files.map((f) => path.basename(f)), l.ownHosts]),
    [
      ['fastsim:ios', ['a.md'], true],
      ['headless', ['a.md', 'b.md'], false],
    ],
  );
  assert.equal(plan.lanes[0]!.hostCommand, `${JSON.stringify(path.join(kit, 'bin', 'fastsim-run'))} ${JSON.stringify(bundle)} {port}`);
  assert.equal(plan.lanes[1]!.hostCommand, headless);
  assert.deepEqual(plan.device, ['ios (1 case file(s))']);
  assert.equal(plan.missing.length, 1);
  assert.match(plan.missing[0]!, /^fastsim:android \(1 case file\(s\)\): not installed: `lynkeus fastsim install --platform android`/);

  // A configured host command that starts no FastSim is the project's own headless host.
  const own = ciLanes([a], { root, config: { cases: { targets: ['headless'] }, ci: { hosts: { command: 'docker run app {port}' } } }, headless, kits });
  assert.ok(own && typeof own !== 'string');
  assert.deepEqual(
    own.lanes.map((l) => [l.hostCommand, l.ownHosts]),
    [['docker run app {port}', true]],
  );
  assert.match(String(ciLanes([a], { root, config: { cases: { targets: ['web'] } }, headless, kits })), /web is not a target/);
});

test('a summary of several targets links each target’s report', () => {
  const s = summaryOf(
    [{ id: 'a (headless)', result: 'passed' }],
    [
      { label: 'headless', url: 'https://lynkeus.io/r/h' },
      { label: 'fastsim:ios', url: 'https://lynkeus.io/r/f' },
    ],
    'All 1 case files.',
  );
  assert.match(s, /\[Open the headless report\]\(https:\/\/lynkeus\.io\/r\/h\) · \[Open the fastsim:ios report\]\(https:\/\/lynkeus\.io\/r\/f\)/);
});

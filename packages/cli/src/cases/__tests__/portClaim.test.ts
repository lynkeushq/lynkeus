import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { claimPorts } from '../portClaim.js';

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-ports-'));

test('a port another live run holds is refused, naming the port and the run', async () => {
  const at = dir();
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)']);
  try {
    fs.writeFileSync(path.join(at, 'lynkeus-port-8124.pid'), String(other.pid));
    const claim = claimPorts([8123, 8124], at);
    assert.ok('refused' in claim);
    assert.match(claim.refused, new RegExp(`port 8124 is held by another lynkeus case run \\(pid ${other.pid}\\)`));
    // What it took before the refusal is let go.
    assert.equal(fs.existsSync(path.join(at, 'lynkeus-port-8123.pid')), false);
  } finally {
    other.kill();
  }
});

test('a claim left by a run that is gone is taken over, and released at the end', () => {
  const at = dir();
  const file = path.join(at, 'lynkeus-port-8123.pid');
  fs.writeFileSync(file, '999999');
  const claim = claimPorts([8123], at);
  assert.ok('release' in claim);
  assert.equal(fs.readFileSync(file, 'utf8'), String(process.pid));
  claim.release();
  assert.equal(fs.existsSync(file), false);
});

test('a port another run of this same process drives is refused, naming that run, until it lets go', () => {
  const at = dir();
  const first = claimPorts([8125], at, 'login, started 10:00:00');
  assert.ok('release' in first);
  const second = claimPorts([8125], at, 'signup');
  assert.ok('refused' in second);
  assert.equal(
    second.refused,
    'port 8125 is driving the app for another case run of this Lynkeus, still going: login, started 10:00:00. Wait for it (case status), or stop it (case stop; case_stop over MCP), then run again',
  );
  first.release();
  const third = claimPorts([8125], at, 'signup');
  assert.ok('release' in third);
  third.release();
});

test("runs of this process on a port's other apps go on side by side; a run that drives any app there waits for both", () => {
  const at = dir();
  const file = path.join(at, 'lynkeus-port-8131.pid');
  const ios = claimPorts([8131], at, 'ios run', 'ios');
  const android = claimPorts([8131], at, 'android run', 'android');
  assert.ok('release' in ios && 'release' in android);
  const again = claimPorts([8131], at, 'another', 'ios');
  assert.ok('refused' in again);
  assert.match(again.refused, /ios run/);
  const any = claimPorts([8131], at, 'plain run');
  assert.ok('refused' in any);
  ios.release();
  assert.equal(fs.existsSync(file), true);
  assert.ok('refused' in claimPorts([8131], at, 'plain run'));
  android.release();
  assert.equal(fs.existsSync(file), false);
  const plain = claimPorts([8131], at, 'plain run');
  assert.ok('release' in plain);
  const shared = claimPorts([8131], at, 'ios run', 'ios');
  assert.ok('refused' in shared);
  assert.match(shared.refused, /plain run/);
  plain.release();
});

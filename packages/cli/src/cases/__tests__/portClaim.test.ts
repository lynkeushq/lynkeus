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

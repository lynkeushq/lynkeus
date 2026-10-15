import assert from 'node:assert/strict';
import { test } from 'node:test';

import { agentMismatch, appSwitched, CLI_VERSION, helloIdentity } from '../device/agentVersion.js';

test('an agent of the CLI release is not worth a word', () => {
  assert.equal(agentMismatch({ agentVersion: CLI_VERSION }), undefined);
});

test('an agent of another release, or one too old to say, is named with how to line the two up', () => {
  assert.match(agentMismatch({ agentVersion: '0.1.9' }, '0.2.1')!, /lynkeus-agent 0\.1\.9, this CLI is lynkeus 0\.2\.1.*lynkeus-agent@0\.2\.1/);
  assert.match(agentMismatch({}, '0.2.1')!, /too old to say its version, this CLI is lynkeus 0\.2\.1/);
});

test('a different app taking the port over is told once, a relaunch of the same one is not', () => {
  const a = helloIdentity({ platform: 'ios', native: false, app: { name: 'lynkeus-main', runtime: 'headless' } });
  const b = helloIdentity({ platform: 'ios', native: false, app: { name: 'login-qa', runtime: 'headless' } });
  assert.equal(a, 'lynkeus-main (ios, headless)');
  assert.equal(appSwitched(undefined, a, 8790), undefined);
  assert.equal(appSwitched(a, a, 8790), undefined);
  assert.match(appSwitched(a, b, 8790)!, /port 8790: lynkeus-main \(ios, headless\) gave way to login-qa \(ios, headless\)/);
});

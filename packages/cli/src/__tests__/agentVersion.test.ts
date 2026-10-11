import assert from 'node:assert/strict';
import { test } from 'node:test';

import { agentMismatch, CLI_VERSION } from '../device/agentVersion.js';

test('an agent of the CLI release is not worth a word', () => {
  assert.equal(agentMismatch({ agentVersion: CLI_VERSION }), undefined);
});

test('an agent of another release, or one too old to say, is named with how to line the two up', () => {
  assert.match(agentMismatch({ agentVersion: '0.1.9' }, '0.2.1')!, /lynkeus-agent 0\.1\.9, this CLI is lynkeus 0\.2\.1.*lynkeus-agent@0\.2\.1/);
  assert.match(agentMismatch({}, '0.2.1')!, /too old to say its version, this CLI is lynkeus 0\.2\.1/);
});

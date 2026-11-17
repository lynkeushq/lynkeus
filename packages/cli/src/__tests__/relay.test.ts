import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createRelaySession } from '../commands/relay.js';

test('an insecure relay URL is rejected before the API key can be sent', async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    throw new Error('must not send credentials');
  };
  await assert.rejects(createRelaySession('http://example.test', 'secret', 900, '/api/mobile/', fetchImpl), /TLS/);
  await assert.rejects(createRelaySession('https://user:pass@example.test', 'secret', 900, '/api/mobile/', fetchImpl), /credentials/);
  assert.equal(called, false);
});

test('a valid relay service creates a session without following redirects', async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    request = { url: String(input), init };
    return new Response(JSON.stringify({ token: `relay_${'a'.repeat(64)}`, expiresAt: '2026-11-15T01:00:00Z' }), { status: 201 });
  };
  const response = await createRelaySession('https://lynkeus.io', 'secret', 900, '/api/mobile/', fetchImpl);
  assert.equal(response.status, 201);
  assert.equal(request?.init?.redirect, 'manual');
  assert.equal(request?.init?.method, 'POST');
});

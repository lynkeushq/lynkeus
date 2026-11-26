import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cacheFor } from '../commands/headless.js';

test('a host started against another API base gets a jest cache of its own', () => {
  const local = cacheFor('/app', { API_URL: 'http://localhost:3020/api/mobile' }, 'API_URL');
  assert.equal(local, cacheFor('/app', { API_URL: 'http://localhost:3020/api/mobile', OTHER: 'x' }, 'API_URL'));
  assert.notEqual(local, cacheFor('/app', { API_URL: 'http://localhost:3000/api/mobile' }, 'API_URL'));
  assert.notEqual(local, cacheFor('/app', {}, 'API_URL'));
  // An app that reads no address from the environment has one cache, whatever the environment holds.
  assert.equal(cacheFor('/app', { API_URL: 'a' }), cacheFor('/app', { API_URL: 'b' }));
  assert.notEqual(cacheFor('/app', { BACKEND: 'a' }, 'BACKEND'), cacheFor('/app', { BACKEND: 'b' }, 'BACKEND'));
  assert.match(local, /^\/app\/\.lynkeus\/jest-cache\/[0-9a-f]{12}$/);
});

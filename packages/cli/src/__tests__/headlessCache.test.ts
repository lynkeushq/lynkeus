import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cacheFor } from '../commands/headless.js';

test('a host started against another API base gets a jest cache of its own', () => {
  const local = cacheFor('/app', { API_URL: 'http://localhost:3020/api/mobile' });
  assert.equal(local, cacheFor('/app', { API_URL: 'http://localhost:3020/api/mobile', OTHER: 'x' }));
  assert.notEqual(local, cacheFor('/app', { API_URL: 'http://localhost:3000/api/mobile' }));
  assert.notEqual(local, cacheFor('/app', {}));
  assert.notEqual(cacheFor('/app', { BACKEND: 'a' }, 'BACKEND'), cacheFor('/app', { BACKEND: 'b' }, 'BACKEND'));
  assert.match(local, /^\/app\/\.lynkeus\/jest-cache\/[0-9a-f]{12}$/);
});

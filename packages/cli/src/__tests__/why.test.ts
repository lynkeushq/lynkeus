import assert from 'node:assert/strict';
import { test } from 'node:test';

import { duringCommand } from '../runtime.js';

test("a failure's evidence is the requests made while the command ran, not minutes before", () => {
  const now = 1_800_000_000_000;
  const old = { id: 1, startedAt: now - 5 * 60_000 };
  const recent = { id: 2, startedAt: now - 1500 };
  assert.deepEqual(duringCommand([old, recent], now - 1000, now), [recent]);
  // A host on a clock of its own (fastsim's virtual time) keeps them all.
  const virtual = [{ id: 1, startedAt: 5_000 }];
  assert.deepEqual(duringCommand(virtual, now - 1000, now), virtual);
  assert.deepEqual(duringCommand([old], undefined, now), [old]);
});

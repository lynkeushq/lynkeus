import assert from 'node:assert/strict';
import { test } from 'node:test';

import { liveCommands } from '../cases/liveCommands.js';

const device = (connected: boolean, call: () => Promise<{ commands: string[] }>) => ({ server: { connected, call } });

test('a command registered after the first hello is there for has:', async () => {
  const d = device(true, async () => ({ commands: ['press', 'session'] }));
  assert.deepEqual(await liveCommands(d, ['press']), ['press', 'session']);
});

test('without an app, or when it does not answer, the hello is what is known', async () => {
  assert.deepEqual(
    await liveCommands(
      device(false, async () => ({ commands: ['x'] })),
      ['press'],
    ),
    ['press'],
  );
  assert.deepEqual(
    await liveCommands(
      device(true, async () => Promise.reject(new Error('timeout'))),
      ['press'],
    ),
    ['press'],
  );
});

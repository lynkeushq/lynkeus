import assert from 'node:assert/strict';
import { test } from 'node:test';

import { liveCommands } from '../cases/liveCommands.js';

const device = (connected: boolean, call: () => Promise<{ commands: string[] }>) => ({ server: { connected, call } });

test('a command registered after the first hello is there for has:', async () => {
  const d = device(true, async () => ({ commands: ['press', 'session'] }));
  assert.deepEqual(await liveCommands(d, { commands: ['press'] }), ['press', 'session']);
});

test('without an app, or when it does not answer, the hello is what is known', async () => {
  assert.deepEqual(
    await liveCommands(
      device(false, async () => ({ commands: ['x'] })),
      { commands: ['press'] },
    ),
    ['press'],
  );
  assert.deepEqual(
    await liveCommands(
      device(true, async () => Promise.reject(new Error('timeout'))),
      { commands: ['press'] },
    ),
    ['press'],
  );
});

test('the same hello is asked once, a new one again', async () => {
  let pings = 0;
  const d = device(true, async () => ({ commands: [`n${++pings}`] }));
  const hello = { commands: ['press'] };
  assert.deepEqual(await liveCommands(d, hello), ['n1']);
  assert.deepEqual(await liveCommands(d, hello), ['n1']);
  assert.deepEqual(await liveCommands(d, { commands: ['press'] }), ['n2']);
  assert.equal(pings, 2);
});

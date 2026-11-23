import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { AgentServer } from 'lynkeus-client';
import type { Screen } from 'lynkeus-protocol';

import { createAdapter, spawnWire, startLink } from '../index.js';

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'example', 'fake-exact.mjs');
const token = 'exact-test-token';

const attach = async (appToken: string) => {
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const server = new AgentServer({ port, token });
  await server.listen();
  const wire = spawnWire(process.execPath, [fake]);
  const stop = startLink(createAdapter(wire, { platform: 'linux' }), { port, token: appToken });
  return {
    server,
    done: async () => {
      stop();
      wire.close();
      await server.close();
    },
  };
};

test('a driver attaches to an Exact host with the token, reads the screen and presses, as with any app', async () => {
  const { server, done } = await attach(token);
  try {
    const hello = await server.waitForApp(5000);
    assert.equal(hello.platform, 'linux');
    assert.equal(hello.native, true);
    assert.deepEqual(hello.commands, ['clock']);
    const screen = (await server.call('screen')) as Screen;
    assert.ok(screen.elements.some((e) => e.testId === 'increment'));
    await server.call('press', { testId: 'increment' });
    const after = (await server.call('screen')) as Screen;
    assert.equal(after.elements.find((e) => e.testId === 'count')?.text, 'Count: 1');
    const clock = (await server.call('clock', { advanceMs: 1500 })) as { advancedMs: number };
    assert.equal(clock.advancedMs, 1500);
  } finally {
    await done();
  }
});

test('an Exact host with another token never attaches', async () => {
  const { server, done } = await attach('some-other-token');
  try {
    await assert.rejects(server.waitForApp(1500), /No app attached/);
  } finally {
    await done();
  }
});

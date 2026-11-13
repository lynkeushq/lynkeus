import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';

import { hostLost } from '../commands/cases.js';

const server = (connected: boolean, attachesWithin?: number) => ({
  connected,
  waitForApp: (ms: number) =>
    attachesWithin !== undefined && attachesWithin <= ms ? Promise.resolve({}) : Promise.reject(new Error(`No app attached within ${ms}ms`)),
});

test('a host that exited is lost, whatever the server last knew', async () => {
  const host = spawn(process.execPath, ['-e', 'process.exit(3)']);
  await once(host, 'exit');
  assert.match((await hostLost(host, server(true))) ?? '', /^exited \(3\)/);
});

test('a running host is lost only when its app is not attached and does not come back in time', async () => {
  const host = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)']);
  try {
    assert.equal(await hostLost(host, server(true)), undefined);
    // An app that redials after a reload is not a lost host.
    assert.equal(await hostLost(host, server(false, 100), 5000), undefined);
    assert.equal(await hostLost(host, server(false), 50), 'is running but its app is not attached');
    assert.equal(await hostLost(host, server(false)), 'is running but its app is not attached');
    // No driver yet to ask: nothing to say about the app.
    assert.equal(await hostLost(host, undefined), undefined);
  } finally {
    host.kill();
  }
});

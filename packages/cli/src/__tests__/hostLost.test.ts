import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';

import { agentSilent, heapPast, hostLost, selfHeadlessCommand, startsHeadless } from '../commands/cases.js';

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

test('a host past a share of its heap limit is named with how full it is', () => {
  assert.equal(heapPast({ heapUsedMb: 2500, heapLimitMb: 4144 }, 60), '2500 MB of 4144 MB');
  assert.equal(heapPast({ heapUsedMb: 2400, heapLimitMb: 4144 }, 60), undefined);
  // A host that does not say its limit is taken at 4 GB.
  assert.equal(heapPast({ heapUsedMb: 2500 }, 60), '2500 MB of 4096 MB');
  assert.equal(heapPast({ heapUsedMb: 2400 }, 60), undefined);
  // Nothing measured, nothing to say.
  assert.equal(heapPast(undefined, 60), undefined);
  assert.equal(heapPast({}, 60), undefined);
});

test('a running host whose app never attached names the agent, not a dev build', async () => {
  const unattached = {
    result: 'failed' as const,
    steps: [{ step: 'app.press #go', status: 'failed' as const, ms: 1, error: 'No app attached on 127.0.0.1:9301 within 15000ms.' }],
  };
  const host = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)']);
  try {
    assert.match(agentSilent(unattached, host) ?? '', /no Lynkeus agent dialed in/);
    // A case that failed on its own checks says nothing about the agent.
    assert.equal(agentSilent({ result: 'failed', steps: [{ step: 'app.see Hi', status: 'failed', ms: 1, error: 'not on screen' }] }, host), undefined);
    assert.equal(agentSilent(unattached, undefined), undefined);
    // A headless host always runs the agent: the bundle is never the reason there.
    const headless = agentSilent(unattached, host, true) ?? '';
    assert.match(headless, /another port/);
    assert.doesNotMatch(headless, /agent off/);
  } finally {
    host.kill();
  }
  await once(host, 'exit');
  // A host that exited has its own words (hostLost); this is only for one still running.
  assert.equal(agentSilent(unattached, host), undefined);
});

test('a host command that starts headless is told from one that does not', () => {
  assert.equal(startsHeadless('LYNKEUS_PORT={port} npx -y lynkeus headless start'), true);
  assert.equal(startsHeadless(selfHeadlessCommand()), true);
  assert.match(selfHeadlessCommand(), /^LYNKEUS_PORT=\{port\} /);
  assert.equal(startsHeadless('/opt/fastsim/bin/fastsim-run bundle {port}'), false);
  assert.equal(startsHeadless(undefined), false);
});

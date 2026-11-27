import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { AgentServer } from 'lynkeus-client';
import type { Element, Screen } from 'lynkeus-protocol';

import { parseCase } from '../cases/format.js';
import { runCase } from '../cases/runner.js';
import { crawl, describeCrawl } from '../commands/crawl.js';
import { driveCommands } from '../commands/drive.js';
import { Device } from '../device/driver.js';
import type { PlatformLifecycle } from '../device/platform.js';
import { type Base, register } from '../registry.js';

register(driveCommands);

const button = (i: number, testId: string, y: number): Element => ({
  i,
  kind: 'button',
  testId,
  frame: { x: 100, y, w: 200, h: 40 },
  enabled: true,
  depth: 1,
});

type Launch = { appId: string; fresh: boolean };

/**
 * A phone's app as the driver sees it: a showroom screen whose Community control opens a link, which puts the
 * browser in front. While the app is in the background it answers nothing, as a suspended app does.
 */
const phoneApp = (options: { opensWith: 'url' | 'appstate'; comesBack?: boolean }) => {
  const server = Object.assign(new EventEmitter(), {
    connected: true,
    appState: 'active' as string,
    hello: { event: 'hello', protocolVersion: 1, platform: 'ios', native: true, commands: [] },
    port: 8123,
    listen: async () => undefined,
    waitForApp: async () => server.hello,
    call: async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
      if (server.appState === 'background') throw new Error(`${method} timed out after 2800ms: the app went to the background (another app is in front)`);
      calls.push(method === 'press' ? `press ${String(params?.testId)}` : method);
      if (method === 'screen') return screen;
      if (method === 'find') return screen.elements.find((e) => e.testId === params?.testId || e.text === params?.text) ?? null;
      if (method === 'trace') return { last: 0, events: [] };
      if (method === 'requests') return { inFlight: 0, requests: [] };
      if (method === 'waitFor') return { passed: true };
      // The agent waits for the screen to go quiet before it answers; the OS takes about as long to put another app up.
      if (method === 'idle') {
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (server.appState === 'background') throw new Error('idle timed out after 2800ms: the app went to the background (another app is in front)');
        return {};
      }
      if (method === 'navigate' || method === 'back') return {};
      if (method === 'press') {
        if (params?.testId !== 'community-slack') return { x: 0, y: 0, mode: 'native' };
        setTimeout(() => goAway(), 5);
        return { x: 0, y: 0, mode: 'native', ...(options.opensWith === 'url' ? { opened: 'https://community.infinite.red' } : {}) };
      }
      return null;
    },
  });
  const calls: string[] = [];
  const goAway = () => {
    server.appState = 'background';
    server.emit('appstate', { event: 'appstate', state: 'background' });
  };
  const screen: Screen = {
    route: 'Demo.Community',
    path: ['Demo', 'Demo.Community'],
    elements: [
      button(0, 'community-slack', 200),
      button(1, 'community-about', 300),
      { i: 2, kind: 'text', text: 'Join the community', frame: { x: 20, y: 100, w: 300, h: 20 }, enabled: true, depth: 1 },
    ],
    commit: 1,
    busy: false,
    window: { w: 400, h: 800 },
    costMs: 1,
  };
  const launches: Launch[] = [];
  const lifecycle: PlatformLifecycle = {
    launchApp: async (_device, appId, fresh) => {
      launches.push({ appId, fresh });
      if (!fresh && options.comesBack === false) return;
      setTimeout(() => {
        server.appState = 'active';
        server.emit('appstate', { event: 'appstate', state: 'active' });
      }, 5);
    },
    screenshot: async () => undefined,
    recordVideo: async () => {
      throw new Error('not filmed here');
    },
    freezeChrome: async () => undefined,
  };
  const device = new Device({ id: 'sim-1', name: 'iPhone', platform: 'ios', type: 'simulator', connected: true } as never, {
    server: server as unknown as AgentServer,
    appId: 'com.example.ignite',
    lifecycle,
  });
  return { device, server, calls, launches, goAway };
};

const outDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-crawl-'));

for (const opensWith of ['url', 'appstate'] as const) {
  test(`a crawl press that opens another app (${opensWith === 'url' ? 'a link' : 'no link, only AppState'}) is a transition out, never pressed again, and the app comes back`, async () => {
    const { device, calls, launches } = phoneApp({ opensWith });
    const { transitions } = await crawl({ device, outDir: outDir(), depth: 1, maxActions: 20 });
    const out = transitions.find((t) => t.button.testId === 'community-slack');
    assert.equal(out?.to, 'outside');
    assert.deepEqual(out?.problems, []);
    assert.equal(out?.outside?.opened, opensWith === 'url' ? 'https://community.infinite.red' : undefined);
    assert.equal(out?.toRoute, undefined, 'no edge is learned to a screen of another app');
    // Brought back as it was (simctl launch without terminating), not relaunched.
    assert.deepEqual(launches, [{ appId: 'com.example.ignite', fresh: false }]);
    assert.equal(calls.filter((c) => c === 'press community-slack').length, 1);
    assert.ok(calls.includes('press community-about'), 'the crawl went on with the next control');
    assert.equal(device.inBackground, false);
  });
}

test('the app is relaunched only when bringing it back to the front does not work', async () => {
  const { device, launches, goAway } = phoneApp({ opensWith: 'url', comesBack: false });
  goAway();
  assert.equal(await device.foreground(50), 'relaunched');
  assert.deepEqual(launches, [
    { appId: 'com.example.ignite', fresh: false },
    { appId: 'com.example.ignite', fresh: true },
  ]);
  assert.equal(device.inBackground, false);
});

test('without the app id there is no bringing it back, and the error says where to give it', async () => {
  const { server } = phoneApp({ opensWith: 'url' });
  server.appState = 'background';
  const device = new Device({ id: 'sim-1', name: 'iPhone', platform: 'ios' } as never, { server: server as unknown as AgentServer });
  await assert.rejects(device.foreground(), /set app in lynkeus\.config\.json, or pass --app/);
});

test('the id the app said in its hello brings it back when none was configured, and the configured one wins', async () => {
  const { server, launches } = phoneApp({ opensWith: 'url' });
  (server as unknown as { hello: object }).hello = { ...(server as unknown as { hello: object }).hello, appId: 'com.example.said' };
  const info = { id: 'sim-1', name: 'iPhone', platform: 'ios' } as never;
  const said = new Device(info, { server: server as unknown as AgentServer });
  assert.equal(said.appId, 'com.example.said');
  assert.equal(new Device(info, { server: server as unknown as AgentServer, appId: 'com.example.given' }).appId, 'com.example.given');
  assert.equal(launches.length, 0);
});

test('a crawl that starts with the app in the background brings it to the front first', async () => {
  const { device, launches, goAway } = phoneApp({ opensWith: 'url' });
  goAway();
  await crawl({ device, outDir: outDir(), depth: 1, maxActions: 1 });
  assert.deepEqual(launches[0], { appId: 'com.example.ignite', fresh: false });
});

test("a crawl's answer names what a press opened outside the app", () => {
  const text = describeCrawl({
    transitions: [
      {
        from: 'k',
        fromRoute: 'Demo.Community',
        button: { testId: 'community-slack' },
        to: 'outside',
        ms: 1,
        problems: [],
        outside: { opened: 'https://community.infinite.red' },
      },
    ],
    learned: [],
    reinforced: 0,
    seconds: 3,
    spent: false,
    outDir: '/tmp/crawl',
  });
  assert.match(text, /left the app \(brought back; not pressed again\)\n {4}Demo\.Community #community-slack → https:\/\/community\.infinite\.red/);
  assert.match(text, /0 problems/);
});

test('a host never counts as in the background, whatever its AppState says', () => {
  const server = Object.assign(new EventEmitter(), { appState: 'background', hello: { native: true, commands: ['clock'] } });
  const device = new Device({ id: 'headless', name: 'fastsim', platform: 'ios' } as never, { server: server as unknown as AgentServer });
  assert.equal(device.inBackground, false);
});

const baseFor = (device: Device): Base => ({
  root: outDir(),
  config: {},
  attached: true,
  err: () => undefined,
  graph: () => {
    throw new Error('no graph');
  },
  device: async () => device,
});

test('a case that leaves the app behind the browser is the one that fails for it, and the next case starts with the app in front', async () => {
  const { device, launches } = phoneApp({ opensWith: 'url' });
  const base = baseFor(device);
  const leaves = parseCase(
    '---\nid: opens-slack\n---\nsteps:\n  - app.press: "#community-slack"\n  - app.see: { text: "Join the community" }\n',
    'opens-slack.md',
  );
  const next = parseCase('---\nid: reads-community\n---\nsteps:\n  - app.see: { text: "Join the community" }\n', 'reads-community.md');
  const lines: string[] = [];
  const first = await runCase(leaves, { base, config: {}, log: (line) => lines.push(line) });
  assert.equal(first.result, 'failed');
  assert.match(first.diagnosis?.join('\n') ?? '', /this case left the app in the background: a press opened https:\/\/community\.infinite\.red/);
  assert.deepEqual(launches, []);
  const second = await runCase(next, { base, config: {}, log: (line) => lines.push(line) });
  assert.equal(second.result, 'passed', JSON.stringify(second.steps));
  assert.deepEqual(launches, [{ appId: 'com.example.ignite', fresh: false }]);
  assert.ok(
    lines.some((l) => /brought it back to the front$/.test(l)),
    lines.join('\n'),
  );
});

test('a case that starts with the app in front asks the OS for nothing', async () => {
  const { device, launches } = phoneApp({ opensWith: 'url' });
  const report = await runCase(parseCase('---\nid: plain\n---\nsteps:\n  - app.see: { text: "Join the community" }\n', 'plain.md'), {
    base: baseFor(device),
    config: {},
  });
  assert.equal(report.result, 'passed');
  assert.deepEqual(launches, []);
});

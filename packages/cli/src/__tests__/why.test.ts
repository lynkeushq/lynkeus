import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { Device } from '../device/driver.js';
import type { ScreenGraph } from '../knowledge/types.js';
import type { Base } from '../registry.js';
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

test('a failed check of a text names the closest text on screen and the uncommitted line that changed it', async () => {
  const { runCase } = await import('../cases/runner.js');
  const { parseCase } = await import('../cases/format.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-why-'));
  try {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    fs.mkdirSync(path.join(root, 'app'));
    const en = (title: string) => `const en = {\n  demoCommunityScreen: {\n    title: "${title}",\n  },\n}\nexport default en\n`;
    fs.writeFileSync(path.join(root, 'app', 'en.ts'), en('Community'));
    git('init', '-q');
    git('add', '.');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'app');
    fs.writeFileSync(path.join(root, 'app', 'en.ts'), en('Meet the community'));
    const elements = [
      { i: 0, kind: 'text', text: 'Meet the community', frame: { x: 0, y: 0, w: 100, h: 20 }, enabled: true, depth: 1, tag: 1 },
      { i: 1, kind: 'button', text: 'Podcasts', frame: { x: 0, y: 40, w: 100, h: 20 }, enabled: true, depth: 1, tag: 2 },
    ];
    const device = {
      server: { connected: true, hello: null, port: 19_999, call: async () => null },
      screen: async () => ({ route: 'Community', path: ['Community'], commit: 1, busy: false, window: { w: 390, h: 844 }, costMs: 1, elements }),
      trace: async () => ({ last: 0, events: [] }),
      requests: async () => ({ inFlight: 0, requests: [] }),
      waitFor: async () => undefined,
      idle: async () => ({ idle: true }),
      command: async () => ({}),
    } as unknown as Device;
    const base: Base = { root, config: {}, attached: true, err: () => undefined, graph: () => ({}) as ScreenGraph, device: async () => device };
    const c = parseCase('---\nid: demo-tabs\n---\nsteps:\n  - app.see: { target: "Community", timeoutMs: 50 }\n', 'demo-tabs.md');
    const report = await runCase(c, { base, config: {} });
    assert.equal(report.result, 'failed');
    assert.equal(
      report.evidence?.why,
      '  • "Community" is not on screen; "Meet the community" is (the text may have changed)\n    app/en.ts:3 changed it in the working tree: title: "Community", → title: "Meet the community",',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an absent check of something still in a list is unsupported headless, where nothing leaves a window; outside a list it fails', async () => {
  const { runCase } = await import('../cases/runner.js');
  const { parseCase } = await import('../cases/format.js');
  const elements = [
    { i: 0, kind: 'scroll', frame: { x: 0, y: 0, w: 390, h: 844 }, enabled: true, depth: 1, tag: 1 },
    { i: 1, kind: 'text', text: 'Renders a boolean input.', frame: { x: 0, y: 2000, w: 300, h: 20 }, enabled: true, depth: 2, tag: 2, parent: 0 },
    { i: 2, kind: 'text', text: 'Invalid email', frame: { x: 0, y: 100, w: 300, h: 20 }, enabled: true, depth: 1, tag: 3 },
  ];
  const device = {
    server: { connected: true, hello: { platform: 'ios', native: false, commands: [] }, port: 19_998, call: async () => null },
    screen: async () => ({ route: 'DemoShowroom', path: ['DemoShowroom'], commit: 1, busy: false, window: { w: 390, h: 844 }, costMs: 1, elements }),
    trace: async () => ({ last: 0, events: [] }),
    requests: async () => ({ inFlight: 0, requests: [] }),
    waitFor: async () => undefined,
    idle: async () => ({ idle: true }),
    command: async () => [],
  } as unknown as Device;
  const base: Base = { root: os.tmpdir(), config: {}, attached: true, err: () => undefined, graph: () => ({}) as ScreenGraph, device: async () => device };
  const inList = await runCase(
    parseCase('---\nid: showroom\n---\nsteps:\n  - app.see: { text: "Renders a boolean input.", absent: true, timeoutMs: 50 }\n', 'showroom.md'),
    {
      base,
      config: {},
    },
  );
  assert.equal(inList.result, 'unsupported');
  assert.match(inList.steps[0]?.error ?? '', /^this host has no window \(headless renders every item of a list and scrolls none, so .*Renders a boolean input/);
  const alone = await runCase(parseCase('---\nid: sign-in\n---\nsteps:\n  - app.see: { text: "Invalid email", absent: true, timeoutMs: 50 }\n', 'sign-in.md'), {
    base,
    config: {},
  });
  assert.equal(alone.result, 'failed');
  assert.match(alone.steps[0]?.error ?? '', /^still on screen/);
});

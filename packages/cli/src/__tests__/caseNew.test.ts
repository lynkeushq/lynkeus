import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { Screen } from 'lynkeus-protocol';

import { coverageCommands } from '../commands/coverage.js';
import type { Device } from '../device/driver.js';
import type { ScreenGraph } from '../knowledge/types.js';
import type { Ctx, Result } from '../registry.js';

const screen = (route: string, file: string, declaredIn = 'app/AppNavigator.tsx') => ({ route, component: route, file, declaredIn });
const facts = (selectors: string[], navigates: { to: string; testId: string }[] = []) => ({
  selectors: selectors.map((id, line) => ({ id, line })),
  navigates: navigates.map((n, line) => ({ to: n.to, line, confidence: 'static' as const, via: { kind: 'testId' as const, testId: n.testId } })),
  imports: [],
});

// Welcome leads to About and to the Demo tabs; nothing leads back out of DemoShowroom.
const graph: ScreenGraph = {
  app: 'shop',
  root: '/app',
  extractedAt: '2026-11-27T00:00:00Z',
  screens: {
    Welcome: screen('Welcome', 'app/Welcome.tsx'),
    About: screen('About', 'app/About.tsx'),
    DemoShowroom: screen('DemoShowroom', 'app/Showroom.tsx'),
  },
  files: {
    'app/Welcome.tsx': facts(['about-button'], [{ to: 'About', testId: 'about-button' }]),
    'app/About.tsx': facts(['about-title', 'about-close'], [{ to: 'Welcome', testId: 'about-close' }]),
    'app/Showroom.tsx': facts([]),
  },
  warnings: [],
};

const caseNew = coverageCommands.find((c) => c.name === 'case new')!;

const run = async (flags: Record<string, unknown>, shown?: string) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lk-case-new-'));
  fs.mkdirSync(path.join(root, '.lynkeus', 'screens'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.lynkeus', 'screens', 'About.json'),
    JSON.stringify({ route: 'About', path: ['About'], seen: 1, date: '2026-11-27', elements: [{ i: 0, kind: 'text', text: 'Version 1.0', depth: 0 }] }),
  );
  const device = { screen: async () => ({ route: shown, elements: [] }) as unknown as Screen } as unknown as Device;
  const ctx = {
    root,
    config: {},
    device: async () => device,
    graph: () => graph,
    err: () => undefined,
    attached: shown !== undefined,
    args: ['about'],
    flags,
    passthrough: [],
  } as unknown as Ctx;
  return ((await caseNew.run(ctx)) as Result).text ?? '';
};

test('case new begins elsewhere when the screen the app shows has no known way, and says where', async () => {
  const text = await run({ to: 'About' }, 'DemoShowroom');
  assert.match(text, /Begins on Welcome: the first screen the navigator declares; no known way from DemoShowroom \(the screen the app shows now\)/);
  assert.match(text, /- app\.press: "#about-button"/);
  assert.doesNotMatch(text, /No known way/);
});

test('an author-named start is kept, even with no known way', async () => {
  const text = await run({ to: 'About', from: 'DemoShowroom' }, 'DemoShowroom');
  assert.match(text, /No known way from DemoShowroom to About/);
});

test('a draft with no case through the screen offers what the source and runs know is on it', async () => {
  const text = await run({ to: 'About' });
  assert.match(text, /# What is on About, from its source \(app\/About\.tsx\) and runs that saw it/);
  assert.match(text, /# - app\.see: "#about-title"/);
  assert.match(text, /# - app\.see: "Version 1\.0"/);
  assert.match(text, /# - app\.press: "#about-close" {4}# leads to Welcome/);
});

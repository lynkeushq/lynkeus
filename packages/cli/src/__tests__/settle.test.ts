import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Element, Screen } from 'lynkeus-protocol';

import { settledScreen, untilUncovered } from '../commands/drive.js';
import type { Device } from '../device/driver.js';

const button = (covered: boolean): Element => ({
  i: 0,
  kind: 'button',
  testId: 'logout',
  frame: { x: 0, y: 0, w: 100, h: 40 },
  enabled: true,
  depth: 0,
  covered,
});
const screenOf = (elements: Element[]): Screen =>
  ({ route: 'Profile', path: ['Profile'], elements, commit: 1, busy: false, window: { w: 390, h: 844 }, costMs: 1 }) as Screen;

const fake = (reads: () => Element) => {
  let looks = 0;
  const device = {
    idle: async () => {
      looks++;
      return { commit: 1, idle: true };
    },
    waitFor: async () => ({ waitedMs: 0 }),
    screen: async () => screenOf([reads()]),
    server: { call: async () => reads() },
  } as unknown as Device;
  return { device, looks: () => looks };
};

test('a pressed screen is printed once the next one has landed, not while its controls still read as covered', async () => {
  let reads = 0;
  // A native transition: everything covered for three reads, then in place.
  const { device } = fake(() => button(++reads <= 3));
  const screen = await settledScreen(device);
  assert.equal(screen.elements[0]?.covered, false);
});

test('a control covered for good does not hold the screen past a transition’s length', async () => {
  const { device } = fake(() => button(true));
  const began = Date.now();
  const screen = await settledScreen(device);
  assert.equal(screen.elements[0]?.covered, true);
  assert.ok(Date.now() - began < 2000, `took ${Date.now() - began} ms`);
});

test('typing into a field waits until nothing covers it', async () => {
  let reads = 0;
  const { device, looks } = fake(() => ({ ...button(++reads <= 2), kind: 'input' }));
  await untilUncovered(device, { testId: 'logout' });
  assert.equal(reads, 3);
  assert.equal(looks(), 2);
});

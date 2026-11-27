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
  let finds = 0;
  const { device, looks } = fake(() => ({ ...button(finds <= 2), kind: 'input' }));
  const find = device.server.call;
  device.server.call = (async (...args: Parameters<typeof find>) => {
    finds++;
    return find(...args);
  }) as typeof find;
  await untilUncovered(device, { testId: 'logout' });
  assert.equal(finds, 3);
  assert.equal(looks(), 2);
});

test('a press waits for a control a screen still slides over, but not for one only the keyboard covers', async () => {
  // Covered for the first two finds; the screen (read for the keyboard) shows no focused field.
  let finds = 0;
  let slid = 0;
  const sliding = {
    idle: async () => {
      slid++;
      return { commit: 1, idle: true };
    },
    waitFor: async () => ({ waitedMs: 0 }),
    screen: async () => screenOf([button(false)]),
    server: { call: async () => button(++finds <= 2) },
  } as unknown as Device;
  await untilUncovered(sliding, { testId: 'logout' });
  assert.equal(slid, 2);

  const field: Element = { ...button(false), i: 1, kind: 'input', testId: 'email', focused: true };
  const looks = { n: 0 };
  const device = {
    idle: async () => {
      looks.n++;
      return { commit: 1, idle: true };
    },
    waitFor: async () => ({ waitedMs: 0 }),
    screen: async () => screenOf([field, button(true)]),
    server: { call: async () => button(true) },
  } as unknown as Device;
  const began = Date.now();
  await untilUncovered(device, { testId: 'logout' });
  assert.equal(looks.n, 0);
  assert.ok(Date.now() - began < 500);
});

test('a press waits no transition out under a view the app did not draw: it stays until someone answers it', async () => {
  let finds = 0;
  const device = {
    idle: async () => ({ commit: 1, idle: true }),
    waitFor: async () => ({ waitedMs: 0 }),
    screen: async () => ({ ...screenOf([button(true)]), system: { frame: { x: 0, y: 0, w: 390, h: 844 } } }),
    server: {
      call: async () => {
        finds++;
        return button(true);
      },
    },
  } as unknown as Device;
  const began = Date.now();
  await untilUncovered(device, { testId: 'logout' });
  assert.equal(finds, 1);
  assert.ok(Date.now() - began < 500, `took ${Date.now() - began} ms`);
});

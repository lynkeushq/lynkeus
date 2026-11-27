import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import type { Element, Screen } from 'lynkeus-protocol';

import { awayAfter, settledScreen, untilUncovered } from '../commands/drive.js';
import type { Device } from '../device/driver.js';
import { awayNote } from '../runtime.js';

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

const phone = (appState: string) => {
  const server = Object.assign(new EventEmitter(), { appState, hello: { native: true, commands: [] } });
  return { device: { server } as unknown as Device, server };
};

test('a press that opens a URL says the app went behind the browser once the app steps back', async () => {
  const { device, server } = phone('active');
  setTimeout(() => {
    server.appState = 'background';
    server.emit('appstate', { event: 'appstate', state: 'background' });
  }, 30);
  const away = await awayAfter(device, 'https://github.com/infinitered/ignite');
  assert.match(away ?? '', /^the app went to the background: it opened https:\/\/github\.com\/infinitered\/ignite, and the browser is in front/);
});

test('a press that leaves the app in front says nothing and waits for nothing', async () => {
  const { device } = phone('active');
  const began = Date.now();
  assert.equal(await awayAfter(device, undefined), undefined);
  assert.ok(Date.now() - began < 50);
});

test('a host never goes to the background, whatever its app state says', async () => {
  const server = Object.assign(new EventEmitter(), { appState: 'background', hello: { native: true, commands: ['clock'] } });
  assert.equal(await awayAfter({ server } as unknown as Device, 'myapp://x'), undefined);
});

test('a system screen over the app on iOS reads as inactive, not as another app', () => {
  assert.match(awayNote({ appState: 'inactive', hello: { native: true, commands: [] } } as never) ?? '', /^the app is inactive: a system screen/);
  assert.match(awayNote({ appState: 'background', hello: { native: true, commands: [] } } as never, 'tel:123') ?? '', /another app is in front/);
});

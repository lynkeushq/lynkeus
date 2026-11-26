import { afterEach, expect, it } from '@jest/globals';

import { enabledByDefault } from '../Lynkeus';

const g = globalThis as { __DEV__?: boolean; __fastsimDevice?: unknown };
const dev = g.__DEV__;

afterEach(() => {
  g.__DEV__ = dev;
  delete g.__fastsimDevice;
});

it('is on in a dev build', () => {
  g.__DEV__ = true;
  expect(enabledByDefault()).toBe(true);
});

it('is off in a release build on a device', () => {
  g.__DEV__ = false;
  expect(enabledByDefault()).toBe(false);
});

it('is on in a release bundle a FastSim host runs', () => {
  g.__DEV__ = false;
  g.__fastsimDevice = { platform: 'ios' };
  expect(enabledByDefault()).toBe(true);
});

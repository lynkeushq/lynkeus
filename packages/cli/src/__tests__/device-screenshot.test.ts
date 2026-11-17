import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AgentServer } from 'lynkeus-client';

import { Device } from '../device/driver.js';

const fakeServer = (commands: string[]) => {
  const calls: { name: string; params: unknown }[] = [];
  const server = {
    hello: { commands },
    call: async (name: string, params: unknown) => {
      calls.push({ name, params });
      return {};
    },
  } as unknown as AgentServer;
  return { server, calls };
};

test('a host that draws the app is asked for its own frame, not the simulator', async () => {
  const { server, calls } = fakeServer(['screenshot', 'session']);
  const device = new Device({ id: 'headless', name: 'fastsim', platform: 'ios', kind: 'simulator' } as never, { server });
  await device.screenshot('/tmp/state.png');
  assert.deepEqual(calls, [{ name: 'screenshot', params: { path: '/tmp/state.png' } }]);
});

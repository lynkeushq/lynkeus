import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Device } from '../device/driver.js';
import { runFlow } from '../flow/runner.js';

// A keypad sliding in: its keys are listed before they can take a press, first disabled, then moving.
const slidingKeypad = (looksUntilReady: number) => {
  const pressed: string[] = [];
  let looks = 0;
  const device = {
    server: {
      connected: false,
      call: async (method: string, params: { testId: string }) => {
        if (method !== 'find') return null;
        looks += 1;
        const y = looks < looksUntilReady ? 900 - looks * 100 : 400;
        return { i: 0, kind: 'button', testId: params.testId, enabled: looks > 1, depth: 0, frame: { x: 0, y, w: 80, h: 80 } };
      },
    },
    idle: async () => ({ commit: looks, idle: true }),
    press: async (params: { testId: string }) => {
      pressed.push(params.testId);
      return { x: 0, y: 0, mode: 'native' };
    },
  } as unknown as Device;
  return { device, pressed };
};

test('a keypad presses each key only once it is enabled and has stopped moving', async () => {
  const { device, pressed } = slidingKeypad(4);
  const report = await runFlow({ name: 'pin', steps: [{ keypad: { digits: '12', pattern: 'numpad-{d}-button' } }] }, { device });
  assert.equal(report.ok, true);
  assert.deepEqual(pressed, ['numpad-1-button', 'numpad-2-button']);
});

test('a keypad key that never settles fails the step and says why', async () => {
  const { device, pressed } = slidingKeypad(Number.POSITIVE_INFINITY);
  const report = await runFlow({ name: 'pin', steps: [{ keypad: { digits: '1', pattern: 'numpad-{d}-button', timeoutMs: 50 } }] }, { device });
  assert.equal(report.ok, false);
  assert.match(report.steps[0]!.error!, /keypad key #numpad-1-button is moving after 50 ms/);
  assert.deepEqual(pressed, []);
});

import { describe, expect, it, jest } from '@jest/globals';

import { forgetMockCalls } from '../index.js';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('a host forgets what its mocks were called with', () => {
  it('clears the record of every jest.fn() on a timer and keeps what each one does', async () => {
    const native = jest.fn((key: string) => `stored ${key}`);
    const once = jest.fn(() => 'default');
    once.mockReturnValueOnce('first');
    for (let i = 0; i < 1000; i++) native('x'.repeat(1000));
    expect(native.mock.calls).toHaveLength(1000);

    const stop = forgetMockCalls(jest, 20);
    await wait(60);
    stop();

    expect(native.mock.calls).toHaveLength(0);
    expect(native.mock.results).toHaveLength(0);
    // The implementation and a queued once-value survive.
    expect(native('k')).toBe('stored k');
    expect(once()).toBe('first');
    expect(once()).toBe('default');
  });

  it('does nothing without a jest that can clear, and stops when told', async () => {
    expect(forgetMockCalls(undefined)()).toBeUndefined();
    const clearAllMocks = jest.fn();
    const stop = forgetMockCalls({ clearAllMocks }, 10);
    await wait(35);
    stop();
    const calls = clearAllMocks.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    await wait(30);
    expect(clearAllMocks.mock.calls.length).toBe(calls);
  });
});

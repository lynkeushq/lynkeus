import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { deferCompletions } from '../mocks/install.js';

describe("reanimated's completions", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('move to the next tick on a mock, and a repeat ends', () => {
    jest.useFakeTimers();
    const done: string[] = [];
    const mock: Record<string, unknown> = {
      withTiming: (to: number, _config: unknown, callback?: (finished: boolean) => void) => {
        callback?.(true);
        return to;
      },
      withRepeat: (animation: unknown) => animation,
      withSequence: () => 0,
    };
    deferCompletions(mock);
    const withTiming = mock.withTiming as (to: number, config: unknown, callback: () => void) => number;
    expect(withTiming(1, {}, () => done.push('timing'))).toBe(1);
    (mock.withRepeat as (a: unknown, t: number, r: boolean, callback: () => void) => unknown)(5, 6, false, () => done.push('repeat'));
    expect(done).toEqual([]);
    jest.runAllTimers();
    expect(done).toEqual(['timing', 'repeat']);
    expect((mock.withSequence as (...a: unknown[]) => unknown)(1, 2, 3)).toBe(3);
  });

  it('leave the real module alone, whose exports are getters', () => {
    const withTiming = () => 1;
    const real = {};
    Object.defineProperty(real, 'withTiming', { enumerable: true, get: () => withTiming });
    deferCompletions(real);
    expect((real as { withTiming: unknown }).withTiming).toBe(withTiming);
  });
});

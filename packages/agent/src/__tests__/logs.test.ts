import { describe, expect, it, jest } from '@jest/globals';

import { readLogs, tapLogs } from '../logs';

describe('console lines', () => {
  it('are kept with their level and still printed', () => {
    const log = jest.fn();
    const error = jest.fn();
    const g = { console: { log, error, warn: jest.fn(), info: jest.fn(), debug: jest.fn() } as unknown as Console };
    expect(tapLogs(g)).toBe(true);
    g.console.log('[session]', 'refreshing', { user: 7 });
    g.console.error(new TypeError('boom'));
    expect(log).toHaveBeenCalledWith('[session]', 'refreshing', { user: 7 });
    expect(error).toHaveBeenCalledTimes(1);
    const lines = readLogs({ take: true });
    expect(lines.map((l) => [l.level, l.text])).toEqual([
      ['info', '[session] refreshing {"user":7}'],
      ['error', 'TypeError: boom'],
    ]);
    expect(lines[1]?.stack).toContain('TypeError: boom');
    expect(readLogs({})).toEqual([]);
    // Wrapped once, however often the agent starts.
    expect(tapLogs(g)).toBe(false);
  });

  it('keep an error nobody caught, and hand it on', () => {
    let handler: (e: unknown, fatal?: boolean) => void = () => undefined;
    const before = jest.fn();
    const g = {
      console: { log: jest.fn() } as unknown as Console,
      ErrorUtils: { getGlobalHandler: () => before, setGlobalHandler: (h: typeof handler) => { handler = h; } },
    };
    tapLogs(g);
    const e = new Error('render failed');
    handler(e, true);
    expect(before).toHaveBeenCalledWith(e, true);
    expect(readLogs({ take: true })).toEqual([expect.objectContaining({ level: 'error', text: 'Uncaught (fatal) Error: render failed' })]);
  });
});

import { describe, expect, it, jest } from '@jest/globals';

import { fabricBackend } from '../backends/fabric';
import { createHandlers, dispatch } from '../handlers';
import { noNavigation } from '../navigation';
import { qa } from '../registry';
import { lastSeq, record } from '../trace';

describe('dispatch', () => {
  const handlers = createHandlers(noNavigation, fabricBackend());

  it('serves core methods and app commands, and refuses the rest', async () => {
    const ping = (await dispatch(handlers, 'ping', undefined)) as { pong: boolean };
    expect(ping.pong).toBe(true);

    const reset = jest.fn(() => 'fresh');
    const off = qa.register('reset', reset);
    expect(await dispatch(handlers, 'reset', { hard: true })).toBe('fresh');
    expect(reset).toHaveBeenCalledWith({ hard: true });
    off();

    await expect(dispatch(handlers, 'nope', undefined)).rejects.toThrow(/Unknown method/);
  });

  it('runs a batch in order and stops at the first error', async () => {
    const calls = [{ method: 'ping' }, { method: 'nope' }, { method: 'ping' }];
    await expect(dispatch(handlers, 'batch', { calls })).rejects.toThrow(/Unknown method/);
    const ok = (await dispatch(handlers, 'batch', { calls: [{ method: 'ping' }, { method: 'ping' }] })) as {
      results: unknown[];
    };
    expect(ok.results).toHaveLength(2);
  });

  it('counts a route reached after `since` and already left', async () => {
    const since = lastSeq();
    record({ kind: 'route', route: 'Pay.Success', path: ['Pay', 'Pay.Success'] });
    record({ kind: 'route', route: 'Pay.MoneySent', path: ['Pay', 'Pay.MoneySent'] });
    const passed = (await dispatch(handlers, 'waitFor', { route: 'Pay.Success', since, timeoutMs: 200 })) as { passed?: boolean };
    expect(passed.passed).toBe(true);
    await expect(dispatch(handlers, 'waitFor', { route: 'Pay.Success', since: lastSeq(), timeoutMs: 100 })).rejects.toThrow(/Timed out/);
  });
});

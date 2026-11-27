import { describe, expect, it } from '@jest/globals';

import { jsAge, watchFastRefresh } from '../jsAge';

describe('jsAge', () => {
  it('says how long ago the bundle loaded, and since when a Fast Refresh last applied an edit', () => {
    const before = jsAge();
    expect(before.loadedMs).toBeGreaterThanOrEqual(0);
    expect(before.refreshedMs).toBeUndefined();
    let calls = 0;
    const settings = {
      onFastRefresh() {
        calls++;
      },
    };
    watchFastRefresh(settings);
    settings.onFastRefresh();
    expect(calls).toBe(1);
    const now = Date.now();
    const after = jsAge(now + 500);
    expect(after.refreshedMs).toBeGreaterThanOrEqual(500);
    expect(after.refreshedMs).toBeLessThan(after.loadedMs + 1);
  });
});

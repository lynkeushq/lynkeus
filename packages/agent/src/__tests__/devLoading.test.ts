import { describe, expect, it } from '@jest/globals';

import { devLoadingShowing, watchDevLoading } from '../devLoading';

describe('the development banner', () => {
  it('is up from showMessage until a moment after hide, and the module still does its work', () => {
    const calls: string[] = [];
    const view = {
      showMessage(message: unknown) {
        calls.push(`show ${String(message)}`);
      },
      hide() {
        calls.push('hide');
      },
    };
    watchDevLoading(view);
    expect(devLoadingShowing()).toBe(false);
    view.showMessage('Refreshing...');
    const shown = Date.now();
    expect(devLoadingShowing(shown)).toBe(true);
    // One nobody hides stops counting.
    expect(devLoadingShowing(shown + 6000)).toBe(false);
    view.hide();
    const hidden = Date.now();
    // Still sliding away.
    expect(devLoadingShowing(hidden + 100)).toBe(true);
    expect(devLoadingShowing(hidden + 1000)).toBe(false);
    expect(calls).toEqual(['show Refreshing...', 'hide']);
  });
});

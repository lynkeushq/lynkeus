import { describe, expect, it, jest } from '@jest/globals';

import { readSdkCalls, tapSdks } from '../sdks';

describe('analytics SDK calls', () => {
  it('are kept from the SDKs’ modules and still reach them', () => {
    const track = jest.fn(() => Promise.resolve());
    const logEvent = jest.fn();
    const modules = { MixpanelReactNative: { track, identify: jest.fn() }, RNAppsFlyer: { logEvent }, Other: { x: jest.fn() } };
    expect(tapSdks(modules)).toBe(2);
    (modules.MixpanelReactNative.track as (...a: unknown[]) => unknown)('token', 'Sign Up', { method: 'phone' });
    (modules.RNAppsFlyer.logEvent as (...a: unknown[]) => unknown)('af_login', { channel: 'apple' });
    expect(track).toHaveBeenCalledWith('token', 'Sign Up', { method: 'phone' });
    expect(logEvent).toHaveBeenCalledWith('af_login', { channel: 'apple' });
    expect(readSdkCalls({ take: true })).toEqual([
      { sdk: 'mixpanel', name: 'Sign Up', properties: { method: 'phone' } },
      { sdk: 'appsflyer', name: 'af_login', properties: { channel: 'apple' } },
    ]);
    expect(readSdkCalls({})).toEqual([]);
    // Wrapped once, however often the agent starts.
    expect(tapSdks(modules)).toBe(0);
  });

  it('keeps every call of a crash, RUM or support SDK, named as fastsim names it', () => {
    const addAction = jest.fn();
    const modules = {
      DdRum: { addAction, getCurrentSessionId: jest.fn(), constant: 1 },
      RNSentry: { addBreadcrumb: jest.fn(), fetchNativeRelease: jest.fn() },
      IntercomModule: { logEvent: jest.fn() },
    };
    expect(tapSdks(modules)).toBe(3);
    (modules.DdRum.addAction as (...a: unknown[]) => unknown)('TAP', 'Continue', { screen: 'Intro' }, 12);
    (modules.DdRum.getCurrentSessionId as (...a: unknown[]) => unknown)();
    (modules.RNSentry.addBreadcrumb as (...a: unknown[]) => unknown)({ category: 'navigation', message: 'Home' });
    (modules.RNSentry.fetchNativeRelease as (...a: unknown[]) => unknown)();
    (modules.IntercomModule.logEvent as (...a: unknown[]) => unknown)('opened_help', { from: 'pin' });
    expect(addAction).toHaveBeenCalledWith('TAP', 'Continue', { screen: 'Intro' }, 12);
    expect(readSdkCalls({ take: true })).toEqual([
      { sdk: 'datadog', name: 'addAction: TAP', properties: { screen: 'Intro' } },
      { sdk: 'sentry', name: 'addBreadcrumb', properties: { category: 'navigation', message: 'Home' } },
      { sdk: 'intercom', name: 'logEvent: opened_help', properties: { from: 'pin' } },
    ]);
  });

  it('leaves a module it cannot change alone', () => {
    const frozen = Object.freeze({ track: () => undefined });
    expect(tapSdks({ MixpanelReactNative: frozen })).toBe(0);
  });
});

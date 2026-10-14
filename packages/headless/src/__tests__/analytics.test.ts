import { describe, expect, it } from '@jest/globals';
import { host } from 'lynkeus-agent';
import { NativeModules } from 'react-native';

import { installAnalytics } from '../mocks/analytics.js';

type Native = Record<string, (...args: unknown[]) => unknown>;
const analytics = (params?: unknown) => (host.get('analytics') as (p: unknown) => { sdk: string; name: string }[])(params);

describe('analytics SDKs', () => {
  it('records what the app sends each SDK, by SDK, and hands it over once', () => {
    installAnalytics();
    (NativeModules.MixpanelReactNative as Native).track!('token', 'View Screen - Home', { 'Screen Name': 'Home' });
    (NativeModules.RNAppsFlyer as Native).logEvent!('af_login', { method: 'google' });
    (NativeModules.DdRum as Native).startView!('home', 'Home', {});
    (NativeModules.RNSentry as Native).captureEnvelope!('{"event_id":"1"}');
    expect(analytics({ take: true }).map((e) => [e.sdk, e.name])).toEqual([
      ['mixpanel', 'View Screen - Home'],
      ['appsflyer', 'af_login'],
      ['datadog', 'startView: home'],
      ['sentry', 'captureEnvelope: {"event_id":"1"}'],
    ]);
    expect(analytics({})).toEqual([]);
  });

  it('leaves alone a module the app already mocks', () => {
    const own = { track: () => 'mine' };
    (NativeModules as Record<string, unknown>).MixpanelReactNative = own;
    installAnalytics();
    expect(NativeModules.MixpanelReactNative).toBe(own);
  });
});

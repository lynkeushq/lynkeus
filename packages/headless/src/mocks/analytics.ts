// What the app tells its analytics, crash and attribution SDKs, kept per SDK. In Node an SDK's native half
// does not exist, so its calls land here instead: nothing is sent anywhere, and the `analytics` command hands
// them to the driver, which files each under the step that caused it. The same module names as fastsim's.
import { qa } from 'lynkeus-agent';

import { onReset } from '../runtime.js';

export type SentEvent = { sdk: string; name: string; properties?: Record<string, unknown> };

const sent: SentEvent[] = [];
const KEEP = 5000;

export const noteEvent = (sdk: string, name: unknown, properties?: unknown): void => {
  sent.push({
    sdk,
    name: String(name),
    ...(properties && typeof properties === 'object' && !Array.isArray(properties) ? { properties: properties as Record<string, unknown> } : {}),
  });
  if (sent.length > KEEP) sent.shift();
};

type Calls = Record<string | symbol, unknown>;

/**
 * A native module whose every call is an event: the method, with its first text argument when it has one,
 * and its last plain object as the properties. Promises resolve, so an SDK that awaits its native side goes on.
 */
const recorded = (sdk: string): Calls =>
  new Proxy({} as Calls, {
    get: (_target, method) => {
      if (typeof method !== 'string' || method === 'then' || method === '$$typeof') return undefined;
      if (method === 'getConstants') return () => ({});
      if (method === 'addListener' || method === 'removeListeners') return () => undefined;
      return (...args: unknown[]) => {
        const text = args.find((a): a is string => typeof a === 'string');
        const properties = [...args].reverse().find((a) => a && typeof a === 'object' && !Array.isArray(a));
        noteEvent(sdk, text === undefined ? method : `${method}: ${text.slice(0, 120)}`, properties);
        return Promise.resolve();
      };
    },
  });

// The SDKs whose first argument is not the event: Mixpanel passes its token first, AppsFlyer the name.
const mixpanel = (): Calls => {
  const calls: Calls = {
    track: (_token: string, name: string, properties?: unknown) => noteEvent('mixpanel', name, properties),
    trackWithGroups: (_token: string, name: string, properties?: unknown) => noteEvent('mixpanel', name, properties),
    identify: (_token: string, id: string) => {
      noteEvent('mixpanel', '$identify', { distinct_id: id });
      return Promise.resolve();
    },
    reset: () => noteEvent('mixpanel', '$reset'),
  };
  return new Proxy(calls, { get: (target, key) => target[key] ?? (typeof key === 'string' && key !== 'then' ? () => Promise.resolve() : undefined) });
};

const appsFlyer = (): Calls => {
  const calls: Calls = { logEvent: (name: string, values?: unknown) => noteEvent('appsflyer', name, values) };
  return new Proxy(calls, { get: (target, key) => target[key] ?? (typeof key === 'string' && key !== 'then' ? () => Promise.resolve() : undefined) });
};

/** Native module name → what stands in for it. A module the app or the preset already provides is left alone. */
export const ANALYTICS_MODULES: Record<string, () => Calls> = {
  MixpanelReactNative: mixpanel,
  RNAppsFlyer: appsFlyer,
  IntercomModule: () => recorded('intercom'),
  RNSentry: () => recorded('sentry'),
  DdSdk: () => recorded('datadog'),
  DdRum: () => recorded('datadog'),
  DdLogs: () => recorded('datadog'),
  DdTrace: () => recorded('datadog'),
  RNFBAnalyticsModule: () => recorded('firebase'),
  RNFBCrashlyticsModule: () => recorded('crashlytics'),
  AmplitudeReactNative: () => recorded('amplitude'),
  BrazeReactBridge: () => recorded('braze'),
  RNBranch: () => recorded('branch'),
  Adjust: () => recorded('adjust'),
  BugsnagReactNative: () => recorded('bugsnag'),
  CleverTapReact: () => recorded('clevertap'),
  OneSignal: () => recorded('onesignal'),
  RNOneSignal: () => recorded('onesignal'),
};

export const installAnalytics = (): string[] => {
  const rn = require('react-native') as {
    NativeModules: Record<string, unknown>;
    TurboModuleRegistry?: { get?: (name: string) => unknown; getEnforcing?: (name: string) => unknown };
  };
  const standing: Record<string, Calls> = {};
  for (const [name, make] of Object.entries(ANALYTICS_MODULES)) {
    if (rn.NativeModules[name]) continue;
    standing[name] = make();
    rn.NativeModules[name] = standing[name];
  }
  // A new-architecture SDK asks the registry rather than NativeModules.
  const registry = rn.TurboModuleRegistry;
  if (registry?.get) {
    const get = registry.get.bind(registry);
    registry.get = (name: string) => get(name) ?? standing[name] ?? null;
  }
  if (registry?.getEnforcing) {
    const getEnforcing = registry.getEnforcing.bind(registry);
    registry.getEnforcing = (name: string) => standing[name] ?? getEnforcing(name);
  }
  onReset(() => {
    sent.length = 0;
  });
  // The same command fastsim answers: what the app sent since the last `{ take: true }`.
  qa.register('analytics', (params) => {
    const out = sent.slice();
    if ((params as { take?: boolean } | undefined)?.take) sent.length = 0;
    return out;
  });
  return Object.keys(standing);
};

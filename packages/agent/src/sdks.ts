// What the app tells its analytics, crash and support SDKs, on any host: a simulator, an emulator or a phone. The SDKs' JavaScript
// calls their native modules; each call is kept here and goes on to the SDK as it would have. fastsim and the
// headless host record the same calls in their stand-ins for those modules; the `analytics` command reads them
// the same way from all three.
type Native = Record<string, unknown>;
export type SdkCall = { sdk: string; name: string; properties?: Record<string, unknown> };

const sent: SdkCall[] = [];
const KEEP = 5000;

const note = (sdk: string, name: unknown, properties?: unknown) => {
  if (typeof name !== 'string' || !name) return;
  sent.push({
    sdk,
    name,
    ...(properties && typeof properties === 'object' && !Array.isArray(properties) ? { properties: properties as Record<string, unknown> } : {}),
  });
  if (sent.length > KEEP) sent.shift();
};

type Read = (args: unknown[]) => [unknown, unknown?];

// A call to an SDK with no event of its own (a breadcrumb, a RUM action, a log line), named as fastsim names it: the
// method, then its first text argument; its last object argument as the properties.
const asCall =
  (method: string): Read =>
  (args) => {
    const text = args.find((a) => typeof a === 'string') as string | undefined;
    const properties = [...args].reverse().find((a) => !!a && typeof a === 'object' && !Array.isArray(a));
    return [text === undefined ? method : `${method}: ${text.slice(0, 120)}`, properties];
  };

// Reads that answer the SDK something (its release, the device's context) and the event emitter's bookkeeping.
const QUIET = /^(get|fetch|is|has|addListener$|removeListeners$|getConstants$)/;

const everyCall = (module: Native): Record<string, Read> =>
  Object.fromEntries(Object.keys(module).flatMap((method) => (typeof module[method] === 'function' && !QUIET.test(method) ? [[method, asCall(method)]] : [])));

// Module → method → what the call says: the event and its properties. Mixpanel passes its token first. `every`:
// each of the module's calls is kept, for SDKs whose calls are not events (crash reporting, RUM, support chat).
const TAPS: Record<string, { sdk: string; methods?: Record<string, Read>; every?: true }> = {
  MixpanelReactNative: {
    sdk: 'mixpanel',
    methods: {
      track: (a) => [a[1], a[2]],
      trackWithGroups: (a) => [a[1], a[2]],
      identify: (a) => ['$identify', { distinct_id: a[1] }],
      reset: () => ['$reset'],
    },
  },
  RNAppsFlyer: { sdk: 'appsflyer', methods: { logEvent: (a) => [a[0], a[1]] } },
  RNFBAnalyticsModule: { sdk: 'firebase', methods: { logEvent: (a) => [a[0], a[1]] } },
  RNSentry: { sdk: 'sentry', every: true },
  DdSdk: { sdk: 'datadog', every: true },
  DdRum: { sdk: 'datadog', every: true },
  DdLogs: { sdk: 'datadog', every: true },
  DdTrace: { sdk: 'datadog', every: true },
  IntercomModule: { sdk: 'intercom', every: true },
  RNFBCrashlyticsModule: { sdk: 'crashlytics', every: true },
};

/** Wraps the analytics modules the app has; answers how many it could wrap. */
export const tapSdks = (modules: Record<string, Native | undefined>): number => {
  let tapped = 0;
  for (const [name, { sdk, methods, every }] of Object.entries(TAPS)) {
    const module = modules[name];
    if (!module || (module as { __lynkeusTapped?: boolean }).__lynkeusTapped) continue;
    let any = false;
    for (const [method, read] of Object.entries(every ? everyCall(module) : (methods ?? {}))) {
      const original = module[method];
      if (typeof original !== 'function') continue;
      const wrapped = (...args: unknown[]) => {
        try {
          const [event, properties] = read(args);
          note(sdk, event, properties);
        } catch {}
        return (original as (...a: unknown[]) => unknown).apply(module, args);
      };
      try {
        module[method] = wrapped;
      } catch {}
      // A module the runtime keeps frozen (a TurboModule's host object) cannot be wrapped: its calls stay unseen.
      if (module[method] === wrapped) any = true;
    }
    if (any) {
      try {
        (module as { __lynkeusTapped?: boolean }).__lynkeusTapped = true;
      } catch {}
      tapped += 1;
    }
  }
  return tapped;
};

/** `analytics`: what the SDKs were told, oldest first; `{ take: true }` empties it after reading. */
export const readSdkCalls = (params: unknown): SdkCall[] => {
  const out = [...sent];
  if ((params as { take?: boolean } | undefined)?.take) sent.length = 0;
  return out;
};

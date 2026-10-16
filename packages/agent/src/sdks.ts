// What the app tells its analytics SDKs, on any host: a simulator, an emulator or a phone. The SDKs' JavaScript
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

// Module → method → what the call says: the event and its properties. Mixpanel passes its token first.
const TAPS: Record<string, { sdk: string; methods: Record<string, (args: unknown[]) => [unknown, unknown?]> }> = {
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
};

/** Wraps the analytics modules the app has; answers how many it could wrap. */
export const tapSdks = (modules: Record<string, Native | undefined>): number => {
  let tapped = 0;
  for (const [name, { sdk, methods }] of Object.entries(TAPS)) {
    const module = modules[name];
    if (!module || (module as { __lynkeusTapped?: boolean }).__lynkeusTapped) continue;
    let any = false;
    for (const [method, read] of Object.entries(methods)) {
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

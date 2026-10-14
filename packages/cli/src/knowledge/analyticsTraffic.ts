// The analytics, crash and attribution services an app talks to over HTTP, known by where it sends: a JS
// SDK (Segment, PostHog, Amplitude's browser SDK) never touches a native module, so its events show up only
// as requests. Each request becomes the events its body carries, or one event named after the call.
import type { RequestRecord } from 'lynkeus-protocol';

export type TrafficEvent = { provider: string; name: string; props?: Record<string, unknown> };

type Plain = Record<string, unknown>;
type Reader = (body: unknown, path: string) => TrafficEvent[] | undefined;

const isPlain = (v: unknown): v is Plain => !!v && typeof v === 'object' && !Array.isArray(v);
const plain = (v: unknown): Plain | undefined => (isPlain(v) ? v : undefined);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);

const named = (provider: string, items: unknown[], name: (item: Plain) => unknown, props: (item: Plain) => unknown): TrafficEvent[] =>
  items.filter(isPlain).flatMap((item) => {
    const n = name(item);
    if (typeof n !== 'string' || !n) return [];
    const p = plain(props(item));
    return [{ provider, name: n, ...(p ? { props: p } : {}) }];
  });

const segment: Reader = (body) => {
  const b = plain(body);
  return named(
    'segment',
    list(b?.batch ?? b),
    (i) => i.event ?? (i.type === 'screen' || i.type === 'page' ? `${i.type}: ${i.name}` : i.type),
    (i) => i.properties ?? i.traits,
  );
};
const amplitude: Reader = (body) =>
  named(
    'amplitude',
    list(plain(body)?.events),
    (i) => i.event_type,
    (i) => i.event_properties,
  );
const posthog: Reader = (body) => {
  const b = plain(body);
  return named(
    'posthog',
    list(b?.batch ?? (Array.isArray(body) ? body : b)),
    (i) => i.event,
    (i) => i.properties,
  );
};
const mixpanel: Reader = (body) =>
  named(
    'mixpanel',
    list(body),
    (i) => i.event ?? (i.$set ? '$set' : undefined),
    (i) => i.properties ?? i.$set,
  );

/** Host pattern → the service, and how to read its body when there is a known shape. */
const SERVICES: { host: RegExp; provider: string; read?: Reader }[] = [
  { host: /(^|\.)segment\.(io|com)$/, provider: 'segment', read: segment },
  { host: /(^|\.)amplitude\.com$/, provider: 'amplitude', read: amplitude },
  { host: /(^|\.)posthog\.com$/, provider: 'posthog', read: posthog },
  { host: /(^|\.)mixpanel\.com$/, provider: 'mixpanel', read: mixpanel },
  { host: /(^|\.)sentry\.io$|^sentry\./, provider: 'sentry' },
  { host: /(^|\.)(datadoghq\.(com|eu)|ddog-gov\.com)$/, provider: 'datadog' },
  { host: /(^|\.)app-measurement\.com$|^firebaselogging/, provider: 'firebase' },
  { host: /(^|\.)appsflyer(sdk)?\.com$/, provider: 'appsflyer' },
  { host: /(^|\.)branch\.io$/, provider: 'branch' },
  { host: /(^|\.)braze\.(com|eu)$/, provider: 'braze' },
  { host: /(^|\.)onesignal\.com$/, provider: 'onesignal' },
  { host: /(^|\.)intercom\.(io|com)$/, provider: 'intercom' },
  { host: /(^|\.)bugsnag\.com$/, provider: 'bugsnag' },
  { host: /(^|\.)adjust\.(com|net|world)$/, provider: 'adjust' },
  { host: /(^|\.)clevertap-prod\.com$|(^|\.)wzrkt\.com$/, provider: 'clevertap' },
  { host: /(^|\.)heapanalytics\.com$/, provider: 'heap' },
  { host: /(^|\.)statsig(api)?\.(com|net)$/, provider: 'statsig' },
  { host: /(^|\.)launchdarkly\.com$/, provider: 'launchdarkly' },
];

const parse = (text: string | undefined): unknown => {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    // Mixpanel's classic endpoint sends `data=<base64 JSON>` as a form.
    const data = /(?:^|&)data=([^&]+)/.exec(text)?.[1];
    if (!data) return undefined;
    try {
      const raw = decodeURIComponent(data);
      return JSON.parse(raw.startsWith('[') || raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
    } catch {
      return undefined;
    }
  }
};

/** The service a request went to, when it is one of the known ones. */
export const serviceOf = (url: string): string | undefined => {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return SERVICES.find((s) => s.host.test(host))?.provider;
  } catch {
    return undefined;
  }
};

/** What a step's requests told analytics services: each body's events, or one per call to a service it cannot read. */
export const trafficEvents = (requests: RequestRecord[]): TrafficEvent[] =>
  requests.flatMap((r) => {
    let url: URL;
    try {
      url = new URL(r.url);
    } catch {
      return [];
    }
    const service = SERVICES.find((s) => s.host.test(url.hostname.toLowerCase()));
    if (!service) return [];
    const events = service.read?.(parse(r.request?.body), url.pathname);
    return events?.length ? events : [{ provider: service.provider, name: `${r.method} ${url.pathname}` }];
  });

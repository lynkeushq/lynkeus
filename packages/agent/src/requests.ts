import type { Exchange, RequestRecord } from './protocol';
import { record as trace } from './trace';
import { answer, installNetmock, mockFor } from './netmock';

const KEEP = 200;
const SENSITIVE = /(token|key|secret|code|otp|password|pin|session|auth)=[^&#]*/gi;

const records: RequestRecord[] = [];
// The test step a driver is running, as W3C trace context: a backend that traces files what it did under it.
let traceparent: string | null = null;

/** The `traceContext` command: `{ traceparent }` for the step about to run, null when the case ends. */
export const setTraceContext = (params: unknown): { traceparent: string | null } => {
  const given = (params as { traceparent?: unknown } | undefined)?.traceparent;
  traceparent = typeof given === 'string' && /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/.test(given) ? given : null;
  return { traceparent };
};
// Ids go on rising when the app reloads its JavaScript (`app.refresh`, a fast refresh): a runner asks for the
// requests after the last id it saw, and a counter back at 1 would answer none for the rest of the case.
let nextId = Date.now() * 1000;
let inFlight = 0;
let installed = false;

// Query strings are kept for their shape (page, filters), never for secrets.
export const redactUrl = (url: string): string => url.replace(SENSITIVE, '$1=…');

// Bodies are kept only while a driver asks for them: a test run's report shows what was sent and answered.
let keepBodies = false;
const MOST = 16_000;
const SECRET_KEY = /pass(word|code)?|^pin$|pin_?code|otp|^code$|token|secret|authorization|cookie|cvv|cvc|card_?number|pan$|ssn|api_?key/i;

/** The `networkBodies` command: `{ on }` keeps headers and bodies of the requests that follow. */
export const setNetworkBodies = (params: unknown): { bodies: boolean } => {
  keepBodies = (params as { on?: unknown } | undefined)?.on === true;
  return { bodies: keepBodies };
};

const redactValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) && v !== null && typeof v !== 'object' ? '…' : redactValue(v)]));
  return value;
};

/** A body as text a report can show: JSON with its secrets replaced, a form's secret fields too, anything else named. */
export const redactBody = (body: unknown): (Exchange['body'] & {}) | undefined => {
  if (body === undefined || body === null || body === '') return undefined;
  if (typeof body !== 'string') return `[${(body as object).constructor?.name ?? typeof body}]`;
  try {
    return JSON.stringify(redactValue(JSON.parse(body)), null, 2);
  } catch {
    return body.replace(SENSITIVE, '$1=…');
  }
};

export const redactHeaders = (headers: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), SECRET_KEY.test(k) || /^(x-)?(api-)?key$/i.test(k) ? '…' : v]));

const exchange = (headers: Record<string, string>, body: unknown): Exchange => {
  const text = redactBody(body);
  return {
    ...(Object.keys(headers).length ? { headers: redactHeaders(headers) } : {}),
    ...(text !== undefined ? { body: text.length > MOST ? text.slice(0, MOST) : text, ...(text.length > MOST ? { truncated: true } : {}) } : {}),
  };
};

const parseHeaderBlock = (block: string): Record<string, string> =>
  Object.fromEntries(
    block
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const at = line.indexOf(':');
        return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
      }),
  );

// Method, URL, status and duration; headers and bodies only while a driver asked for them.
const track = (method: string, url: string) => {
  const record: RequestRecord = { id: nextId++, method, url: redactUrl(url), startedAt: Date.now() };
  inFlight += 1;
  records.push(record);
  if (records.length > KEEP) records.shift();
  const finish = (status: number, error?: unknown) => {
    inFlight -= 1;
    record.status = status;
    record.ms = Date.now() - record.startedAt;
    if (status === 0) record.error = error instanceof Error ? error.message : 'network error or aborted';
    trace({ kind: 'request', method: record.method, url: record.url, status, ms: record.ms, error: record.error });
  };
  return { record, finish };
};

// Node hosts have a native fetch and no XMLHttpRequest.
const trackFetch = (): void => {
  const g = globalThis as { fetch?: typeof fetch };
  const original = g.fetch;
  if (typeof original !== 'function') return;
  g.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const { record, finish } = track(method.toUpperCase(), url);
    if (traceparent) {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      headers.set('traceparent', traceparent);
      init = { ...init, headers };
    }
    const bodies = keepBodies;
    if (bodies) {
      const headers: Record<string, string> = {};
      new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).forEach((v, k) => {
        headers[k] = v;
      });
      record.request = exchange(headers, init?.body);
    }
    try {
      const response = await original(input, init);
      finish(response.status);
      if (bodies) {
        const headers: Record<string, string> = {};
        response.headers.forEach((v, k) => {
          headers[k] = v;
        });
        // Read from a copy, after the app has its response: the app's own read is never held up.
        response
          .clone()
          .text()
          .then((text) => {
            record.response = exchange(headers, text);
          })
          .catch(() => {
            record.response = exchange(headers, undefined);
          });
      }
      return response;
    } catch (error) {
      finish(0, error);
      throw error;
    }
  }) as typeof fetch;
};

// In React Native every request, fetch included, goes through XMLHttpRequest.
const trackXhr = (): void => {
  const proto = XMLHttpRequest.prototype;
  const open = proto.open;
  const send = proto.send;
  const setHeader = proto.setRequestHeader;
  const opened = new WeakMap<XMLHttpRequest, [method: string, url: string]>();
  const sentHeaders = new WeakMap<XMLHttpRequest, Record<string, string>>();
  proto.open = function (this: XMLHttpRequest, ...args: Parameters<XMLHttpRequest['open']>) {
    opened.set(this, [args[0], String(args[1])]);
    sentHeaders.set(this, {});
    return open.apply(this, args);
  } as typeof proto.open;
  proto.setRequestHeader = function (this: XMLHttpRequest, name: string, value: string) {
    const headers = sentHeaders.get(this);
    if (headers) headers[name] = value;
    return setHeader.call(this, name, value);
  };
  proto.send = function (this: XMLHttpRequest, ...args: Parameters<XMLHttpRequest['send']>) {
    const request = opened.get(this);
    const rule = request ? mockFor(...request) : null;
    if (request) {
      const { record, finish } = track(...request);
      const bodies = keepBodies;
      if (bodies) record.request = exchange(sentHeaders.get(this) ?? {}, args[0]);
      this.addEventListener('loadend', () => {
        finish(this.status);
        if (!bodies) return;
        let body: unknown;
        try {
          body =
            this.responseType === '' || this.responseType === 'text'
              ? this.responseText
              : this.responseType === 'json'
                ? JSON.stringify(this.response)
                : this.response;
        } catch {
          body = undefined;
        }
        record.response = exchange(parseHeaderBlock(this.getAllResponseHeaders?.() ?? ''), body);
      });
      if (traceparent) {
        try {
          this.setRequestHeader('traceparent', traceparent);
        } catch {
          // A request already sent by hand takes no more headers; it goes untraced.
        }
      }
    }
    if (rule && request && answer(this, rule, request[1])) return;
    return send.apply(this, args);
  } as typeof proto.send;
};

export const trackRequests = (): void => {
  if (installed) return;
  installed = true;
  installNetmock();
  if (typeof XMLHttpRequest === 'undefined') trackFetch();
  else trackXhr();
};

export const recentRequests = (since?: number): RequestRecord[] => (since === undefined ? [...records] : records.filter((r) => r.id > since));

export const requestsInFlight = (): number => inFlight;

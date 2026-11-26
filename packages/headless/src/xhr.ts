// React Native gives every app an XMLHttpRequest; jest's node environment has none, so an import that touches it
// (Reactotron's network plugin) throws, and axios, finding none, falls back to Node's http module, past the network
// fence and `netmock`. This one runs each request through the global fetch, the one the host fences and mocks.
type Listener = (event: { type: string; target: unknown }) => void;

type FetchResponse = {
  status: number;
  statusText: string;
  url: string;
  headers: { forEach(fn: (value: string, key: string) => void): void };
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
};

const EVENTS = ['readystatechange', 'loadstart', 'progress', 'load', 'error', 'abort', 'timeout', 'loadend'] as const;
type EventName = (typeof EVENTS)[number];

export class FetchXMLHttpRequest {
  static UNSENT = 0;
  static OPENED = 1;
  static HEADERS_RECEIVED = 2;
  static LOADING = 3;
  static DONE = 4;
  UNSENT = 0;
  OPENED = 1;
  HEADERS_RECEIVED = 2;
  LOADING = 3;
  DONE = 4;

  readyState = 0;
  status = 0;
  statusText = '';
  responseURL = '';
  responseText = '';
  response: unknown = '';
  responseType: '' | 'text' | 'json' | 'arraybuffer' | 'blob' | 'document' = '';
  timeout = 0;
  withCredentials = false;
  upload = { addEventListener: () => undefined, removeEventListener: () => undefined };

  onreadystatechange: Listener | null = null;
  onloadstart: Listener | null = null;
  onprogress: Listener | null = null;
  onload: Listener | null = null;
  onerror: Listener | null = null;
  onabort: Listener | null = null;
  ontimeout: Listener | null = null;
  onloadend: Listener | null = null;

  private method = 'GET';
  private url = '';
  private headers: Record<string, string> = {};
  private received: Record<string, string> = {};
  private controller: AbortController | undefined;
  private listeners = new Map<string, Set<Listener>>();

  open(method: string, url: string): void {
    this.method = method.toUpperCase();
    this.url = url;
    this.headers = {};
    this.received = {};
    this.status = 0;
    this.responseText = '';
    this.response = '';
    this.setState(1);
  }

  setRequestHeader(name: string, value: string): void {
    this.headers[name] = this.headers[name] ? `${this.headers[name]}, ${value}` : String(value);
  }

  getResponseHeader(name: string): string | null {
    return this.received[name.toLowerCase()] ?? null;
  }

  getAllResponseHeaders(): string {
    return Object.entries(this.received)
      .map(([key, value]) => `${key}: ${value}\r\n`)
      .join('');
  }

  overrideMimeType(): void {}

  addEventListener(type: string, listener: Listener): void {
    (this.listeners.get(type) ?? this.listeners.set(type, new Set()).get(type)!).add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  abort(): void {
    this.controller?.abort();
  }

  send(body?: unknown): void {
    if (this.readyState !== 1) throw new Error('InvalidStateError: open() before send()');
    const fetchImpl = (globalThis as { fetch?: (url: string, init: object) => Promise<FetchResponse> }).fetch;
    const controller = new AbortController();
    this.controller = controller;
    let timedOut = false;
    const timer =
      this.timeout > 0
        ? setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, this.timeout)
        : undefined;
    this.emit('loadstart');
    if (!fetchImpl) {
      this.fail('error');
      return;
    }
    const sent = ['GET', 'HEAD'].includes(this.method) ? undefined : (body ?? undefined);
    fetchImpl(this.url, { method: this.method, headers: this.headers, body: sent, signal: controller.signal })
      .then(async (res) => {
        this.status = res.status;
        this.statusText = res.statusText;
        this.responseURL = res.url || this.url;
        res.headers.forEach((value, key) => {
          this.received[key.toLowerCase()] = value;
        });
        this.setState(2);
        this.setState(3);
        if (this.responseType === 'arraybuffer') {
          this.response = await res.arrayBuffer();
        } else {
          this.responseText = await res.text();
          this.response = this.responseType === 'json' ? parseOrNull(this.responseText) : this.responseText;
        }
        clearTimeout(timer);
      })
      .then(
        // Outside the catch: an app's handler that throws is its own error, not a failed request.
        () => {
          this.setState(4);
          this.emit('load');
          this.emit('loadend');
        },
        () => {
          clearTimeout(timer);
          this.fail(timedOut ? 'timeout' : controller.signal.aborted ? 'abort' : 'error');
        },
      );
  }

  private fail(kind: 'error' | 'abort' | 'timeout') {
    this.status = 0;
    this.setState(4);
    this.emit(kind);
    this.emit('loadend');
  }

  private setState(state: number) {
    this.readyState = state;
    this.emit('readystatechange');
  }

  private emit(type: EventName) {
    const event = { type, target: this };
    this[`on${type}`]?.call(this, event);
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const parseOrNull = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

export const installXMLHttpRequest = (): boolean => {
  const g = globalThis as { XMLHttpRequest?: unknown };
  if (g.XMLHttpRequest !== undefined) return false;
  g.XMLHttpRequest = FetchXMLHttpRequest;
  return true;
};

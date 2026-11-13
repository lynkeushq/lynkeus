import { describe, expect, it, jest } from '@jest/globals';

import { redactUrl } from '../requests';

describe('redactUrl', () => {
  it('keeps the shape of a query string but hides secrets', () => {
    expect(redactUrl('https://api/x?page=2&token=abc&otp=123456#f')).toBe('https://api/x?page=2&token=…&otp=…#f');
  });
});

describe('the trace context', () => {
  it('goes on every request the app sends while a step runs, and off when the case ends', () => {
    const sent: (string | null)[] = [];
    class FakeXhr {
      private headers = new Map<string, string>();
      open(_method: string, _url: string) {}
      setRequestHeader(name: string, value: string) {
        this.headers.set(name, value);
      }
      addEventListener() {}
      send() {
        sent.push(this.headers.get('traceparent') ?? null);
      }
    }
    const g = globalThis as unknown as { XMLHttpRequest?: unknown };
    const before = g.XMLHttpRequest;
    g.XMLHttpRequest = FakeXhr;
    jest.isolateModules(() => {
      const { setTraceContext, trackRequests } = require('../requests') as typeof import('../requests');
      trackRequests();
      const tp = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
      expect(setTraceContext({ traceparent: tp })).toEqual({ traceparent: tp });
      const a = new FakeXhr();
      a.open('GET', '/a');
      a.send();
      expect(setTraceContext({ traceparent: null })).toEqual({ traceparent: null });
      const b = new FakeXhr();
      b.open('GET', '/b');
      b.send();
      // Anything that is not trace context is ignored rather than sent.
      expect(setTraceContext({ traceparent: 'x' })).toEqual({ traceparent: null });
      expect(sent).toEqual([tp, null]);
    });
    g.XMLHttpRequest = before;
  });
});

describe('request ids', () => {
  it('go on rising after the app reloads its JavaScript', () => {
    class FakeXhr {
      open(_method: string, _url: string) {}
      setRequestHeader() {}
      addEventListener() {}
      send() {}
    }
    const g = globalThis as unknown as { XMLHttpRequest?: unknown };
    const before = g.XMLHttpRequest;
    const lastId = () => {
      let id = 0;
      g.XMLHttpRequest = FakeXhr;
      jest.isolateModules(() => {
        const { trackRequests, recentRequests } = require('../requests') as typeof import('../requests');
        trackRequests();
        const x = new FakeXhr();
        x.open('GET', '/user');
        x.send();
        id = recentRequests().at(-1)?.id ?? 0;
      });
      return id;
    };
    // Each isolateModules is the module loaded again, as a reload loads it.
    const first = lastId();
    // A reload takes far longer than a millisecond.
    const now = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 500);
    const afterReload = lastId();
    now.mockRestore();
    g.XMLHttpRequest = before;
    expect(afterReload).toBeGreaterThan(first);
  });
});

describe('request and response bodies', () => {
  it('hides secrets in a JSON body and in headers, and keeps the rest', async () => {
    const { redactBody, redactHeaders } = await import('../requests');
    expect(JSON.parse(redactBody('{"phone":"+5491100000000","otp":"123456","user":{"password":"x","name":"Ana"},"pin":1234}')!)).toEqual({
      phone: '+5491100000000',
      otp: '…',
      user: { password: '…', name: 'Ana' },
      pin: '…',
    });
    expect(redactBody('grant_type=password&password=hunter2&username=ana')).toBe('grant_type=password&password=…&username=ana');
    expect(redactHeaders({ Authorization: 'Bearer abc', 'Content-Type': 'application/json', 'X-Api-Key': 'k' })).toEqual({
      authorization: '…',
      'content-type': 'application/json',
      'x-api-key': '…',
    });
  });

  it('records what an XHR sent and got only while bodies are asked for', () => {
    class FakeXhr {
      status = 0;
      responseType = '';
      responseText = '';
      private listeners: (() => void)[] = [];
      open(_method: string, _url: string) {}
      setRequestHeader(_name: string, _value: string) {}
      getAllResponseHeaders() {
        return 'content-type: application/json\r\nset-cookie: s=1\r\n';
      }
      addEventListener(_event: string, fn: () => void) {
        this.listeners.push(fn);
      }
      send(_body?: unknown) {
        this.status = 200;
        this.responseText = '{"token":"t","ok":true}';
        for (const fn of this.listeners) fn();
      }
    }
    const g = globalThis as unknown as { XMLHttpRequest?: unknown };
    const before = g.XMLHttpRequest;
    g.XMLHttpRequest = FakeXhr;
    jest.isolateModules(() => {
      const { recentRequests, setNetworkBodies, trackRequests } = require('../requests') as typeof import('../requests');
      trackRequests();
      const call = () => {
        const x = new FakeXhr();
        x.open('POST', '/api/login');
        x.setRequestHeader('Content-Type', 'application/json');
        x.send('{"phone":"+54911","password":"p"}');
      };
      call();
      expect(setNetworkBodies({ on: true })).toEqual({ bodies: true });
      call();
      setNetworkBodies({ on: false });
      const [plain, kept] = recentRequests();
      expect(plain?.request).toBeUndefined();
      expect(kept?.request).toEqual({ headers: { 'content-type': 'application/json' }, body: '{\n  "phone": "+54911",\n  "password": "…"\n}' });
      expect(kept?.response).toEqual({ headers: { 'content-type': 'application/json', 'set-cookie': '…' }, body: '{\n  "token": "…",\n  "ok": true\n}' });
    });
    g.XMLHttpRequest = before;
  });
});

describe('a mocked answer', () => {
  it("is marked when the agent's own rule answered it, or when the answer says a mock gave it", async () => {
    // React Native's XMLHttpRequest as far as the agent touches it: the networking module's callbacks end in loadend.
    class FakeXhr {
      status = 0;
      private listeners: (() => void)[] = [];
      private headers: Record<string, string> = {};
      open(_method: string, _url: string) {}
      setRequestHeader() {}
      addEventListener(_name: string, listener: () => void) {
        this.listeners.push(listener);
      }
      getResponseHeader(name: string) {
        return this.headers[name.toLowerCase()] ?? null;
      }
      send() {}
      __didCreateRequest(_id: number) {}
      __didReceiveResponse(_id: number, status: number, headers: Record<string, string> = {}) {
        this.status = status;
        this.headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
      }
      __didReceiveData(_id: number, _data: unknown) {}
      __didCompleteResponse(_id: number, _error: string) {
        for (const listener of this.listeners) listener();
      }
    }
    const g = globalThis as unknown as { XMLHttpRequest?: unknown };
    const before = g.XMLHttpRequest;
    g.XMLHttpRequest = FakeXhr;
    try {
      await jest.isolateModulesAsync(async () => {
        const { trackRequests, recentRequests } = require('../requests') as typeof import('../requests');
        const { traceSince } = require('../trace') as typeof import('../trace');
        const { host } = require('../registry') as typeof import('../registry');
        trackRequests();
        await host.get('netmock')!({ method: 'GET', path: '/v3/limit', status: 500, times: 1 });

        const ours = new FakeXhr();
        ours.open('GET', 'http://localhost:3000/api/mobile/v3/limit');
        ours.send();
        // A layer below the app (the headless fence, a host's netmock) says so on the answer.
        const below = new FakeXhr();
        below.open('GET', 'http://localhost:3000/api/mobile/v3/other');
        below.send();
        below.__didReceiveResponse(1, 500, { 'X-Lynkeus-Mocked': '1' });
        below.__didCompleteResponse(1, '');
        const server = new FakeXhr();
        server.open('GET', 'http://localhost:3000/api/mobile/v3/real');
        server.send();
        server.__didReceiveResponse(2, 500);
        server.__didCompleteResponse(2, '');
        await new Promise((resolve) => setTimeout(resolve, 10));

        const byPath = Object.fromEntries(recentRequests().map((r) => [r.url.split('/v3/')[1], [r.status, r.mocked ?? false]]));
        expect(byPath).toEqual({ limit: [500, true], other: [500, true], real: [500, false] });
        const traced = Object.fromEntries(traceSince().flatMap((e) => (e.kind === 'request' ? [[e.url.split('/v3/')[1], e.mocked ?? false]] : [])));
        expect(traced).toEqual({ limit: true, other: true, real: false });
      });
    } finally {
      g.XMLHttpRequest = before;
    }
  });

  it('is marked on a Node host when the fence answered it or lost its answer', async () => {
    const g = globalThis as unknown as { XMLHttpRequest?: unknown; fetch?: unknown };
    const beforeXhr = g.XMLHttpRequest;
    const beforeFetch = g.fetch;
    delete g.XMLHttpRequest;
    g.fetch = async (url: string) => {
      if (url.endsWith('/lost')) throw Object.assign(new TypeError('Network request failed'), { lynkeusMocked: true });
      if (url.endsWith('/down')) throw new TypeError('fetch failed');
      return { status: 500, headers: new Headers(url.endsWith('/mocked') ? { 'x-lynkeus-mocked': '1' } : {}) };
    };
    try {
      await jest.isolateModulesAsync(async () => {
        const { trackRequests, recentRequests } = require('../requests') as typeof import('../requests');
        trackRequests();
        const fetch = g.fetch as (url: string) => Promise<unknown>;
        await fetch('http://localhost:3000/mocked');
        await fetch('http://localhost:3000/real');
        await expect(fetch('http://localhost:3000/lost')).rejects.toThrow('Network request failed');
        await expect(fetch('http://localhost:3000/down')).rejects.toThrow('fetch failed');
        expect(recentRequests().map((r) => [r.url.split('3000/')[1], r.mocked ?? false])).toEqual([
          ['mocked', true],
          ['real', false],
          ['lost', true],
          ['down', false],
        ]);
      });
    } finally {
      g.XMLHttpRequest = beforeXhr;
      g.fetch = beforeFetch;
    }
  });
});

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

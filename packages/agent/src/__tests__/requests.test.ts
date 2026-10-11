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

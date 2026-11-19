import { describe, expect, it, jest } from '@jest/globals';

describe('netmock on a device', () => {
  it("answers a matching request from its rule through React Native's XMLHttpRequest callbacks, and sends the rest", async () => {
    const sent: string[] = [];
    // The callbacks React Native's networking module calls on its XMLHttpRequest.
    class RnXhr {
      responseType = '';
      status = 0;
      responseText = '';
      done = false;
      private id = 0;
      private url = '';
      open(_method: string, url: string) {
        this.url = url;
      }
      setRequestHeader() {}
      addEventListener() {}
      getAllResponseHeaders() {
        return '';
      }
      send() {
        sent.push(this.url);
      }
      __didCreateRequest(id: number) {
        this.id = id;
      }
      __didReceiveResponse(id: number, status: number) {
        if (id === this.id) this.status = status;
      }
      __didReceiveData(id: number, data: string) {
        if (id === this.id) this.responseText = data;
      }
      __didCompleteResponse(id: number) {
        if (id === this.id) this.done = true;
      }
    }
    const g = globalThis as unknown as { XMLHttpRequest?: unknown };
    const before = g.XMLHttpRequest;
    g.XMLHttpRequest = RnXhr;
    try {
      await jest.isolateModulesAsync(async () => {
        const { trackRequests } = require('../requests') as typeof import('../requests');
        const { host } = require('../registry') as typeof import('../registry');
        trackRequests();
        const netmock = host.get('netmock')!;
        await netmock({ method: 'GET', path: '/v3/activities', status: 200, body: { items: [] }, times: 1 });

        const mocked = new RnXhr();
        mocked.open('GET', 'http://localhost:3000/api/mobile/v3/activities?page=1');
        mocked.send();
        await new Promise((r) => setTimeout(r, 5));
        expect(mocked).toMatchObject({ status: 200, responseText: '{"items":[]}', done: true });

        // Used once: the next one goes to the network, as does any other path.
        const again = new RnXhr();
        again.open('GET', 'http://localhost:3000/api/mobile/v3/activities?page=1');
        again.send();
        const other = new RnXhr();
        other.open('GET', 'http://localhost:3000/api/mobile/v3/user');
        other.send();
        expect(sent).toEqual(['http://localhost:3000/api/mobile/v3/activities?page=1', 'http://localhost:3000/api/mobile/v3/user']);
      });
    } finally {
      g.XMLHttpRequest = before;
    }
  });

  it('sends a request whose answer is lost, and reports it as failed whatever the server answered', async () => {
    const sent: string[] = [];
    class RnXhr {
      status = 0;
      error = '';
      done = false;
      private id = 0;
      private url = '';
      open(_method: string, url: string) {
        this.url = url;
      }
      setRequestHeader() {}
      addEventListener() {}
      getAllResponseHeaders() {
        return '';
      }
      send() {
        sent.push(this.url);
        // The networking module answers the request it sent.
        this.__didCreateRequest(7);
        this.__didReceiveResponse(7, 201);
        this.__didReceiveData(7, '{}');
        this.__didCompleteResponse(7, '');
      }
      __didCreateRequest(id: number) {
        this.id = id;
      }
      __didReceiveResponse(id: number, status: number) {
        if (id === this.id) this.status = status;
      }
      __didReceiveData(_id: number, _data: string) {}
      __didCompleteResponse(id: number, error: string) {
        if (id !== this.id) return;
        this.error = error;
        this.done = true;
      }
    }
    const g = globalThis as unknown as { XMLHttpRequest?: unknown };
    const before = g.XMLHttpRequest;
    g.XMLHttpRequest = RnXhr;
    try {
      await jest.isolateModulesAsync(async () => {
        const { trackRequests } = require('../requests') as typeof import('../requests');
        const { host } = require('../registry') as typeof import('../registry');
        trackRequests();
        await host.get('netmock')!({ method: 'POST', path: '/v3/social/identities', lost: true, times: 1 });

        const lost = new RnXhr();
        lost.open('POST', 'http://localhost:3000/api/mobile/v3/social/identities');
        lost.send();
        expect(sent).toEqual(['http://localhost:3000/api/mobile/v3/social/identities']);
        expect(lost).toMatchObject({ status: 0, error: 'Network request failed', done: true });
      });
    } finally {
      g.XMLHttpRequest = before;
    }
  });

  it('holds a matching request until it is released, then sends it or answers it from its rule', async () => {
    const sent: string[] = [];
    class RnXhr {
      responseType = '';
      status = 0;
      responseText = '';
      readyState = 1;
      private id = 0;
      private url = '';
      open(_method: string, url: string) {
        this.url = url;
      }
      setRequestHeader() {}
      addEventListener() {}
      getAllResponseHeaders() {
        return '';
      }
      send() {
        sent.push(this.url);
      }
      __didCreateRequest(id: number) {
        this.id = id;
      }
      __didReceiveResponse(id: number, status: number) {
        if (id === this.id) this.status = status;
      }
      __didReceiveData(id: number, data: string) {
        if (id === this.id) this.responseText = data;
      }
      __didCompleteResponse() {}
    }
    const g = globalThis as unknown as { XMLHttpRequest?: unknown };
    const before = g.XMLHttpRequest;
    g.XMLHttpRequest = RnXhr;
    try {
      await jest.isolateModulesAsync(async () => {
        const { trackRequests, requestsInFlight } = require('../requests') as typeof import('../requests');
        const { host } = require('../registry') as typeof import('../registry');
        trackRequests();
        const netmock = host.get('netmock')!;
        await netmock({ action: 'hold', method: 'GET', path: '/v3/activities' });
        await netmock({ method: 'GET', path: '/v3/user', status: 200, body: { name: 'Ana' } });

        const slow = new RnXhr();
        slow.open('GET', 'http://localhost:3000/api/v3/activities?page=1');
        slow.send();
        const free = new RnXhr();
        free.open('GET', 'http://localhost:3000/api/v3/other');
        free.send();
        await new Promise((r) => setTimeout(r, 5));
        // Only the request nobody held went out; the held one is still counted as in flight.
        expect(sent).toEqual(['http://localhost:3000/api/v3/other']);
        expect(requestsInFlight()).toBe(2);
        expect(await netmock({ action: 'list' })).toMatchObject({ held: [{ method: 'GET', path: '/api/v3/activities?page=1' }] });

        // A release for another route lets nothing through.
        expect(await netmock({ action: 'release', path: '/v3/user' })).toEqual({ released: 0, held: 1 });
        expect(await netmock({ action: 'release', path: '/v3/activities' })).toEqual({ released: 1, held: 0 });
        await new Promise((r) => setTimeout(r, 5));
        expect(sent).toEqual(['http://localhost:3000/api/v3/other', 'http://localhost:3000/api/v3/activities?page=1']);

        // The hold stays: the next one waits again, and clear lets it go.
        const next = new RnXhr();
        next.open('GET', 'http://localhost:3000/api/v3/activities?page=2');
        next.send();
        await new Promise((r) => setTimeout(r, 5));
        expect(sent).toHaveLength(2);
        await netmock({ action: 'clear' });
        await new Promise((r) => setTimeout(r, 5));
        expect(sent).toHaveLength(3);

        // A request aborted while held is not sent when it is released.
        await netmock({ action: 'hold', path: '/v3/gone' });
        const gone = new RnXhr();
        gone.open('GET', 'http://localhost:3000/api/v3/gone');
        gone.send();
        gone.readyState = 0;
        await netmock({ action: 'release' });
        await new Promise((r) => setTimeout(r, 5));
        expect(sent).toHaveLength(3);
      });
    } finally {
      g.XMLHttpRequest = before;
    }
  });
});

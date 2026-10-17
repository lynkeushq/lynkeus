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
});

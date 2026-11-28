/**
 * An app's own HTTP client, as apps write it (axios, which apisauce wraps), answered by a case's mock on the headless
 * host: through the XMLHttpRequest the host installs and the fetch it fences, never Node's http module. Trial run 12:
 * a case set its mock, then signed in through the app's `reset`, and headless dropped the rule; the request went out.
 */
import { afterEach, beforeAll, describe, expect, it } from '@jest/globals';
import { host } from 'lynkeus-agent';

import { installDefaultMocks } from '../mocks/install';
import { reset } from '../runtime.js';

type Netmock = (params: unknown) => unknown;
const netmock = (params: unknown) => (host.get('netmock') as Netmock)(params);

const FEED = { status: 'ok', items: [{ title: 'RNR 301 - Testing with fixtures' }] };

beforeAll(() => {
  // As a hosted app's entry does: real requests, to this machine only.
  installDefaultMocks({ network: 'real', networkHosts: ['127.0.0.1'] });
});

afterEach(() => {
  netmock({ action: 'clear' });
});

describe('axios on the headless host', () => {
  // Required once the host is set up, as the app's modules are: axios picks its adapter when it loads.
  const api = () => {
    const axios = require('axios') as typeof import('axios').default;
    return axios.create({ baseURL: 'https://api.rss2json.com', timeout: 2000 });
  };

  it('goes through the host’s XMLHttpRequest, so a mock answers it', async () => {
    netmock({ method: 'GET', path: '/v1/api.json', status: 200, body: JSON.stringify(FEED), sticky: true });
    const res = await api().get('/v1/api.json', { params: { rss_url: 'https://feeds.example/x' } });
    expect(res.status).toBe(200);
    expect(res.data).toEqual(FEED);
    expect(res.request).toBeInstanceOf(globalThis.XMLHttpRequest as unknown as new () => unknown);
  });

  it('keeps a case’s rule through an app reset (a sign-in macro calling reset), as a device does', async () => {
    netmock({ method: 'GET', path: '/v1/api.json', status: 200, body: JSON.stringify(FEED), sticky: true });
    reset();
    const res = await api().get('/v1/api.json');
    expect(res.data).toEqual(FEED);
  });

  it('drops a rule set by hand at an app reset, and the fence keeps the request off the internet', async () => {
    netmock({ method: 'GET', path: '/v1/api.json', status: 200, body: JSON.stringify(FEED) });
    reset();
    await expect(api().get('/v1/api.json')).rejects.toMatchObject({ code: 'ERR_NETWORK' });
  });
});

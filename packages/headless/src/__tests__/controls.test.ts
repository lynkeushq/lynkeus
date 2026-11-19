import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { AppState } from 'react-native';
import { host } from 'lynkeus-agent';

import { connectivityControls, installControls, netControls, type NetRule, setSettleProbe } from '../mocks/controls.js';
import { reset } from '../runtime.js';

// Captured before installControls swaps the global for its ControlledDate.
const RealDate = Date;

type Command = (params: unknown) => unknown;
const command = (name: string): Command => {
  const handler = host.get(name);
  if (!handler) throw new Error(`command "${name}" is not registered`);
  return handler as Command;
};

class FakeResponse {
  constructor(
    public body: string | null,
    public init: { status: number; headers?: Record<string, string> },
  ) {}
}

beforeAll(() => {
  installControls();
});

describe('netmock rules', () => {
  const netmock = (params: unknown) => command('netmock')(params) as { rules: number | NetRule[] };

  beforeEach(() => {
    netmock({ action: 'clear' });
  });

  it('a rule with method * answers any method', () => {
    netmock({ path: '/v3/accounts', status: 500 });
    expect(netControls.match('GET', 'https://api.test/v3/accounts?page=1')?.status).toBe(500);
    expect(netControls.match('post', 'https://api.test/v3/accounts')?.status).toBe(500);
  });

  it('a rule with an exact method ignores the others', () => {
    netmock({ method: 'post', path: '/login', status: 401 });
    expect(netControls.match('GET', 'https://api.test/login')).toBeNull();
    expect(netControls.match('POST', 'https://api.test/login')?.status).toBe(401);
  });

  it('a plain path matches as a substring of the request path', () => {
    netmock({ path: 'accounts', status: 404 });
    expect(netControls.match('GET', 'https://api.test/v3/accounts/12')?.status).toBe(404);
    expect(netControls.match('GET', 'https://api.test/v3/cards')).toBeNull();
  });

  it('a path starting with ^ matches as a regex', () => {
    netmock({ path: '^/v3/accounts/\\d+$', status: 404 });
    expect(netControls.match('GET', 'https://api.test/v3/accounts/12')?.status).toBe(404);
    expect(netControls.match('GET', 'https://api.test/v3/accounts/abc')).toBeNull();
  });

  it('the newest rule for a path wins', () => {
    netmock({ path: '/x', status: 500 });
    netmock({ path: '/x', status: 404 });
    expect(netControls.match('GET', 'https://api.test/x')?.status).toBe(404);
  });

  it('a rule with times answers that many requests and then steps aside', () => {
    netmock({ path: '/flaky', status: 500, times: 2 });
    expect(netControls.match('GET', 'https://api.test/flaky')?.status).toBe(500);
    expect(netControls.match('GET', 'https://api.test/flaky')?.status).toBe(500);
    expect(netControls.match('GET', 'https://api.test/flaky')).toBeNull();
  });

  it('list shows the rules and clear drops them all', () => {
    netmock({ path: '/a' });
    netmock({ path: '/b' });
    expect((netmock({ action: 'list' }).rules as NetRule[]).map((r) => r.path)).toEqual(['/b', '/a']);
    expect(netmock({ action: 'clear' }).rules).toBe(0);
    expect(netmock({ action: 'list' }).rules).toEqual([]);
  });

  it('a lost rule is matched and marked so the fence fails it after the server answers', () => {
    netmock({ method: 'POST', path: '/transfers', lost: true, times: 1 });
    expect(netControls.match('POST', 'https://api.test/transfers')?.lost).toBe(true);
    expect(netControls.match('POST', 'https://api.test/transfers')).toBeNull();
  });

  it('add without a path is refused', () => {
    expect(() => netmock({ status: 500 })).toThrow(/needs a path/);
  });

  it('a reset drops plain rules and keeps sticky ones', () => {
    netmock({ path: '/plain' });
    netmock({ path: '/sticky', sticky: true });
    reset();
    expect((netmock({ action: 'list' }).rules as NetRule[]).map((r) => r.path)).toEqual(['/sticky']);
  });

  it('record captures what the fetch fence reports until dump', () => {
    netmock({ action: 'record' });
    expect(netControls.recording()).toBe(true);
    netControls.record({ method: 'GET', path: '/v3/me', status: 200, body: '{"id":1}' });
    const dumped = command('netmock')({ action: 'dump' }) as { recorded: unknown[] };
    expect(dumped.recorded).toEqual([{ method: 'GET', path: '/v3/me', status: 200, body: '{"id":1}' }]);
    expect(netControls.recording()).toBe(false);
  });

  it('replay turns recorded entries into rules that never run out', () => {
    netmock({ action: 'replay', entries: [{ method: 'GET', path: '/v3/me', status: 200, body: '{"id":1}' }] });
    for (let i = 0; i < 3; i++) expect(netControls.match('GET', 'https://api.test/v3/me')?.body).toBe('{"id":1}');
  });
});

describe('netmock responses', () => {
  const rule = (extra: Partial<NetRule>): NetRule => ({ method: '*', path: '/x', status: 200, hits: 0, ...extra });

  it('answers with the rule status, body and json content type', async () => {
    const res = (await netControls.respond(rule({ status: 418, body: '{"tea":true}', headers: { 'x-mock': '1' } }), FakeResponse)) as FakeResponse;
    expect(res.body).toBe('{"tea":true}');
    expect(res.init.status).toBe(418);
    // x-lynkeus-mocked tells the agent the answer is the case's, not the server's.
    expect(res.init.headers).toEqual({ 'content-type': 'application/json', 'x-mock': '1', 'x-lynkeus-mocked': '1' });
  });

  it('defaults the body to an empty object, or nothing for 204', async () => {
    expect(((await netControls.respond(rule({}), FakeResponse)) as FakeResponse).body).toBe('{}');
    expect(((await netControls.respond(rule({ status: 204 }), FakeResponse)) as FakeResponse).body).toBeNull();
  });

  it('waits delayMs before answering', async () => {
    const started = RealDate.now();
    await netControls.respond(rule({ delayMs: 30 }), FakeResponse);
    expect(RealDate.now() - started).toBeGreaterThanOrEqual(25);
  });
});

describe('netmock hold', () => {
  const netmock = (params: unknown) => command('netmock')(params) as { held?: number; released?: number; holds?: unknown[] };
  const settled = async (promise: Promise<void>) => {
    let done = false;
    void promise.then(() => {
      done = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    return done;
  };

  beforeEach(() => {
    netmock({ action: 'clear' });
  });

  it('holds matching requests until they are released, in the order they came', async () => {
    netmock({ action: 'hold', method: 'GET', path: '/v3/accounts' });
    const first = netControls.hold('GET', 'https://api.test/v3/accounts?page=1')!;
    const second = netControls.hold('get', 'https://api.test/v3/accounts?page=2')!;
    expect(netControls.hold('POST', 'https://api.test/v3/accounts')).toBeUndefined();
    expect(netControls.hold('GET', 'https://api.test/v3/user')).toBeUndefined();
    expect(await settled(first)).toBe(false);
    expect(netmock({ action: 'release', path: '/v3/user' })).toEqual({ released: 0, held: 2 });
    expect(netmock({ action: 'release', path: '/v3/accounts' })).toEqual({ released: 2, held: 0 });
    expect(await settled(first)).toBe(true);
    expect(await settled(second)).toBe(true);
  });

  it('keeps holding after a release, for as many requests as times says', async () => {
    netmock({ action: 'hold', path: '/v3/accounts', times: 1 });
    const one = netControls.hold('GET', 'https://api.test/v3/accounts')!;
    expect(netControls.hold('GET', 'https://api.test/v3/accounts')).toBeUndefined();
    netmock({ action: 'release' });
    await one;
    netmock({ action: 'clear' });
    netmock({ action: 'hold', path: '/v3/accounts' });
    expect(netControls.hold('GET', 'https://api.test/v3/accounts')).toBeInstanceOf(Promise);
    netmock({ action: 'release' });
    expect(netControls.hold('GET', 'https://api.test/v3/accounts')).toBeInstanceOf(Promise);
  });

  it('lists what it holds and for how long', () => {
    netmock({ action: 'hold', path: '/v3/accounts' });
    void netControls.hold('GET', 'https://api.test/v3/accounts');
    const listed = netmock({ action: 'list' }) as unknown as { held: { method: string; path: string; heldMs: number }[]; holds: unknown[] };
    expect(listed.holds).toHaveLength(1);
    expect(listed.held).toEqual([{ method: 'GET', path: '/v3/accounts', heldMs: expect.any(Number) }]);
  });

  it('clear and a reset let go of what is held, and a sticky hold outlives the reset', async () => {
    netmock({ action: 'hold', path: '/v3/accounts' });
    const a = netControls.hold('GET', 'https://api.test/v3/accounts')!;
    netmock({ action: 'clear' });
    expect(await settled(a)).toBe(true);
    netmock({ action: 'hold', path: '/v3/accounts' });
    netmock({ action: 'hold', path: '/v3/user', sticky: true });
    const b = netControls.hold('GET', 'https://api.test/v3/accounts')!;
    reset();
    expect(await settled(b)).toBe(true);
    expect(netControls.hold('GET', 'https://api.test/v3/accounts')).toBeUndefined();
    expect(netControls.hold('GET', 'https://api.test/v3/user')).toBeInstanceOf(Promise);
  });

  it('refuses a hold without a route', () => {
    expect(() => netmock({ action: 'hold' })).toThrow(/needs a path/);
  });
});

describe('clock', () => {
  const clock = (params: unknown) => command('clock')(params) as { now: string; offsetMs: number };

  beforeEach(() => {
    clock({ reset: true });
  });

  it('Date reads the driver-chosen time', () => {
    clock({ now: '2027-01-01T00:00:00Z' });
    expect(Math.abs(Date.now() - RealDate.parse('2027-01-01T00:00:00Z'))).toBeLessThan(1000);
    expect(new Date().toISOString()).toMatch(/^2027-01-01T00:00/);
  });

  it('an explicit argument still builds that date', () => {
    clock({ now: '2027-01-01T00:00:00Z' });
    expect(new Date(0).toISOString()).toBe('1970-01-01T00:00:00.000Z');
  });

  it('advanceMs moves the clock forward from where it is', () => {
    clock({ now: '2027-01-01T00:00:00Z' });
    const { now } = clock({ advanceMs: 3_600_000 });
    expect(now).toMatch(/^2027-01-01T01:00/);
  });

  it('reset returns to real time', () => {
    clock({ now: '2027-01-01T00:00:00Z' });
    const { offsetMs } = clock({ reset: true });
    expect(offsetMs).toBe(0);
    expect(Math.abs(Date.now() - RealDate.now())).toBeLessThan(1000);
  });

  it('refuses a time it cannot parse', () => {
    expect(() => clock({ now: 'next tuesday' })).toThrow(/cannot parse/);
  });

  it('a reset returns to real time', () => {
    clock({ now: '2027-01-01T00:00:00Z' });
    reset();
    expect(Math.abs(Date.now() - RealDate.now())).toBeLessThan(1000);
  });
});

describe('clock settle', () => {
  const settle = (params: unknown = { settle: true }) =>
    command('clock')(params) as Promise<{ now: string; settled: boolean; turns: number; commit: number; inFlight: number }>;
  let commits = 0;
  let inFlight = 0;

  beforeAll(() => {
    setSettleProbe({ commits: () => commits, inFlight: () => inFlight });
  });
  afterAll(() => {
    setSettleProbe(undefined);
  });

  it('settles after a few quiet turns without touching what Date reads', async () => {
    command('clock')({ now: '2027-01-01T00:00:00Z' });
    const answer = await settle();
    expect(answer.settled).toBe(true);
    expect(answer.turns).toBe(3);
    expect(answer.now).toMatch(/^2027-01-01T00:00/);
  });

  it('keeps taking turns while the screen commits, and says when it never goes quiet', async () => {
    setSettleProbe({ commits: () => ++commits, inFlight: () => inFlight });
    const answer = await settle();
    setSettleProbe({ commits: () => commits, inFlight: () => inFlight });
    expect(answer.settled).toBe(false);
    expect(answer.turns).toBe(100);
  });

  it('names the requests still out instead of waiting for them', async () => {
    inFlight = 2;
    const answer = await settle();
    inFlight = 0;
    expect(answer).toMatchObject({ settled: true, inFlight: 2 });
  });

  it('runs a timer that is due now and leaves one that is not', async () => {
    const ran: string[] = [];
    setTimeout(() => ran.push('now'), 0);
    const later = setTimeout(() => ran.push('later'), 60_000);
    await settle();
    clearTimeout(later);
    expect(ran).toEqual(['now']);
  });

  it('settles together with an advance', async () => {
    command('clock')({ reset: true });
    const answer = await settle({ now: '2027-01-01T00:00:00Z', advanceMs: 3_600_000, settle: true });
    expect(answer.now).toMatch(/^2027-01-01T01:00/);
    expect(answer.settled).toBe(true);
  });
});

describe('appstate', () => {
  it('notifies change listeners and a reset returns to active', () => {
    const seen = jest.fn();
    const sub = AppState.addEventListener('change', seen);
    command('appstate')({ state: 'background' });
    expect(AppState.currentState).toBe('background');
    expect(seen).toHaveBeenCalledWith('background');
    reset();
    expect(AppState.currentState).toBe('active');
    sub.remove();
  });

  it('refuses a state the OS does not have', () => {
    expect(() => command('appstate')({ state: 'sleeping' })).toThrow(/not active, background or inactive/);
  });
});

describe('websocket: real', () => {
  it('carries the readyState constants a client compares against', () => {
    const { installDefaultMocks } = require('../mocks/install.js') as typeof import('../mocks/install.js');
    const g = globalThis as { WebSocket?: unknown };
    const before = g.WebSocket;
    g.WebSocket = undefined;
    installDefaultMocks({ websocket: 'real', networkHosts: ['127.0.0.1'] });
    const WS = g.WebSocket as { OPEN: number; CONNECTING: number; CLOSING: number; CLOSED: number };
    expect([WS.CONNECTING, WS.OPEN, WS.CLOSING, WS.CLOSED]).toEqual([0, 1, 2, 3]);
    g.WebSocket = before;
  });
});

describe('network off', () => {
  const network = (state: string) => command('network')({ state }) as { offline: boolean };

  it('drops open sockets and tells NetInfo listeners, and a reset brings the network back', () => {
    const socket = { readyState: 1, terminate: jest.fn() };
    connectivityControls.track(socket);
    const heard: boolean[] = [];
    const unsubscribe = connectivityControls.subscribe((s) => heard.push(s.isConnected));

    expect(network('off').offline).toBe(true);
    expect(socket.terminate).toHaveBeenCalled();
    expect(connectivityControls.netInfo().isConnected).toBe(false);

    network('on');
    network('off');
    reset();
    expect(connectivityControls.offline()).toBe(false);
    expect(heard).toEqual([false, true, false, true]);
    unsubscribe();
  });

  it('refuses a state other than on or off', () => {
    expect(() => network('maybe')).toThrow('network needs');
  });
});

describe('network: real, to a backend that is not up', () => {
  it('says once per address that it did not answer, and the app still sees the failure', async () => {
    const { installDefaultMocks } = require('../mocks/install.js') as typeof import('../mocks/install.js');
    const g = globalThis as { fetch?: unknown };
    const before = g.fetch;
    const lines: string[] = [];
    const write = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    });
    // A port that was free a moment ago: nothing listens on it.
    const net = require('node:net') as typeof import('node:net');
    const port = await new Promise<number>((resolve) => {
      const server = net.createServer().listen(0, '127.0.0.1', () => {
        const { port: free } = server.address() as { port: number };
        server.close(() => resolve(free));
      });
    });
    installDefaultMocks({ network: 'real', networkHosts: ['127.0.0.1'] });
    const fetch = g.fetch as (url: string) => Promise<unknown>;
    await expect(fetch(`http://127.0.0.1:${port}/api/one`)).rejects.toBeTruthy();
    await expect(fetch(`http://127.0.0.1:${port}/api/two`)).rejects.toBeTruthy();
    write.mockRestore();
    g.fetch = before;
    const told = lines.filter((l) => l.includes('did not answer'));
    expect(told).toHaveLength(1);
    expect(told[0]).toContain(`http://127.0.0.1:${port} did not answer (ECONNREFUSED)`);
  });
});

describe('network: real, a body that is not JSON', () => {
  it("rejects json() with the sandbox's SyntaxError, as the app's own code knows it", async () => {
    const { installDefaultMocks } = require('../mocks/install.js') as typeof import('../mocks/install.js');
    const http = require('node:http') as typeof import('node:http');
    const g = globalThis as { fetch?: unknown };
    const before = g.fetch;
    // An empty 404, as a Rails `head :not_found` answers.
    const server = http.createServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    const port = await new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));
    try {
      installDefaultMocks({ network: 'real', networkHosts: ['127.0.0.1'] });
      const fetch = g.fetch as (url: string) => Promise<{ status: number; json: () => Promise<unknown> }>;
      const response = await fetch(`http://127.0.0.1:${port}/api/token`);
      expect(response.status).toBe(404);
      const error = await response.json().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(SyntaxError);
    } finally {
      g.fetch = before;
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

import { createHmac } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { AppState } from 'react-native';

import type { Backend } from '../backend';
import { type Socket, start } from '../client';
import { noNavigation } from '../navigation';
import { qa } from '../registry';

const backend = {
  name: 'fake',
  native: false,
  snapshot: () => ({ elements: [] }),
  commitCount: () => 0,
  window: () => ({ w: 390, h: 844 }),
} as unknown as Backend;

const dialer = () => {
  const dials: number[] = [];
  const sockets: Socket[] = [];
  const urls: string[] = [];
  const createSocket = (url: string): Socket => {
    dials.push(Date.now());
    urls.push(url);
    const socket: Socket = { readyState: 0, send: () => undefined, close: () => undefined, onopen: null, onmessage: null, onclose: null, onerror: null };
    sockets.push(socket);
    return socket;
  };
  const refuse = () => sockets[sockets.length - 1]?.onclose?.();
  return { dials, urls, sockets, createSocket, refuse };
};

const hmac = (token: string, text: string) => createHmac('sha256', token).update(text).digest('hex');
const DRIVER_NONCE = 'd'.repeat(32);

/** Plays a driver holding `token` through the handshake on an opened socket; returns the app's hello. */
const handshake = (socket: Socket, sent: string[], token = 'secret', session = 's') => {
  socket.onmessage?.({ data: JSON.stringify({ event: 'auth', session, nonce: DRIVER_NONCE }) });
  const hello = JSON.parse(sent.find((line) => JSON.parse(line).event === 'hello')!) as { nonce: string; proof: string };
  socket.onmessage?.({ data: JSON.stringify({ event: 'verified', proof: hmac(token, `lynkeus/driver/${session}/${DRIVER_NONCE}/${hello.nonce}`) }) });
  return hello;
};

const opened = (d: ReturnType<typeof dialer>) => {
  const sent: string[] = [];
  const socket = d.sockets[0]! as Socket & { readyState: number };
  socket.readyState = 1;
  socket.send = (data: string) => sent.push(data);
  let closed = false;
  socket.close = () => {
    closed = true;
  };
  return { socket, sent, closed: () => closed };
};

describe('a token that did not arrive', () => {
  it('keeps the agent off instead of serving anyone', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (const token of [undefined, '']) {
      const d = dialer();
      start({ navigation: noNavigation, backend, createSocket: d.createSocket, token })();
      expect(d.dials).toHaveLength(0);
    }
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0]?.[0])).toContain('lynkeus-agent/babel');
    warn.mockRestore();
  });
});

describe('dialing the driver', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: 0 });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('dials every 100 ms for three seconds, then backs off to the ceiling while nobody listens', () => {
    const d = dialer();
    const stop = start({ navigation: noNavigation, backend, createSocket: d.createSocket, token: 'secret' });
    for (let i = 0; i < 36; i++) {
      d.refuse();
      jest.runOnlyPendingTimers();
    }
    const gaps = d.dials.slice(1).map((t, i) => t - d.dials[i]!);
    expect(gaps.slice(0, 30)).toEqual(Array(30).fill(100));
    expect(gaps.slice(30)).toEqual([100, 200, 400, 800, 1500, 1500]);
    stop();
  });

  it("on Android tries the emulator's address and then localhost (a phone over adb reverse), and keeps the one that answered", () => {
    const { Platform } = jest.requireActual<typeof import('react-native')>('react-native');
    const os = Platform.OS;
    Platform.OS = 'android';
    try {
      const d = dialer();
      const stop = start({ navigation: noNavigation, backend, createSocket: d.createSocket, token: 'secret' });
      d.refuse();
      jest.runOnlyPendingTimers();
      d.refuse();
      jest.runOnlyPendingTimers();
      d.sockets[d.sockets.length - 1]?.onopen?.();
      d.refuse();
      jest.runOnlyPendingTimers();
      expect(d.urls).toEqual(['ws://10.0.2.2:8123', 'ws://localhost:8123', 'ws://10.0.2.2:8123', 'ws://10.0.2.2:8123']);
      stop();
    } finally {
      Platform.OS = os;
    }
  });

  it('starts fast again after a link that was up drops', () => {
    const d = dialer();
    const stop = start({ navigation: noNavigation, backend, createSocket: d.createSocket, token: 'secret' });
    for (let i = 0; i < 34; i++) {
      d.refuse();
      jest.runOnlyPendingTimers();
    }
    d.sockets[d.sockets.length - 1]?.onopen?.();
    const before = Date.now();
    d.refuse();
    jest.runOnlyPendingTimers();
    expect(d.dials[d.dials.length - 1]! - before).toBe(100);
    stop();
  });
  it('ignores the close of a socket it already replaced, so two sockets cannot take turns redialing', () => {
    const d = dialer();
    const stop = start({ navigation: noNavigation, backend, createSocket: d.createSocket, token: 'secret' });
    const first = d.sockets[0]!;
    first.onopen?.();
    first.onclose?.();
    jest.runOnlyPendingTimers();
    expect(d.sockets).toHaveLength(2);
    const second = d.sockets[1]!;
    second.onopen?.();
    // The stale socket closes again (a late close event, or a socket that outlived its replacement).
    for (let i = 0; i < 5; i++) {
      first.onclose?.();
      jest.runOnlyPendingTimers();
    }
    expect(d.sockets).toHaveLength(2);
    second.onclose?.();
    jest.runOnlyPendingTimers();
    jest.runOnlyPendingTimers();
    expect(d.sockets).toHaveLength(3);
    stop();
  });
});

describe('replayed requests', () => {
  it('runs an in-flight command once and sends one reply', async () => {
    const d = dialer();
    let calls = 0;
    let release!: (value: { done: boolean }) => void;
    const pending = new Promise<{ done: boolean }>((resolve) => (release = resolve));
    const unregister = qa.register('slowReset', () => {
      calls += 1;
      return pending;
    });
    const stop = start({ navigation: noNavigation, backend, createSocket: d.createSocket, token: 'secret' });
    const link = opened(d);
    handshake(link.socket, link.sent);
    link.sent.length = 0;
    const request = JSON.stringify({ id: 1, method: 'slowReset' });
    d.sockets[0]!.onmessage?.({ data: request });
    d.sockets[0]!.onmessage?.({ data: request });
    expect(calls).toBe(1);
    release({ done: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(link.sent.filter((line) => JSON.parse(line).id === 1)).toHaveLength(1);
    unregister();
    stop();
  });

  it('runs another request that reuses an answered id, and says which method each reply answers', async () => {
    const d = dialer();
    const unregister = qa.register('say', (params) => params);
    const stop = start({ navigation: noNavigation, backend, createSocket: d.createSocket, token: 'secret' });
    const link = opened(d);
    handshake(link.socket, link.sent);
    link.sent.length = 0;
    const settle = async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    };
    // A driver older than 0.7.7 numbers its requests from 1, and drivers sharing a port share its session.
    d.sockets[0]!.onmessage?.({ data: JSON.stringify({ id: 1, method: 'say', params: { word: 'one' } }) });
    await settle();
    d.sockets[0]!.onmessage?.({ data: JSON.stringify({ id: 1, method: 'ping' }) });
    await settle();
    d.sockets[0]!.onmessage?.({ data: JSON.stringify({ id: 1, method: 'say', params: { word: 'two' } }) });
    await settle();
    const replies = link.sent.map((line) => JSON.parse(line) as { id: number; method: string; result: Record<string, unknown> });
    expect(replies.map((r) => r.method)).toEqual(['say', 'ping', 'say']);
    expect(replies[0]!.result).toEqual({ word: 'one' });
    expect(replies[1]!.result.pong).toBe(true);
    expect(replies[2]!.result).toEqual({ word: 'two' });
    unregister();
    stop();
  });
});

describe('hello', () => {
  it('names the agent release, which package.json and the driver agree on', () => {
    const d = dialer();
    const stop = start({ navigation: noNavigation, backend, createSocket: d.createSocket, token: 'secret' });
    const link = opened(d);
    link.socket.onmessage?.({ data: JSON.stringify({ event: 'auth', session: 's', nonce: DRIVER_NONCE }) });
    const { version } = jest.requireActual<{ version: string }>('../../package.json');
    expect(JSON.parse(link.sent[0]!)).toMatchObject({ event: 'hello', agentVersion: version });
    stop();
  });
});

describe('the app going to the background', () => {
  it('tells the driver, so a call to a suspended app is not just a timeout', () => {
    const listeners: ((state: string) => void)[] = [];
    const remove = jest.fn();
    const spy = jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
      listeners.push(listener as (state: string) => void);
      return { remove };
    });
    const d = dialer();
    const stop = start({ navigation: noNavigation, backend, createSocket: d.createSocket, token: 'secret' });
    const link = opened(d);
    handshake(link.socket, link.sent);
    for (const listener of listeners) listener('background');
    expect(link.sent.map((line) => JSON.parse(line))).toContainEqual({ event: 'appstate', state: 'background' });
    stop();
    expect(remove).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('the handshake', () => {
  it('proves the token in hello without sending it', () => {
    const d = dialer();
    const stop = start({ navigation: noNavigation, backend, createSocket: d.createSocket, token: 'secret' });
    const link = opened(d);
    const hello = handshake(link.socket, link.sent);
    expect(hello.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(hello.proof).toBe(hmac('secret', `lynkeus/app/s/${DRIVER_NONCE}/${hello.nonce}`));
    expect(link.sent.join('\n')).not.toContain('secret');
    stop();
  });

  it('serves nothing to a driver that has not proved the token, and drops one whose proof is wrong', () => {
    const d = dialer();
    const stop = start({ navigation: noNavigation, backend, createSocket: d.createSocket, token: 'secret' });
    const link = opened(d);
    link.socket.onmessage?.({ data: JSON.stringify({ event: 'auth', session: 's', nonce: DRIVER_NONCE }) });
    link.socket.onmessage?.({ data: JSON.stringify({ id: 1, method: 'screen' }) });
    expect(JSON.parse(link.sent[1]!)).toMatchObject({ id: 1, error: { code: 'unauthenticated' } });
    link.socket.onmessage?.({ data: JSON.stringify({ event: 'verified', proof: 'f'.repeat(64) }) });
    expect(link.closed()).toBe(true);
    link.socket.onmessage?.({ data: JSON.stringify({ id: 2, method: 'screen' }) });
    expect(JSON.parse(link.sent[2]!)).toMatchObject({ id: 2, error: { code: 'unauthenticated' } });
    stop();
  });

  it("warns once when a driver holding another project's token refuses the app or fails its own proof", () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const d = dialer();
    const stop = start({ navigation: noNavigation, backend, createSocket: d.createSocket, token: 'secret' });
    const link = opened(d);
    link.socket.onmessage?.({ data: JSON.stringify({ event: 'auth', session: 's', nonce: DRIVER_NONCE }) });
    // The driver checks the app's proof against its own token and drops the link without a word.
    link.socket.onclose?.();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]![0])).toContain("does not hold this app's token");
    expect(String(spy.mock.calls[0]![0])).toContain('ws://localhost:8123');
    stop();
    spy.mockRestore();
  });

  it('does not warn when a proven link drops, as a relaunch does', () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const d = dialer();
    const stop = start({ navigation: noNavigation, backend, createSocket: d.createSocket, token: 'secret' });
    const link = opened(d);
    handshake(link.socket, link.sent);
    link.socket.onclose?.();
    expect(spy).not.toHaveBeenCalled();
    stop();
    spy.mockRestore();
  });

  it('says nothing to a driver of the old handshake, which would have taken the token', () => {
    const d = dialer();
    const stop = start({ navigation: noNavigation, backend, createSocket: d.createSocket, token: 'secret' });
    const link = opened(d);
    link.socket.onmessage?.({ data: JSON.stringify({ event: 'auth', session: 's' }) });
    for (const frame of ['null', '5', '"x"']) link.socket.onmessage?.({ data: frame });
    expect(link.sent).toHaveLength(0);
    stop();
  });
});

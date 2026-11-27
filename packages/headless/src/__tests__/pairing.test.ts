/**
 * The real agent and the real driver over a real socket: every reply reaches the call that asked for it. Several
 * drivers of one process share a port (the MCP server's own connection, and one per `case_run --on ios`), and the
 * app keeps one link through all of them.
 */
import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { AgentServer } from 'lynkeus-client';
import { noNavigation, qa, start, type Backend, type Socket } from 'lynkeus-agent';
import wsModule from 'ws';

const NodeWebSocket = ((wsModule as unknown as { WebSocket?: typeof wsModule.WebSocket }).WebSocket ?? wsModule) as unknown as typeof wsModule.WebSocket;

const backend = {
  name: 'fake',
  native: false,
  snapshot: () => ({ elements: [] }),
  commitCount: () => 0,
  window: () => ({ w: 390, h: 844 }),
} as unknown as Backend;

const nodeSocket = (url: string): Socket => {
  const ws = new NodeWebSocket(url);
  const socket: Socket = {
    get readyState() {
      return ws.readyState;
    },
    send: (data) => ws.send(data),
    close: () => ws.close(),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  ws.on('open', () => socket.onopen?.());
  ws.on('message', (data) => socket.onmessage?.({ data: String(data) }));
  ws.on('close', () => socket.onclose?.());
  ws.on('error', () => socket.onerror?.());
  return socket;
};

const TOKEN = 'secret';
let port = 20_000 + Math.floor(Math.random() * 20_000);
const cleanup: (() => unknown)[] = [];

beforeAll(() => {
  // React Native's DevSettings, which the agent reads for Fast Refresh, complains that jest's native module is partial.
  const warn = console.warn;
  jest.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    if (!String(args[0]).includes('NativeEventEmitter')) warn(...args);
  });
});

afterEach(async () => {
  for (const undo of cleanup.splice(0).reverse()) await undo();
});

const app = (at: number) => {
  const stop = start({ navigation: noNavigation, backend, host: '127.0.0.1', port: at, token: TOKEN, reconnectMs: 50, createSocket: nodeSocket });
  cleanup.push(stop);
};

const server = async (options: ConstructorParameters<typeof AgentServer>[0]) => {
  const s = new AgentServer({ token: TOKEN, ...options });
  cleanup.push(() => s.close());
  await s.listen();
  return s;
};

describe('replies across the drivers of one port', () => {
  it('a case run after another on a shared port gets its own replies, not the last run’s', async () => {
    let count = 0;
    cleanup.push(qa.register('count', () => ({ count: ++count })));
    cleanup.push(qa.register('say', (params) => params));
    const at = port++;
    // The MCP server's own connection: it takes any app, and it opened the port, so it signs every handshake there.
    const mcp = await server({ port: at });
    app(at);
    await mcp.waitForApp(5000);

    const ios = (hello: { platform: string }) => hello.platform === 'ios';
    const first = await server({ port: at, accepts: ios });
    await first.waitForApp(5000);
    expect(await first.call('count')).toEqual({ count: 1 });
    expect(await first.call('say', { word: 'one' })).toEqual({ word: 'one' });
    await first.close();
    await mcp.waitForApp(5000);

    const second = await server({ port: at, accepts: ios });
    await second.waitForApp(5000);
    // The very request the first run sent first: the app runs it again, it does not replay what it answered then.
    expect(await second.call('count')).toEqual({ count: 2 });
    const ping = await second.call('ping');
    expect(ping.pong).toBe(true);
    expect(await second.call('say', { word: 'three' })).toEqual({ word: 'three' });
  });

  it('drops the late reply of a call that timed out: the next call gets its own', async () => {
    let release: (() => void) | undefined;
    cleanup.push(qa.register('slow', () => new Promise<{ slow: true }>((resolve) => (release = () => resolve({ slow: true })))));
    cleanup.push(qa.register('say', (params) => params));
    const at = port++;
    const driver = await server({ port: at });
    app(at);
    await driver.waitForApp(5000);

    await expect(driver.call('slow', undefined, 100)).rejects.toMatchObject({ code: 'timeout' });
    const next = driver.call('say', { word: 'after' });
    release?.();
    expect(await next).toEqual({ word: 'after' });
    expect((await driver.call('ping')).pong).toBe(true);
  });
});

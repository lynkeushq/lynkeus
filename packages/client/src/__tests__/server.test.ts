import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { createHmac, randomBytes } from 'node:crypto';
import net from 'node:net';

import { WebSocket } from 'ws';

import { AgentError, AgentServer } from '../index.js';

// Random base: fixed ports collide with another checkout running the same suite.
let port = 20_000 + Math.floor(Math.random() * 20_000);
const servers: AgentServer[] = [];
after(async () => {
  for (const s of servers) await s.close();
});

const serve = async (options: ConstructorParameters<typeof AgentServer>[0] = {}) => {
  const server = new AgentServer({ port: port++, ...options });
  servers.push(server);
  await server.listen();
  return server;
};

type Message = { event?: string; token?: string; session?: string; nonce?: string; proof?: string; id?: number; method?: string };

const hmac = (token: string, text: string) => createHmac('sha256', token).update(text).digest('hex');

/** An app holding `token` (the real agent's handshake): proves it in hello and checks the driver's proof. */
const fakeApp = async (server: AgentServer, answer: (m: Message) => unknown = () => ({ ok: true }), token = 'secret', platform = 'ios') => {
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}`);
  const seen: Message[] = [];
  let expected = '';
  let verified: boolean | undefined;
  socket.on('message', (data) => {
    const m = JSON.parse(String(data)) as Message;
    seen.push(m);
    if (m.event === 'auth') {
      const nonce = randomBytes(16).toString('hex');
      expected = hmac(token, `lynkeus/driver/${m.session}/${m.nonce}/${nonce}`);
      const proof = hmac(token, `lynkeus/app/${m.session}/${m.nonce}/${nonce}`);
      socket.send(JSON.stringify({ event: 'hello', protocolVersion: 2, platform, native: false, commands: [], nonce, proof }));
    } else if (m.event === 'verified') verified = m.proof === expected;
    else if (m.id !== undefined) {
      const reply = answer(m);
      if (reply !== undefined) socket.send(JSON.stringify({ id: m.id, ...(reply as object) }));
    }
  });
  await new Promise((r) => socket.once('open', r));
  return { socket, seen, verified: () => verified };
};

test('the app and the driver each prove the token without either sending it', async () => {
  const server = await serve({ token: 'secret' });
  const app = await fakeApp(server);
  const hello = await server.waitForApp(2000);
  assert.equal(hello.platform, 'ios');
  assert.equal(server.connected, true);
  assert.equal(app.seen[0]?.event, 'auth');
  assert.match(app.seen[0]?.nonce ?? '', /^[0-9a-f]{32}$/);
  assert.equal(app.seen[0]?.token, undefined);
  for (const key of ['token', 'nonce', 'proof']) assert.equal(key in hello, false);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(app.verified(), true);
  assert.equal(JSON.stringify(app.seen).includes('secret'), false);
  app.socket.close();
});

test('an app with another token is refused, and does not knock the real app off', async () => {
  const server = await serve({ token: 'secret' });
  const app = await fakeApp(server, () => ({ result: { real: true } }));
  await server.waitForApp(2000);
  const intruder = await fakeApp(server, () => ({ result: { hijacked: true } }), 'guess');
  await new Promise((resolve) => intruder.socket.once('close', resolve));
  assert.equal(
    intruder.seen.some((m) => m.event === 'verified'),
    false,
  );
  assert.equal(server.connected, true);
  assert.deepEqual(await server.call('ping', undefined, 1000), { real: true });
  app.socket.close();
});

test('an error event from the app does not bring a tokenless driver down', async () => {
  const server = await serve();
  const app = await fakeApp(server, () => ({ result: { pong: true } }));
  await server.waitForApp(2000);
  app.socket.send(JSON.stringify({ event: 'error', message: 'boom' }));
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(await server.call('ping', undefined, 1000), { pong: true });
  app.socket.close();
});

test('connections that never prove the token are capped and closed', async () => {
  const server = await serve({ token: 'secret' });
  const idle = await Promise.all(
    Array.from({ length: 12 }, async () => {
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}`);
      const closed = new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)));
      await new Promise((r) => socket.once('open', r));
      return closed;
    }),
  );
  const codes = await Promise.race([Promise.all(idle), new Promise<number[]>((r) => setTimeout(() => r([]), 7000))]);
  assert.equal(codes.length, 12);
  assert.equal(codes.filter((code) => code === 1013).length, 4);
  assert.equal(codes.filter((code) => code === 1008).length, 8);
  const app = await fakeApp(server, () => ({ result: { pong: true } }));
  assert.deepEqual(await server.call('ping', undefined, 1000), { pong: true });
  app.socket.close();
});

test('a frame that is not an object does not bring the driver down', async () => {
  const server = await serve({ token: 'secret' });
  const peer = new WebSocket(`ws://127.0.0.1:${server.port}`);
  await new Promise((r) => peer.once('open', r));
  for (const frame of ['null', '5', '"x"', 'true']) peer.send(frame);
  await new Promise((r) => setTimeout(r, 50));
  peer.close();
  const app = await fakeApp(server, () => ({ result: { pong: true } }));
  assert.deepEqual(await server.call('ping', undefined, 1000), { pong: true });
  app.socket.close();
});

test('a call gets the result the app sends back, and an error as an AgentError with its code', async () => {
  const server = await serve();
  const app = await fakeApp(server, (m) => (m.method === 'ping' ? { result: { pong: true } } : { error: { message: 'Unknown method', code: 'unknown' } }));
  await server.waitForApp(2000);
  assert.deepEqual(await server.call('ping'), { pong: true });
  await assert.rejects(server.call('nope'), (e: unknown) => e instanceof AgentError && e.code === 'unknown');
  app.socket.close();
});

test('a reply that says it answers another method fails the call instead of passing it', async () => {
  const server = await serve();
  const app = await fakeApp(server, (m) => (m.method === 'waitFor' ? { method: 'ping', result: { pong: true } } : { method: m.method, result: { ok: true } }));
  await server.waitForApp(2000);
  await assert.rejects(
    server.call('waitFor', { route: 'Home' }),
    (e: unknown) => e instanceof AgentError && e.code === 'mismatch' && /waitFor got the reply to ping/.test(e.message),
  );
  assert.deepEqual(await server.call('screen'), { ok: true });
  app.socket.close();
});

test('servers of one process number their requests together, so no two send one id', async () => {
  const one = await serve();
  const two = await serve();
  const ids: number[] = [];
  const apps = await Promise.all(
    [one, two].map((s) =>
      fakeApp(s, (m) => {
        ids.push(m.id!);
        return { result: null };
      }),
    ),
  );
  await Promise.all([one.waitForApp(2000), two.waitForApp(2000)]);
  for (let i = 0; i < 3; i++) await Promise.all([one.call('ping'), two.call('ping')]);
  assert.equal(new Set(ids).size, 6);
  for (const app of apps) app.socket.close();
});

test('a call the app never answers times out with the timeout code', async () => {
  const server = await serve();
  const app = await fakeApp(server, () => undefined);
  await server.waitForApp(2000);
  await assert.rejects(server.call('screen', undefined, 100), (e: unknown) => e instanceof AgentError && e.code === 'timeout');
  app.socket.close();
});

test('with no app attached, waiting and a call use their timeout', async () => {
  const server = await serve();
  await assert.rejects(server.waitForApp(50), /No app attached/);
  await assert.rejects(server.call('ping', undefined, 50), /No app attached/);
});

test('a call made before the app reconnects waits and uses the new socket', async () => {
  const server = await serve();
  const pending = server.call('ping', undefined, 2000);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const app = await fakeApp(server, () => ({ result: { pong: true } }));
  assert.deepEqual(await pending, { pong: true });
  app.socket.close();
});

test('a call in flight when the app drops is resent to the app that comes back', async () => {
  const server = await serve({ reconnectGraceMs: 1000 });
  const first = await fakeApp(server, () => undefined);
  await server.waitForApp(2000);
  const pending = server.call('screen', undefined, 3000);
  await new Promise((r) => setTimeout(r, 50));
  first.socket.close();
  const second = await fakeApp(server, () => ({ result: { route: 'Settings.Main' } }));
  assert.deepEqual(await pending, { route: 'Settings.Main' });
  second.socket.close();
});

test('a call in flight fails as disconnected when the app does not come back in time', async () => {
  const server = await serve({ reconnectGraceMs: 100 });
  const app = await fakeApp(server, () => undefined);
  await server.waitForApp(2000);
  const pending = server.call('screen', undefined, 3000);
  await new Promise((r) => setTimeout(r, 50));
  app.socket.close();
  await assert.rejects(pending, (e: unknown) => e instanceof AgentError && e.code === 'disconnected');
});

test('a second driver on a taken port is refused, naming the port, instead of sharing it', async () => {
  const first = await serve();
  const second = new AgentServer({ port: first.port });
  await assert.rejects(second.listen(), (error: unknown) => {
    assert.ok(error instanceof AgentError);
    assert.equal(error.code, 'port-in-use');
    assert.match(error.message, new RegExp(`Port ${first.port} is already taken: another Lynkeus run is probably still driving`));
    return true;
  });
});

test('a call to an app that left fails as gone once it has had time to come back, not after its whole timeout', async () => {
  const server = await serve({ goneMs: 150 });
  const app = await fakeApp(server);
  await server.waitForApp(2000);
  app.socket.close();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(server.gone, true);
  const t0 = Date.now();
  await assert.rejects(server.call('screen', undefined, 20_000), (e: unknown) => {
    assert.ok(e instanceof AgentError);
    assert.equal(e.code, 'gone');
    assert.match(e.message, /^the app is gone \(crashed or closed\): it disconnected [\d.]+ s ago and has not dialed back in$/);
    return true;
  });
  // What is left of the window the app had to come back, never the call's 20 s; once it is over, nothing.
  assert.ok(Date.now() - t0 < 1000);
  const t1 = Date.now();
  await assert.rejects(server.call('screen', undefined, 20_000), /the app is gone \(crashed or closed\)/);
  assert.ok(Date.now() - t1 < 50);
});

test('an app that left and dials back in within the window is used, and is no longer gone', async () => {
  const server = await serve({ goneMs: 3000 });
  const first = await fakeApp(server);
  await server.waitForApp(2000);
  first.socket.close();
  await new Promise((r) => setTimeout(r, 50));
  const pending = server.call('ping', undefined, 20_000);
  const second = await fakeApp(server, () => ({ result: { pong: true } }));
  assert.deepEqual(await pending, { pong: true });
  assert.equal(server.gone, false);
  second.socket.close();
});

test('an app whose process still runs after the window is loading its JavaScript: calls wait for it, bounded', async () => {
  let asked = 0;
  const server = await serve({
    goneMs: 50,
    reloadMs: 3000,
    stillRunning: async () => {
      asked++;
      return true;
    },
  });
  const first = await fakeApp(server);
  await server.waitForApp(2000);
  first.socket.close();
  await new Promise((r) => setTimeout(r, 150));
  const pending = server.call('ping', undefined, 20_000);
  await new Promise((r) => setTimeout(r, 300));
  const second = await fakeApp(server, () => ({ result: { pong: true } }));
  assert.deepEqual(await pending, { pong: true });
  assert.equal(asked, 1);
  second.socket.close();
});

test('an app whose process still runs and never attaches again fails saying it is still loading, after reloadMs', async () => {
  const server = await serve({ goneMs: 50, reloadMs: 400, stillRunning: async () => true });
  const app = await fakeApp(server);
  await server.waitForApp(2000);
  app.socket.close();
  await new Promise((r) => setTimeout(r, 100));
  const t0 = Date.now();
  await assert.rejects(server.call('screen', undefined, 20_000), (e: unknown) => {
    assert.ok(e instanceof AgentError);
    assert.equal(e.code, 'loading');
    assert.match(e.message, /^the app is still running but its JavaScript has not attached again: it disconnected [\d.]+ s ago/);
    return true;
  });
  assert.ok(Date.now() - t0 < 1000);
});

test('an app whose process is gone still fails as gone once the window has passed', async () => {
  const server = await serve({ goneMs: 50, reloadMs: 5000, stillRunning: async () => false });
  const app = await fakeApp(server);
  await server.waitForApp(2000);
  app.socket.close();
  await new Promise((r) => setTimeout(r, 100));
  await assert.rejects(server.call('screen', undefined, 20_000), (e: unknown) => e instanceof AgentError && e.code === 'gone');
});

test('after expectBack (a relaunch Lynkeus made), calls wait for the app past the window it had after leaving', async () => {
  const server = await serve({ goneMs: 50 });
  const first = await fakeApp(server);
  await server.waitForApp(2000);
  first.socket.close();
  await new Promise((r) => setTimeout(r, 150));
  server.expectBack(3000);
  const pending = server.call('ping', undefined, 20_000);
  await new Promise((r) => setTimeout(r, 200));
  const second = await fakeApp(server, () => ({ result: { pong: true } }));
  assert.deepEqual(await pending, { pong: true });
  second.socket.close();
  // The hello ends what expectBack asked for: a later departure gets the usual window.
  await new Promise((r) => setTimeout(r, 150));
  await assert.rejects(server.call('screen', undefined, 20_000), (e: unknown) => e instanceof AgentError && e.code === 'gone');
});

test('a call to an app that said it went to the background times out saying so', async () => {
  const server = await serve();
  const app = await fakeApp(server, () => undefined);
  await server.waitForApp(2000);
  app.socket.send(JSON.stringify({ event: 'appstate', state: 'background' }));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(server.appState, 'background');
  await assert.rejects(server.call('screen', undefined, 100), (e: unknown) => {
    assert.ok(e instanceof AgentError);
    assert.equal(e.message, 'screen timed out after 100ms: the app went to the background (another app is in front)');
    return true;
  });
  app.socket.close();
});

test('a call that hears nothing at all from the app says so, as a suspended app or a stuck JS thread', async () => {
  const server = await serve();
  const app = await fakeApp(server, () => undefined);
  await server.waitForApp(2000);
  await assert.rejects(
    server.call('screen', undefined, 100),
    /screen timed out after 100ms: nothing at all came from the app meanwhile \(another app in front/,
  );
  app.socket.close();
});

test('servers of one process share a port, each driving the apps it accepts', async () => {
  const ios = await serve({ token: 'secret', accepts: (hello) => hello.platform === 'ios' });
  const android = new AgentServer({ port: ios.port, token: 'secret', accepts: (hello) => hello.platform === 'android' });
  servers.push(android);
  await android.listen();
  const iosApp = await fakeApp(ios, () => ({ result: { on: 'ios' } }));
  const androidApp = await fakeApp(ios, () => ({ result: { on: 'android' } }), 'secret', 'android');
  assert.equal((await ios.waitForApp(2000)).platform, 'ios');
  assert.equal((await android.waitForApp(2000)).platform, 'android');
  assert.deepEqual(await ios.call('ping', undefined, 1000), { on: 'ios' });
  assert.deepEqual(await android.call('ping', undefined, 1000), { on: 'android' });
  // The first server leaving keeps the port for the other.
  await ios.close();
  assert.deepEqual(await android.call('ping', undefined, 1000), { on: 'android' });
  iosApp.socket.close();
  androidApp.socket.close();
});

test('a server that takes one platform takes its app from the one that takes any, and leaves it the rest', async () => {
  const any = await serve({ token: 'secret' });
  const app = await fakeApp(any, () => ({ result: { on: 'android' } }), 'secret', 'android');
  await any.waitForApp(2000);
  const android = new AgentServer({ port: any.port, token: 'secret', accepts: (hello) => hello.platform === 'android' });
  servers.push(android);
  await android.listen();
  await new Promise((resolve) => app.socket.once('close', resolve));
  assert.equal(any.connected, false);
  // The agent dials again; this one stands in for it.
  const again = await fakeApp(any, () => ({ result: { on: 'android' } }), 'secret', 'android');
  assert.equal((await android.waitForApp(2000)).platform, 'android');
  const ios = await fakeApp(any, () => ({ result: { on: 'ios' } }));
  assert.equal((await any.waitForApp(2000)).platform, 'ios');
  assert.deepEqual(await any.call('ping', undefined, 1000), { on: 'ios' });
  again.socket.close();
  ios.socket.close();
});

test('an app no server on the port takes is let go, and a server with another token cannot join', async () => {
  const ios = await serve({ token: 'secret', accepts: (hello) => hello.platform === 'ios' });
  const app = await fakeApp(ios, () => ({ ok: true }), 'secret', 'android');
  await new Promise((resolve) => app.socket.once('close', resolve));
  assert.equal(ios.connected, false);
  const other = new AgentServer({ port: ios.port, token: 'other', accepts: () => true });
  await assert.rejects(other.listen(), (error: unknown) => error instanceof AgentError && error.code === 'port-in-use');
});

test('a second app on a server that takes any is turned away while the first stays attached, and both are listed', async () => {
  const any = await serve({ token: 'secret' });
  const ios = await fakeApp(any, () => ({ result: { on: 'ios' } }));
  await any.waitForApp(2000);
  const android = await fakeApp(any, () => ({ result: { on: 'android' } }), 'secret', 'android');
  const closed = await new Promise<number>((resolve) => android.socket.once('close', (code) => resolve(code)));
  // Told after the token is proven both ways, so the agent redials quietly instead of reporting a refused token.
  assert.equal(closed, 1013);
  assert.equal(android.verified(), true);
  assert.equal(any.hello?.platform, 'ios');
  assert.deepEqual(await any.call('ping', undefined, 1000), { on: 'ios' });
  assert.deepEqual(
    any.apps().map((a) => [a.hello.platform, a.driven]),
    [
      ['ios', 'this'],
      ['android', 'none'],
    ],
  );
  // The first one leaving lets the other in when it dials again.
  ios.socket.close();
  await new Promise((resolve) => any.once('disconnected', resolve));
  const again = await fakeApp(any, () => ({ result: { on: 'android' } }), 'secret', 'android');
  assert.equal((await any.waitForApp(2000)).platform, 'android');
  assert.deepEqual(any.apps()[0] && [any.apps()[0]!.hello.platform, any.apps()[0]!.driven], ['android', 'this']);
  again.socket.close();
});

test('the same app dialing again replaces its old link, as a relaunch does', async () => {
  const any = await serve({ token: 'secret' });
  const first = await fakeApp(any, () => ({ result: { n: 1 } }));
  await any.waitForApp(2000);
  const second = await fakeApp(any, () => ({ result: { n: 2 } }));
  await new Promise((resolve) => first.socket.once('close', resolve));
  assert.deepEqual(await any.call('ping', undefined, 1000), { n: 2 });
  assert.equal(any.apps().length, 1);
  second.socket.close();
});

/**
 * An app whose WebSocket reads the driver's close frame and never answers it, nor ends the connection: FastSim's
 * Android host did that, as React Native's own module keeps a client the server closed until JavaScript closes it.
 */
const deafApp = async (server: AgentServer, token = 'secret', platform = 'android') => {
  const socket = net.connect(server.port, '127.0.0.1');
  await new Promise((resolve) => socket.once('connect', resolve));
  socket.write(
    `GET / HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n\r\n`,
  );
  const frame = (text: string) => {
    const payload = Buffer.from(text);
    const mask = randomBytes(4);
    const head =
      payload.length < 126 ? Buffer.from([0x81, 0x80 | payload.length]) : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
    return Buffer.concat([head, mask, Buffer.from(payload.map((b, i) => b ^ mask[i % 4]!))]);
  };
  let buffered = Buffer.alloc(0);
  let upgraded = false;
  socket.on('data', (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    if (!upgraded) {
      const end = buffered.indexOf('\r\n\r\n');
      if (end < 0) return;
      upgraded = true;
      buffered = buffered.subarray(end + 4);
    }
    // Server frames are unmasked, short and whole here; a close frame (0x88) is read and left unanswered.
    while (buffered.length >= 2) {
      const length = buffered[1]! & 0x7f;
      if (buffered.length < 2 + length) return;
      const opcode = buffered[0]! & 0x0f;
      const text = buffered.subarray(2, 2 + length).toString();
      buffered = buffered.subarray(2 + length);
      if (opcode !== 0x1) continue;
      const m = JSON.parse(text) as Message;
      if (m.event === 'auth') {
        const nonce = randomBytes(16).toString('hex');
        const proof = hmac(token, `lynkeus/app/${m.session}/${m.nonce}/${nonce}`);
        socket.write(frame(JSON.stringify({ event: 'hello', protocolVersion: 2, platform, native: false, commands: [], nonce, proof })));
      }
    }
  });
  return socket;
};

const within = <T>(ms: number, promise: Promise<T>, what: string) =>
  Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms`)), ms).unref())]);

test('closing the server does not wait out an app that never answers the close frame', async () => {
  const server = new AgentServer({ port: port++, token: 'secret' });
  await server.listen();
  const app = await deafApp(server);
  await server.waitForApp(2000);
  const started = Date.now();
  // ws alone waits 30 s for the answer before it cuts the connection; every case on such a host paid it twice.
  await within(2000, server.close(), 'close');
  assert.ok(Date.now() - started < 1000, `closed in ${Date.now() - started} ms`);
  app.destroy();
});

test('a server leaving a shared port cuts its own app when the app never answers the close frame', async () => {
  const ios = await serve({ token: 'secret', accepts: (hello) => hello.platform === 'ios' });
  const android = new AgentServer({ port: ios.port, token: 'secret', accepts: (hello) => hello.platform === 'android' });
  await android.listen();
  const app = await deafApp(android);
  await android.waitForApp(2000);
  const ended = new Promise((resolve) => app.once('close', resolve));
  await android.close();
  await within(2000, ended, 'cutting the app');
  assert.equal(ios.connected, false);
});

test('closing the server does not wait on a connection that never sent a request', async () => {
  const server = new AgentServer({ port: port++, token: 'secret' });
  await server.listen();
  const silent = net.connect(server.port, '127.0.0.1');
  await new Promise((resolve) => silent.once('connect', resolve));
  silent.on('error', () => undefined);
  await within(2000, server.close(), 'close');
  silent.destroy();
});

test('a plain HTTP request to the driver port is told to upgrade', async () => {
  const server = await serve({ token: 'secret' });
  const response = await fetch(`http://127.0.0.1:${server.port}/`);
  assert.equal(response.status, 426);
});

test('a wait for an app whose host has ended fails at once with why, not at its timeout', async () => {
  let ended: string | undefined;
  const server = await serve({ token: 'secret', ended: () => ended });
  const started = Date.now();
  const waiting = server.waitForApp(60_000);
  setTimeout(() => {
    ended = 'the FastSim host exited (1): Lynkeus FastSim has no valid license grant (expired)';
  }, 50).unref();
  await assert.rejects(waiting, (error: unknown) => error instanceof AgentError && error.code === 'gone' && /license grant \(expired\)/.test(error.message));
  assert.ok(Date.now() - started < 1000, `failed after ${Date.now() - started} ms`);
  // Every later call and wait fails at once too.
  await assert.rejects(server.call('screen', undefined, 60_000), /license grant/);
  await assert.rejects(server.waitForApp(60_000), /license grant/);
});

test('a call to an app that left, from a host that then ended, fails with the host’s reason within moments', async () => {
  let ended: string | undefined;
  const server = await serve({ token: 'secret', goneMs: 60_000, ended: () => ended });
  const app = await fakeApp(server);
  await server.waitForApp(2000);
  app.socket.close();
  await new Promise((resolve) => server.once('disconnected', resolve));
  const started = Date.now();
  const calling = server.call('screen', undefined, 60_000);
  ended = 'the host exited (139)';
  await assert.rejects(calling, /the host exited \(139\)/);
  assert.ok(Date.now() - started < 1000, `failed after ${Date.now() - started} ms`);
});

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { createHmac, randomBytes } from 'node:crypto';

import { WebSocket } from 'ws';

import { AgentError, AgentServer } from '../index.js';

let port = 18_500;
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
const fakeApp = async (server: AgentServer, answer: (m: Message) => unknown = () => ({ ok: true }), token = 'secret') => {
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
      socket.send(JSON.stringify({ event: 'hello', protocolVersion: 2, platform: 'ios', native: false, commands: [], nonce, proof }));
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

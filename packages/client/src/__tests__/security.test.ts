import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { WebSocket } from 'ws';

import { AgentServer } from '../index.js';

let port = 19_100;
const servers: AgentServer[] = [];
after(async () => {
  for (const server of servers) await server.close();
});

const serve = async () => {
  const server = new AgentServer({ port: port++, token: 'secret' });
  servers.push(server);
  await server.listen();
  return server;
};

test('the driver never broadcasts the project token', async () => {
  const server = await serve();
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}`);
  const auth = await new Promise<Record<string, unknown>>((resolve) => socket.once('message', (data) => resolve(JSON.parse(String(data)))));
  assert.equal(auth.event, 'auth');
  assert.equal(auth.token, undefined);
  socket.close();
});

test('an unauthenticated peer cannot hijack pending or new commands', async () => {
  const server = await serve();
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}`);
  socket.on('message', (data) => {
    const message = JSON.parse(String(data));
    if (message.event === 'auth')
      socket.send(
        JSON.stringify({ event: 'hello', protocolVersion: 2, platform: 'ios', native: false, commands: [], nonce: 'a'.repeat(32), proof: 'b'.repeat(64) }),
      );
    else if (message.id !== undefined) socket.send(JSON.stringify({ id: message.id, result: { hijacked: true } }));
  });
  await new Promise((resolve) => socket.once('open', resolve));
  await assert.rejects(server.call('type', { text: 'secret-pin' }, 100), /No app attached/);
  assert.equal(server.connected, false);
  socket.close();
});

test('a peer that has not proved the token cannot send a large frame, and a refused one frees its slot at once', async () => {
  const server = await serve();
  const big = new WebSocket(`ws://127.0.0.1:${server.port}`);
  await new Promise((resolve) => big.once('open', resolve));
  const closed = new Promise<number>((resolve) => big.once('close', (code) => resolve(code)));
  big.send('x'.repeat(200 * 1024));
  // Terminated, not answered: 1006 is a connection dropped without a close frame.
  assert.equal(await closed, 1006);

  // Eight wrong proofs, each refused: the ninth peer still gets a chance instead of "too many connections".
  for (let i = 0; i < 8; i++) {
    const peer = new WebSocket(`ws://127.0.0.1:${server.port}`);
    peer.on('message', (data) => {
      const message = JSON.parse(String(data));
      if (message.event === 'auth')
        peer.send(
          JSON.stringify({ event: 'hello', protocolVersion: 2, platform: 'ios', native: false, commands: [], nonce: 'a'.repeat(32), proof: 'b'.repeat(64) }),
        );
    });
    // A peer that never answers the close handshake: it keeps its socket open until the server drops it.
    peer.on('close', () => undefined);
    await new Promise((resolve) => peer.once('close', resolve));
  }
  const ninth = new WebSocket(`ws://127.0.0.1:${server.port}`);
  const first = await new Promise<Record<string, unknown>>((resolve) => ninth.once('message', (data) => resolve(JSON.parse(String(data)))));
  assert.equal(first.event, 'auth');
  ninth.close();
});

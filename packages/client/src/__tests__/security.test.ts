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
    if (message.event === 'auth') socket.send(JSON.stringify({ event: 'hello', protocolVersion: 1, platform: 'ios', native: false, commands: [] }));
    else if (message.id !== undefined) socket.send(JSON.stringify({ id: message.id, result: { hijacked: true } }));
  });
  await new Promise((resolve) => socket.once('open', resolve));
  await assert.rejects(server.call('type', { text: 'secret-pin' }, 100), /No app attached/);
  assert.equal(server.connected, false);
  socket.close();
});

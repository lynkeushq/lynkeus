import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';

import { type WebSocket, WebSocketServer } from 'ws';

import { RelayClient, relayBackend, relayService } from '../relay.js';

const listenHttp = async (server: http.Server) => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
};

type Wire = { id: string; status: number; headers: Record<string, string>; body: string };
const next = (socket: WebSocket) => new Promise<Wire>((resolve) => socket.once('message', (data) => resolve(JSON.parse(String(data)) as Wire)));

test('a relay forwards only allowed requests to the loopback backend', async () => {
  let backendHits = 0;
  let seenApiKey: string | undefined;
  const backend = http.createServer((req, res) => {
    backendHits++;
    seenApiKey = req.headers['x-api-key'] as string | undefined;
    if (req.url === '/api/mobile/v3/large') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(Buffer.alloc(8 * 1024 * 1024 + 1));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  const backendPort = await listenHttp(backend);
  const cloud = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => cloud.once('listening', resolve));
  const cloudPort = (cloud.address() as { port: number }).port;
  let app: WebSocket | undefined;
  cloud.on('connection', (socket) => {
    app = socket;
  });
  const token = `relay_${'a'.repeat(64)}`;
  const client = new RelayClient({ cloud: `ws://127.0.0.1:${cloudPort}`, token, backend: `http://127.0.0.1:${backendPort}` });
  await client.listen();
  try {
    if (!app) throw new Error('relay did not attach');

    const requested = next(app);
    app.send(JSON.stringify({ id: 'one', method: 'GET', path: '/api/mobile/v3/ping?x=1', headers: { 'x-api-key': 'app-secret' } }));
    const answer = await requested;
    assert.equal(answer.status, 200);
    assert.deepEqual(JSON.parse(Buffer.from(answer.body, 'base64').toString()), { ok: true, path: '/api/mobile/v3/ping?x=1' });
    assert.equal(seenApiKey, 'app-secret');

    const refused = next(app);
    app.send(JSON.stringify({ id: 'two', method: 'GET', path: '/admin', headers: {} }));
    assert.equal((await refused).status, 403);
    const escaped = next(app);
    app.send(JSON.stringify({ id: 'three', method: 'GET', path: '//example.test/admin', headers: {} }));
    assert.equal((await escaped).status, 403);
    assert.equal(backendHits, 1);

    const oversized = next(app);
    app.send(
      JSON.stringify({ id: 'four', method: 'POST', path: '/api/mobile/v3/upload', headers: {}, body: Buffer.alloc(1024 * 1024 + 1).toString('base64') }),
    );
    assert.equal((await oversized).status, 413);
    assert.equal(backendHits, 1);

    const large = next(app);
    app.send(JSON.stringify({ id: 'five', method: 'GET', path: '/api/mobile/v3/large', headers: {} }));
    assert.equal((await large).status, 413);
    assert.equal(backendHits, 2);

    const valid = next(app);
    app.send(JSON.stringify({ id: 'six', method: 'POST', path: '/api/mobile/v3/upload', headers: {}, body: Buffer.alloc(900 * 1024).toString('base64') }));
    assert.equal((await valid).status, 200);
    assert.equal(backendHits, 3);
  } finally {
    client.close();
    await client.finished;
    backend.close();
    cloud.close();
  }
});

test('the relay refuses non-loopback backends and malformed tokens', () => {
  assert.throws(() => relayBackend('https://example.test'), /loopback/);
  assert.throws(() => relayBackend('http://user:pass@127.0.0.1'), /credentials/);
  assert.throws(() => new RelayClient({ cloud: 'https://example.test', token: 'short', backend: 'http://127.0.0.1' }), /token/);
  assert.throws(
    () => new RelayClient({ cloud: 'https://example.test', token: `relay_${'a'.repeat(64)}`, backend: 'http://127.0.0.1', prefix: '/admin' }),
    /prefix/,
  );
});

test('an IPv6 loopback address is a loopback address', () => {
  assert.equal(relayBackend('http://[::1]:3000').hostname, '[::1]');
  assert.equal(relayService('ws://[::1]:8787').hostname, '[::1]');
  assert.throws(() => relayBackend('http://[2001:db8::1]:3000'), /loopback/);
  assert.throws(() => relayService('ws://[2001:db8::1]:8787'), /TLS/);
});

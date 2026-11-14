import { createServer, type Server } from 'node:http';

import { WebSocketServer } from 'ws';

import { installDefaultMocks } from '../mocks/install';

const servers: Server[] = [];
const socketServers: WebSocketServer[] = [];
const listen = async (handler: Parameters<typeof createServer>[0]) => {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return address.port;
};

afterEach(() => {
  for (const server of socketServers.splice(0)) server.close();
  for (const server of servers.splice(0)) server.close();
});

test('a redirect cannot send the app to a host outside networkHosts', async () => {
  const secret = await listen((_req, res) => res.end('secret'));
  const redirect = await listen((_req, res) => {
    res.writeHead(302, { location: `http://example.test:${secret}/` });
    res.end();
  });
  installDefaultMocks({ network: 'real', networkHosts: ['127.0.0.1'] });
  await expect(fetch(`http://127.0.0.1:${redirect}/`)).rejects.toThrow('example.test');
});

test('an allowed TCP websocket still connects', async () => {
  const server = createServer();
  servers.push(server);
  const sockets = new WebSocketServer({ server });
  socketServers.push(sockets);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  const connected = new Promise<void>((resolve) => sockets.once('connection', () => resolve()));

  installDefaultMocks({ websocket: 'real', networkHosts: ['127.0.0.1'] });
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
  const opened = new Promise<void>((resolve) => {
    socket.onopen = () => resolve();
  });
  await connected;
  await opened;
  socket.close();
});

test('an allowed hostname cannot select a local Unix socket', async () => {
  const path = `/tmp/lynkeus-headless-${process.pid}-${Date.now()}.sock`;
  const server = createServer();
  servers.push(server);
  const sockets = new WebSocketServer({ server });
  socketServers.push(sockets);
  let connections = 0;
  sockets.on('connection', () => {
    connections += 1;
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));

  installDefaultMocks({ websocket: 'real', networkHosts: ['127.0.0.1'] });
  const socket = new WebSocket(`ws+unix://127.0.0.1:${path}`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  socket.close();
  expect(connections).toBe(0);
});

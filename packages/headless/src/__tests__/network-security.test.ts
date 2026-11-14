import { createServer, type Server } from 'node:http';

import { installDefaultMocks } from '../mocks/install';

const servers: Server[] = [];
const listen = async (handler: Parameters<typeof createServer>[0]) => {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return address.port;
};

afterEach(() => {
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

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { grantCacheFile, grantSummary, makeFastsimCommands } from '../commands/fastsim.js';
import { saveLogin } from '../commands/login.js';
import type { Ctx } from '../registry.js';

type Seen = { method?: string; url?: string; auth?: string; body: string };

const fakeCloud = async (opts: { expiresInMs?: number; redirectTo?: string; status?: number } = {}) => {
  const seen: Seen[] = [];
  let issued = 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      if (req.url !== '/v1/fastsim/grants' || req.method !== 'POST') return res.writeHead(404).end();
      if (opts.redirectTo) return res.writeHead(302, { location: opts.redirectTo }).end();
      if (opts.status)
        return res
          .writeHead(opts.status, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: 'this organization has no Lynkeus FastSim entitlement' }));
      issued++;
      res
        .writeHead(201, { 'content-type': 'application/json' })
        .end(JSON.stringify({ grant: `v1.payload${issued}.sig${issued}`, expiresAt: new Date(Date.now() + (opts.expiresInMs ?? 3_600_000)).toISOString() }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, seen, close: () => server.closeAllConnections() ?? server.close() };
};

const isolate = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-grant-home-'));
  process.env.XDG_CONFIG_HOME = path.join(home, 'config');
  process.env.XDG_CACHE_HOME = path.join(home, 'cache');
  delete process.env.LYNKEUS_CLOUD_KEY;
  delete process.env.LYNKEUS_REPORTS_KEY;
  delete process.env.LYNKEUS_REPORTS_URL;
  return home;
};

const grantCommand = makeFastsimCommands()[1]!;
const run = (cloud: string, flags: Record<string, unknown> = {}) => {
  const messages: string[] = [];
  const ctx = {
    args: [],
    flags: { cloud, platform: 'ios', variant: 'linux-x64-ios', ...flags },
    passthrough: [],
    err: (l: string) => messages.push(l),
  } as unknown as Ctx;
  return grantCommand.run(ctx).then((r) => ({ ...(r as { text: string; code?: number }), messages }));
};

test('fastsim grant with a key asks for the variant, prints the grant and caches it privately', async () => {
  isolate();
  process.env.LYNKEUS_CLOUD_KEY = 'lk_abc';
  const cloud = await fakeCloud();
  const result = await run(cloud.url);
  assert.equal(result.code, undefined);
  assert.equal(result.text, 'v1.payload1.sig1');
  assert.deepEqual(
    cloud.seen.map((s) => [s.method, s.url, s.auth, JSON.parse(s.body)]),
    [['POST', '/v1/fastsim/grants', 'Bearer lk_abc', { variant: 'linux-x64-ios' }]],
  );

  const file = grantCacheFile(cloud.url, 'linux-x64-ios');
  assert.match(path.relative(path.join(process.env.XDG_CACHE_HOME!, 'lynkeus', 'fastsim', 'grants'), file), /^[0-9a-f]{16}[\\/]linux-x64-ios\.json$/);
  const hash = crypto.createHash('sha256').update(cloud.url).digest('hex').slice(0, 16);
  assert.equal(path.basename(path.dirname(file)), hash);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.equal((JSON.parse(fs.readFileSync(file, 'utf8')) as { grant: string }).grant, 'v1.payload1.sig1');
  cloud.close();
});

test('a cached grant is reused while it has more than 5 minutes left and refetched near expiry', async () => {
  isolate();
  process.env.LYNKEUS_CLOUD_KEY = 'lk_abc';
  const cloud = await fakeCloud();
  assert.equal((await run(cloud.url)).text, 'v1.payload1.sig1');
  assert.equal((await run(cloud.url)).text, 'v1.payload1.sig1');
  assert.equal(cloud.seen.length, 1);
  // Another build is its own entry.
  assert.equal((await run(cloud.url, { variant: 'linux-x64-android' })).text, 'v1.payload2.sig2');

  const file = grantCacheFile(cloud.url, 'linux-x64-ios');
  const nearly = { grant: 'v1.old.old', expiresAt: new Date(Date.now() + 4 * 60_000).toISOString() };
  fs.writeFileSync(file, JSON.stringify(nearly));
  assert.equal((await run(cloud.url)).text, 'v1.payload3.sig3');
  fs.writeFileSync(file, JSON.stringify({ ...nearly, expiresAt: new Date(Date.now() + 6 * 60_000).toISOString() }));
  assert.equal((await run(cloud.url)).text, 'v1.old.old');
  cloud.close();
});

test('fastsim grant with a saved sign-in sends its bearer', async () => {
  isolate();
  const cloud = await fakeCloud();
  saveLogin({ cloud: cloud.url, clientId: 'c', accessToken: 'lka_x', expiresAt: Date.now() + 1e6, scope: 'fastsim:download' });
  assert.equal((await run(cloud.url)).text, 'v1.payload1.sig1');
  assert.equal(cloud.seen[0]?.auth, 'Bearer lka_x');
  cloud.close();
});

test('fastsim grant with no key and no sign-in exits 2 naming both ways', async () => {
  isolate();
  const result = await run('https://lynkeus.io');
  assert.equal(result.code, 2);
  assert.match(result.text, /^A step only the person can do: run `lynkeus login`/);
  assert.match(result.text, /no way to sign in to \S+/);
  assert.match(result.text, /in CI, set LYNKEUS_CLOUD_KEY.*May download Lynkeus FastSim/);
});

test('a refusal exits 1 with the service reason, and caches nothing', async () => {
  isolate();
  process.env.LYNKEUS_CLOUD_KEY = 'lk_abc';
  const cloud = await fakeCloud({ status: 403 });
  const result = await run(cloud.url);
  assert.equal(result.code, 1);
  assert.match(result.text, /no Lynkeus FastSim entitlement/);
  assert.equal(fs.existsSync(grantCacheFile(cloud.url, 'linux-x64-ios')), false);
  cloud.close();
});

test('a redirect from the service is not followed with the key', async () => {
  isolate();
  process.env.LYNKEUS_CLOUD_KEY = 'lk_abc';
  let elsewhereHit = false;
  const elsewhere = createServer((_req, res) => {
    elsewhereHit = true;
    res.end('{}');
  });
  await new Promise<void>((resolve) => elsewhere.listen(0, '127.0.0.1', resolve));
  const cloud = await fakeCloud({ redirectTo: `http://127.0.0.1:${(elsewhere.address() as AddressInfo).port}/steal` });
  const result = await run(cloud.url);
  assert.equal(result.code, 1);
  assert.equal(elsewhereHit, false);
  assert.equal(fs.existsSync(grantCacheFile(cloud.url, 'linux-x64-ios')), false);
  cloud.close();
  elsewhere.close();
});

test('through the CLI the grant is the only thing on stdout; the message is on stderr', async () => {
  const home = isolate();
  const cloud = await fakeCloud();
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', path.join(import.meta.dirname, '..', 'cli.ts'), 'fastsim', 'grant', '--cloud', cloud.url, '--variant', 'linux-x64-ios'],
    {
      env: { ...process.env, LYNKEUS_CLOUD_KEY: 'lk_abc', XDG_CACHE_HOME: path.join(home, 'cache'), XDG_CONFIG_HOME: path.join(home, 'config') },
    },
  );
  let out = '';
  let err = '';
  child.stdout.on('data', (c) => (out += c));
  child.stderr.on('data', (c) => (err += c));
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 0, err);
  assert.equal(out, 'v1.payload1.sig1\n');
  assert.match(err, /Lynkeus FastSim grant for linux-x64-ios/);
  cloud.close();
});

test('at a terminal it prints a summary and never the token; --print and --json still carry it', async () => {
  isolate();
  process.env.LYNKEUS_CLOUD_KEY = 'lk_abc';
  const cloud = await fakeCloud();
  const atTerminal = makeFastsimCommands(undefined, { stdoutTty: () => true })[1]!;
  const ctx = (flags: Record<string, unknown> = {}) =>
    ({ args: [], flags: { cloud: cloud.url, platform: 'ios', variant: 'linux-x64-ios', ...flags }, passthrough: [], err: () => {} }) as unknown as Ctx;
  const shown = (await atTerminal.run(ctx())) as { text: string; json: { grant: string } };
  assert.doesNotMatch(shown.text, /v1\.payload/);
  assert.match(shown.text, /Lynkeus FastSim grant ready/);
  assert.match(shown.text, /linux-x64-ios/);
  assert.equal(shown.json.grant, 'v1.payload1.sig1');
  const printed = (await atTerminal.run(ctx({ print: true }))) as { text: string };
  assert.equal(printed.text, 'v1.payload1.sig1');
  cloud.close();
});

test('the summary has a check mark, the variant, the local time and minutes left, and honours NO_COLOR', () => {
  const now = Date.parse('2026-11-18T03:00:00Z');
  const o = { variant: 'darwin-arm64-ios', expiresAt: '2026-11-18T04:00:00Z', cached: false, now };
  const colored = grantSummary(o);
  assert.ok(colored.includes('\x1b[32m✔\x1b[0m'));
  process.env.NO_COLOR = '1';
  try {
    const plain = grantSummary(o);
    assert.ok(!plain.includes('\x1b['));
    assert.match(plain, /^✔ Lynkeus FastSim grant ready for darwin-arm64-ios\n {2}valid until .+ \(60 min left\), new from lynkeus\.io\n/);
    assert.match(grantSummary({ ...o, cached: true }), /reused from the cache/);
  } finally {
    delete process.env.NO_COLOR;
  }
});

test('the grant request carries a stable install id, and a service warning goes to stderr', async () => {
  isolate();
  const headers: (string | string[] | undefined)[] = [];
  const server = createServer((req, res) => {
    headers.push(req.headers['x-lynkeus-machine']);
    req.resume();
    req.on('end', () =>
      res
        .writeHead(201, { 'content-type': 'application/json' })
        .end(JSON.stringify({ grant: 'v1.p.s', expiresAt: new Date(Date.now() + 3_600_000).toISOString(), warning: 'past the plan' })),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { fetchGrant, machineId } = await import('../commands/fastsim.js');
    const cloud = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const first = await fetchGrant({ cloud, key: 'k', variant: 'darwin-arm64-ios' });
    assert.equal(first.warning, 'past the plan');
    assert.match(String(headers[0]), /^[A-Za-z0-9-]{16,64}$/);
    assert.equal(headers[0], machineId());
    assert.equal(machineId(), machineId());
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

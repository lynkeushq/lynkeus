import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { makeFastsimCommands } from '../commands/fastsim.js';
import { credentialsPath, login, loginCommands, savedLogin, saveLogin, signedInToken } from '../commands/login.js';
import type { Ctx } from '../registry.js';

const pair = crypto.generateKeyPairSync('ed25519');

type Seen = { method?: string; url?: string; auth?: string; body: string };

const body = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });

// A fake lynkeus.io: OAuth endpoints, and fastsim routes that need the bearer it issued.
const fakeCloud = async (opts: { expiresIn?: number; redirectReleasesTo?: string } = {}) => {
  const seen: Seen[] = [];
  const issued = { code: 'code-1', access: 'lka_one', refresh: 'lkr_one', challenge: '', clientId: 'client-1', redirectUri: '', refreshes: 0 };
  const archive = (() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-login-src-'));
    fs.writeFileSync(path.join(dir, 'README.md'), 'hi');
    const file = `${dir}.tar.gz`;
    assert.equal(spawnSync('tar', ['-czf', file, '-C', dir, '.']).status, 0);
    return fs.readFileSync(file);
  })();
  const sha = crypto.createHash('sha256').update(archive).digest('hex');
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const text = await body(req);
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: text });
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const json = (value: unknown, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
    if (req.url === '/.well-known/oauth-authorization-server')
      return json({ authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register` });
    if (req.url === '/register') {
      issued.redirectUri = (JSON.parse(text) as { redirect_uris: string[] }).redirect_uris[0] ?? '';
      return json({ client_id: issued.clientId });
    }
    if (req.url === '/token') {
      const form = new URLSearchParams(text);
      if (form.get('grant_type') === 'authorization_code') {
        const verifierOk =
          crypto
            .createHash('sha256')
            .update(form.get('code_verifier') ?? '')
            .digest('base64url') === issued.challenge;
        if (form.get('code') !== issued.code || !verifierOk || form.get('redirect_uri') !== issued.redirectUri) return json({ error: 'invalid_grant' }, 400);
        return json({ access_token: issued.access, refresh_token: issued.refresh, expires_in: opts.expiresIn ?? 3600, scope: 'fastsim:download' });
      }
      if (form.get('grant_type') === 'refresh_token' && form.get('refresh_token') === issued.refresh) {
        issued.refreshes++;
        issued.access = `lka_refreshed${issued.refreshes}`;
        return json({ access_token: issued.access, refresh_token: issued.refresh, expires_in: 3600, scope: 'fastsim:download' });
      }
      return json({ error: 'invalid_grant' }, 400);
    }
    if (req.url?.startsWith('/v1/fastsim/')) {
      if (opts.redirectReleasesTo) return res.writeHead(302, { location: opts.redirectReleasesTo }).end();
      if (req.headers.authorization !== `Bearer ${issued.access}`) return json({ error: 'bad key' }, 401);
      if (req.url === '/v1/fastsim/releases')
        return json({
          releases: [
            {
              version: '2026.11.17',
              variant: 'linux-x64-ios',
              sha256: sha,
              bytes: archive.length,
              signature: crypto.sign(null, archive, pair.privateKey).toString('base64'),
            },
          ],
        });
      return res.writeHead(200).end(archive);
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, seen, issued, close: () => server.closeAllConnections() ?? server.close() };
};

const isolate = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-login-home-'));
  process.env.XDG_CONFIG_HOME = path.join(home, 'config');
  process.env.LYNKEUS_FASTSIM_DIR = path.join(home, 'fastsim');
  delete process.env.LYNKEUS_CLOUD_KEY;
  delete process.env.LYNKEUS_REPORTS_KEY;
  return home;
};

// Plays the browser: reads the authorization URL and calls the loopback the way the service's redirect would.
const browser = (cloud: Awaited<ReturnType<typeof fakeCloud>>, answer: (url: URL) => string) => async (authorizeUrl: string) => {
  const url = new URL(authorizeUrl);
  cloud.issued.challenge = url.searchParams.get('code_challenge') ?? '';
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('scope'), 'fastsim:download');
  assert.equal(url.searchParams.get('response_type'), 'code');
  setTimeout(() => void fetch(answer(url)).catch(() => {}), 10);
  return true;
};

const goodAnswer = (url: URL) => `${url.searchParams.get('redirect_uri')}?code=code-1&state=${url.searchParams.get('state')}`;

const ctx = (flags: Record<string, unknown>): Ctx => ({ args: [], flags, passthrough: [], err: () => {} }) as unknown as Ctx;
const install = makeFastsimCommands(pair.publicKey)[0]!;

test('login runs the whole flow with PKCE, saves the sign-in with private modes and never prints the tokens', async () => {
  isolate();
  const cloud = await fakeCloud();
  const told: string[] = [];
  const saved = await login({ cloud: cloud.url, open: browser(cloud, goodAnswer), tell: (l) => told.push(l) });
  assert.equal(saved.accessToken, 'lka_one');
  assert.equal(saved.clientId, 'client-1');
  assert.ok(cloud.seen.every((s) => !s.url?.includes('lka_')));
  const file = credentialsPath();
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.equal(savedLogin(cloud.url)?.refreshToken, 'lkr_one');
  assert.ok(!told.join('\n').includes('lka_'));

  cloud.close();
});

test('login refuses a callback whose state is not ours', async () => {
  isolate();
  const cloud = await fakeCloud();
  await assert.rejects(
    login({ cloud: cloud.url, open: browser(cloud, (url) => `${url.searchParams.get('redirect_uri')}?code=code-1&state=forged`) }),
    /state that is not ours/,
  );
  assert.equal(savedLogin(cloud.url), undefined);
  assert.ok(!cloud.seen.some((s) => s.url === '/token'));
  cloud.close();
});

test('login with no browser prints the address, and a callback that never comes times out', async () => {
  isolate();
  const cloud = await fakeCloud();
  const told: string[] = [];
  await assert.rejects(login({ cloud: cloud.url, open: () => false, tell: (l) => told.push(l), timeoutMs: 50 }), /timed out/);
  assert.match(told.join('\n'), /\/authorize\?response_type=code&client_id=client-1/);
  cloud.close();
});

test('logout removes only that cloud entry', async () => {
  isolate();
  const entry = (cloud: string) => ({ cloud, clientId: 'c', accessToken: 'lka_x', expiresAt: Date.now() + 1e6, scope: 'fastsim:download' });
  saveLogin(entry('https://one.example'));
  saveLogin(entry('https://two.example'));
  const out = await loginCommands[1]!.run(ctx({ cloud: 'https://one.example' }));
  assert.match(String((out as { text: string }).text), /signed out/);
  assert.equal(savedLogin('https://one.example'), undefined);
  assert.ok(savedLogin('https://two.example'));
});

test('fastsim install with a saved sign-in sends its bearer', async () => {
  isolate();
  const cloud = await fakeCloud();
  await login({ cloud: cloud.url, open: browser(cloud, goodAnswer) });
  process.env.LYNKEUS_REPORTS_URL = cloud.url;
  const result = await install.run(ctx({ cloud: cloud.url, version: 'latest', platform: 'ios', variant: 'linux-x64-ios' }));
  assert.equal((result as { code?: number }).code, undefined, JSON.stringify(result));
  const asked = cloud.seen.filter((s) => s.url?.startsWith('/v1/fastsim/'));
  assert.ok(asked.length >= 2 && asked.every((s) => s.auth === 'Bearer lka_one'));
  delete process.env.LYNKEUS_REPORTS_URL;
  cloud.close();
});

test('a sign-in that expires within a minute is refreshed first, and the new tokens are saved', async () => {
  isolate();
  const cloud = await fakeCloud({ expiresIn: 30 });
  await login({ cloud: cloud.url, open: browser(cloud, goodAnswer) });
  const token = await signedInToken(cloud.url);
  assert.equal(token, 'lka_refreshed1');
  assert.equal(savedLogin(cloud.url)?.accessToken, 'lka_refreshed1');
  assert.ok((savedLogin(cloud.url)?.expiresAt ?? 0) > Date.now() + 3_000_000);
  const refresh = cloud.seen.find((s) => s.body.includes('grant_type=refresh_token'));
  assert.match(refresh?.body ?? '', /client_id=client-1/);
  assert.equal(await signedInToken(cloud.url), 'lka_refreshed1');
  assert.equal(cloud.issued.refreshes, 1);
  cloud.close();
});

test('fastsim install with no key and no sign-in exits 2 naming both ways', async () => {
  isolate();
  const result = (await install.run(ctx({ cloud: 'https://lynkeus.io', version: 'latest', platform: 'ios', variant: 'linux-x64-ios' }))) as {
    text: string;
    code: number;
  };
  assert.equal(result.code, 2);
  assert.match(result.text, /May download fastsim/);
  assert.match(result.text, /lynkeus login/);
});

test('a 401 with a sign-in says to sign in again', async () => {
  isolate();
  const cloud = await fakeCloud();
  await login({ cloud: cloud.url, open: browser(cloud, goodAnswer) });
  cloud.issued.access = 'lka_revoked';
  const result = (await install.run(ctx({ cloud: cloud.url, version: 'latest', platform: 'ios', variant: 'linux-x64-ios' }))) as { text: string; code: number };
  assert.equal(result.code, 1);
  assert.match(result.text, /sign in again with lynkeus login/);
  cloud.close();
});

test('a redirect from the service is not followed with the bearer', async () => {
  isolate();
  let elsewhereHit = false;
  const elsewhere = createServer((_req, res) => {
    elsewhereHit = true;
    res.end('{}');
  });
  await new Promise<void>((resolve) => elsewhere.listen(0, '127.0.0.1', resolve));
  const target = `http://127.0.0.1:${(elsewhere.address() as AddressInfo).port}/steal`;
  const cloud = await fakeCloud({ redirectReleasesTo: target });
  await login({ cloud: cloud.url, open: browser(cloud, goodAnswer) });
  const result = (await install.run(ctx({ cloud: cloud.url, version: 'latest', platform: 'ios', variant: 'linux-x64-ios' }))) as { text: string; code: number };
  assert.equal(result.code, 1);
  assert.equal(elsewhereHit, false);
  cloud.close();
  elsewhere.close();
});

const flagsFor = (cloud: string, extra: Record<string, unknown> = {}) => ({ cloud, version: 'latest', platform: 'ios', variant: 'linux-x64-ios', ...extra });
type Out = { text: string; code?: number };

const withTty = (cloud: Awaited<ReturnType<typeof fakeCloud>>, o: { tty?: boolean; answer?: (url: URL) => void } = {}) => {
  const opened: string[] = [];
  const open = browser(cloud, goodAnswer);
  const command = makeFastsimCommands(pair.publicKey, {
    tty: () => o.tty ?? true,
    open: async (url) => {
      opened.push(url);
      o.answer?.(new URL(url));
      return open(url);
    },
  });
  return { opened, install: command[0]!, grant: command[1]! };
};

const attempts = (cloud: Awaited<ReturnType<typeof fakeCloud>>) => cloud.seen.filter((s) => s.url === '/v1/fastsim/releases').map((s) => s.auth);

test('fastsim install with nothing saved signs in at a terminal, then installs with the new bearer', async () => {
  isolate();
  delete process.env.CI;
  const cloud = await fakeCloud();
  const { opened, install: cmd } = withTty(cloud);
  const messages: string[] = [];
  const result = (await cmd.run({ ...ctx(flagsFor(cloud.url)), err: (l: string) => messages.push(l) } as Ctx)) as Out;
  assert.equal(result.code, undefined, JSON.stringify(result));
  assert.equal(opened.length, 1);
  assert.ok(messages.includes(`No key or sign-in for ${cloud.url}: opening the browser to sign in (lynkeus login)…`));
  assert.deepEqual(new Set(attempts(cloud)), new Set(['Bearer lka_one']));
  assert.equal(savedLogin(cloud.url)?.accessToken, 'lka_one');
  cloud.close();
});

test('fastsim install --no-browser prints the sign-in address instead of opening it', async () => {
  isolate();
  delete process.env.CI;
  const cloud = await fakeCloud();
  const { opened, install: cmd } = withTty(cloud);
  const messages: string[] = [];
  const pending = cmd.run({ ...ctx(flagsFor(cloud.url, { 'no-browser': true })), err: (l: string) => messages.push(l) } as Ctx);
  const address = async () => {
    for (let i = 0; i < 200; i++) {
      const line = messages.find((m) => m.includes('/authorize'));
      if (line) return new URL(line.slice(line.indexOf('http')));
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('no address printed');
  };
  const url = await address();
  cloud.issued.challenge = url.searchParams.get('code_challenge') ?? '';
  await fetch(goodAnswer(url));
  assert.equal(((await pending) as Out).code, undefined);
  assert.equal(opened.length, 0);
  cloud.close();
});

test('fastsim install without a terminal, in CI or over MCP keeps exit 2 and opens nothing', async () => {
  isolate();
  const cloud = await fakeCloud();
  const cases: [string, ReturnType<typeof withTty>, Record<string, unknown>][] = [
    ['no tty', withTty(cloud, { tty: false }), {}],
    ['CI', withTty(cloud), { CI: '1' }],
    ['mcp', withTty(cloud), { attached: true }],
  ];
  for (const [name, { opened, install: cmd }, extra] of cases) {
    if ('CI' in extra) process.env.CI = '1';
    else delete process.env.CI;
    const result = (await cmd.run({ ...ctx(flagsFor(cloud.url)), attached: 'attached' in extra } as Ctx)) as Out;
    assert.equal(result.code, 2, name);
    assert.match(result.text, /May download fastsim/, name);
    assert.equal(opened.length, 0, name);
  }
  delete process.env.CI;
  assert.equal(cloud.seen.length, 0);
  assert.equal(savedLogin(cloud.url), undefined);
  cloud.close();
});

test('fastsim grant exits 2 without a terminal and signs in at one', async () => {
  isolate();
  delete process.env.CI;
  const cloud = await fakeCloud();
  const quiet = withTty(cloud, { tty: false });
  const refused = (await quiet.grant.run(ctx(flagsFor(cloud.url)))) as Out;
  assert.equal(refused.code, 2);
  assert.equal(quiet.opened.length, 0);
  const person = withTty(cloud);
  await person.grant.run(ctx(flagsFor(cloud.url)));
  assert.equal(person.opened.length, 1);
  assert.equal(savedLogin(cloud.url)?.accessToken, 'lka_one');
  cloud.close();
});

test('a refused saved sign-in at a terminal signs in once and retries once', async () => {
  isolate();
  delete process.env.CI;
  const cloud = await fakeCloud();
  await login({ cloud: cloud.url, open: browser(cloud, goodAnswer) });
  cloud.issued.access = 'lka_revoked';
  const { opened, install: cmd } = withTty(cloud, {
    answer: () => {
      cloud.issued.access = 'lka_two';
    },
  });
  cloud.seen.length = 0;
  const messages: string[] = [];
  const result = (await cmd.run({ ...ctx(flagsFor(cloud.url)), err: (l: string) => messages.push(l) } as Ctx)) as Out;
  assert.equal(result.code, undefined, JSON.stringify(result));
  assert.equal(opened.length, 1);
  assert.ok(messages.some((m) => /was refused \(ended or revoked\)/.test(m)));
  assert.deepEqual(attempts(cloud), ['Bearer lka_one', 'Bearer lka_two']);
  cloud.close();
});

test('a refused saved sign-in without a terminal keeps the old message and opens nothing', async () => {
  isolate();
  delete process.env.CI;
  const cloud = await fakeCloud();
  await login({ cloud: cloud.url, open: browser(cloud, goodAnswer) });
  cloud.issued.access = 'lka_revoked';
  const { opened, install: cmd } = withTty(cloud, { tty: false });
  const result = (await cmd.run(ctx(flagsFor(cloud.url)))) as Out;
  assert.equal(result.code, 1);
  assert.match(result.text, /sign in again with lynkeus login/);
  assert.equal(opened.length, 0);
  cloud.close();
});

test('an ended saved sign-in at a terminal signs in again, then installs', async () => {
  isolate();
  delete process.env.CI;
  const cloud = await fakeCloud();
  await login({ cloud: cloud.url, open: browser(cloud, goodAnswer) });
  const file = credentialsPath();
  const all = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>;
  all[cloud.url] = { ...all[cloud.url], expiresAt: 0, refreshToken: undefined };
  fs.writeFileSync(file, JSON.stringify(all), { mode: 0o600 });
  const { opened, install: cmd } = withTty(cloud, {
    answer: () => {
      cloud.issued.access = 'lka_two';
    },
  });
  cloud.seen.length = 0;
  const messages: string[] = [];
  const result = (await cmd.run({ ...ctx(flagsFor(cloud.url)), err: (l: string) => messages.push(l) } as Ctx)) as Out;
  assert.equal(result.code, undefined, JSON.stringify(result));
  assert.equal(opened.length, 1);
  assert.ok(messages.some((m) => /has ended/.test(m)));
  assert.deepEqual(attempts(cloud), ['Bearer lka_two']);
  cloud.close();
});

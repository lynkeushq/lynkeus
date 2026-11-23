import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { hostGrantEnv, licensedFastsimVariant } from '../commands/fastsim.js';
import type { Ctx } from '../registry.js';

const isolate = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-host-grant-'));
  process.env.XDG_CONFIG_HOME = path.join(home, 'config');
  process.env.XDG_CACHE_HOME = path.join(home, 'cache');
  delete process.env.LYNKEUS_CLOUD_KEY;
  delete process.env.LYNKEUS_REPORTS_KEY;
  delete process.env.LYNKEUS_REPORTS_URL;
  delete process.env.CI;
  return home;
};

const kit = (home: string, licensed: string | undefined) => {
  const dir = path.join(home, 'kit');
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'share'), { recursive: true });
  if (licensed) fs.writeFileSync(path.join(dir, 'share', 'licensed'), `${licensed}\n`);
  return `${dir}/bin/fastsim-run /app/bundle {port}`;
};

const ctxFor = (root: string) => {
  const messages: string[] = [];
  return { ctx: { args: [], flags: {}, passthrough: [], root, attached: true, err: (l: string) => messages.push(l) } as unknown as Ctx, messages };
};

const grantFetch = (status = 201) => {
  const calls: { url: string; auth: string | null; body: string }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, auth: new Headers(init.headers).get('authorization'), body: String(init.body) });
    return new Response(
      JSON.stringify(
        status === 201
          ? { grant: 'v1.payload.sig', expiresAt: new Date(Date.now() + 3_600_000).toISOString() }
          : { error: 'this organization has no Lynkeus FastSim entitlement' },
      ),
      { status, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
};

test('a licensed FastSim host command gets FASTSIM_GRANT from the in-process grant, fetched once and cached', async () => {
  const home = isolate();
  process.env.LYNKEUS_CLOUD_KEY = 'lk_abc';
  const command = kit(home, 'darwin-arm64-ios');
  const { ctx } = ctxFor(home);
  const { calls, fetchImpl } = grantFetch();
  const first = await hostGrantEnv(ctx, command, { fetchImpl, env: { PATH: '/bin' } });
  assert.deepEqual(first, { env: { PATH: '/bin', FASTSIM_GRANT: 'v1.payload.sig' } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.auth, 'Bearer lk_abc');
  assert.deepEqual(JSON.parse(calls[0]!.body), { variant: 'darwin-arm64-ios' });
  await hostGrantEnv(ctx, command, { fetchImpl, env: {} });
  assert.equal(calls.length, 1);
});

test('an existing FASTSIM_GRANT is kept and nothing is fetched', async () => {
  const home = isolate();
  const { calls, fetchImpl } = grantFetch();
  const result = await hostGrantEnv(ctxFor(home).ctx, kit(home, 'darwin-arm64-ios'), { fetchImpl, env: { FASTSIM_GRANT: 'v1.mine.sig' } });
  assert.deepEqual(result, { env: { FASTSIM_GRANT: 'v1.mine.sig' } });
  assert.equal(calls.length, 0);
});

test('a host command that is not a licensed FastSim release gets nothing extra', async () => {
  const home = isolate();
  const { calls, fetchImpl } = grantFetch();
  const env = { PATH: '/bin' };
  for (const command of ['node host.js {port}', 'LYNKEUS_PORT={port} lynkeus headless start', kit(home, undefined)]) {
    assert.deepEqual(await hostGrantEnv(ctxFor(home).ctx, command, { fetchImpl, env }), { env });
  }
  assert.equal(calls.length, 0);
});

test('the kit is found from a quoted or relative path', () => {
  const home = isolate();
  const abs = kit(home, 'linux-x64-android').split(' ')[0]!;
  assert.equal(licensedFastsimVariant(`"${abs}" b {port}`, '/'), 'linux-x64-android');
  assert.equal(licensedFastsimVariant('kit/bin/fastsim-run b {port}', home), 'linux-x64-android');
});

test('without credentials the run fails with exit code 2 and the grant message', async () => {
  const home = isolate();
  const { fetchImpl, calls } = grantFetch();
  const result = await hostGrantEnv(ctxFor(home).ctx, kit(home, 'darwin-arm64-ios'), { fetchImpl });
  assert.ok('failed' in result);
  assert.equal(result.failed.code, 2);
  assert.match(String(result.failed.text), /lynkeus login.*LYNKEUS_CLOUD_KEY/s);
  assert.equal(calls.length, 0);
});

test('a refused grant fails the run with exit code 1, the plans hint and without the token', async () => {
  const home = isolate();
  process.env.LYNKEUS_CLOUD_KEY = 'lk_abc';
  const { fetchImpl } = grantFetch(403);
  const result = await hostGrantEnv(ctxFor(home).ctx, kit(home, 'darwin-arm64-ios'), { fetchImpl });
  assert.ok('failed' in result);
  assert.equal(result.failed.code, 1);
  assert.match(String(result.failed.text), /no Lynkeus FastSim entitlement\nPlans: https:\/\/lynkeus\.io\/pricing/);
  assert.doesNotMatch(String(result.failed.text), /lk_abc|v1\./);
});

test("a Flutter kit's host command is granted under its own build name", () => {
  const home = isolate();
  const command = kit(home, 'darwin-arm64-flutter');
  assert.equal(licensedFastsimVariant(command, '/'), 'darwin-arm64-flutter');
});

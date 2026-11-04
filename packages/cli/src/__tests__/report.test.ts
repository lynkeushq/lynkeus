import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { describeChanges, flakes, listRuns, plan, pushRun, tarOf } from '../commands/report.js';

const runDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-push-'));
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ schema: 1, startedAt: '2026-10-10T00:00:00Z' }));
  const line = {
    id: 'home',
    result: 'passed',
    video: 'home/video.mp4',
    steps: [{ step: 'app.login', screenshot: 'home/01-app-login.png' }, { step: 'deposit' }],
  };
  fs.writeFileSync(path.join(dir, 'cases.jsonl'), `${JSON.stringify(line)}\n`);
  fs.mkdirSync(path.join(dir, 'home'));
  fs.writeFileSync(path.join(dir, 'home/01-app-login.png'), 'png');
  fs.writeFileSync(path.join(dir, 'home/video.mp4'), 'film');
  return dir;
};

// A service on the Free plan: it keeps frames and refuses films.
const freeService = () => {
  const asked: { method: string; path: string; auth: string | null }[] = [];
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    asked.push({ method: init?.method ?? 'GET', path: url.pathname, auth: new Headers(init?.headers).get('authorization') });
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    if (url.pathname === '/v1/runs') return reply(201, { id: 'r1', url: 'https://reports.test/r/abc' });
    if (url.pathname.endsWith('.mp4')) return reply(402, { error: 'films are kept on the Team plan' });
    if (url.pathname.endsWith('/finish')) return reply(200, { url: 'https://reports.test/r/abc' });
    if (url.searchParams.has('part')) return reply(200, { cases: 1, part: Number(url.searchParams.get('part')) });
    return reply(200, {});
  }) as typeof fetch;
  return { fake, asked };
};

test('a run goes up as its run file, its cases and the files they name, and a film the plan refuses is said so', async () => {
  const { fake, asked } = freeService();
  const pushed = await pushRun(runDir(), { url: 'https://reports.test/', key: 'lk_1', project: 'hermes', fetch: fake });
  assert.equal(pushed.url, 'https://reports.test/r/abc');
  assert.equal(pushed.files, 1);
  assert.deepEqual(pushed.refused, ['home/video.mp4']);
  assert.deepEqual(
    asked.map((a) => `${a.method} ${a.path}`),
    ['POST /v1/runs', 'PUT /v1/runs/r1/cases', 'POST /v1/runs/r1/finish', 'PUT /v1/runs/r1/bundle', 'PUT /v1/runs/r1/files/home/video.mp4'],
  );
  assert.ok(asked.every((a) => a.auth === 'Bearer lk_1'));
});

test('a case’s frames go as one tar, and one by one to a service from before bundles', async () => {
  const sent: Record<string, Uint8Array> = {};
  const older = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === '/v1/runs') return new Response(JSON.stringify({ id: 'r1' }), { status: 201 });
    if (url.pathname.endsWith('/bundle')) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    if (url.pathname.endsWith('/finish')) return new Response(JSON.stringify({ url: 'https://reports.test/r/abc' }));
    if (init?.body instanceof Uint8Array) sent[url.pathname] = init.body;
    return new Response('{}');
  }) as typeof fetch;
  const pushed = await pushRun(runDir(), { url: 'https://reports.test', key: 'lk_1', project: 'x', fetch: older });
  assert.equal(pushed.files, 2);
  assert.equal(Buffer.from(sent['/v1/runs/r1/files/home/01-app-login.png']!).toString(), 'png');

  const tar = tarOf([['home/01-app-login.png', Buffer.from('png')]]);
  assert.equal(tar.length % 512, 0);
  assert.equal(Buffer.from(tar.subarray(0, 100)).toString().replace(/\0+$/, ''), '01-app-login.png');
  assert.equal(Buffer.from(tar.subarray(345, 500)).toString().replace(/\0+$/, ''), 'home');
  assert.equal(Number.parseInt(Buffer.from(tar.subarray(124, 135)).toString(), 8), 3);
  assert.equal(Buffer.from(tar.subarray(512, 515)).toString(), 'png');
});

test('a refusal from the service comes back as what it said', async () => {
  const fake = (async () => new Response(JSON.stringify({ error: 'run schema 2 is not one this service reads (1)' }), { status: 422 })) as typeof fetch;
  await assert.rejects(pushRun(runDir(), { url: 'https://reports.test', key: 'lk_1', project: 'x', fetch: fake }), /creating the run: run schema 2/);
});

const billingService = () => {
  const asked: string[] = [];
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    asked.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
    const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url.pathname === '/v1/runs')
      return reply({
        runs: [{ project: 'hermes', platform: 'ios', totals: { cases: 6, passed: 5 }, createdAt: '2026-10-11T01:00:00Z', url: 'https://reports.test/r/abc' }],
      });
    if (url.pathname === '/v1/billing') return reply({ name: 'Acme', plan: 'free', days: 7, projects: 1, film: false });
    if (url.pathname === '/v1/billing/checkout') return reply({ url: 'https://checkout.stripe.test/c' });
    return new Response(JSON.stringify({ error: 'this organization has not paid yet' }), { status: 409 });
  }) as typeof fetch;
  return { fake, asked };
};

test('the reports are listed newest first, as the service sends them', async () => {
  const { fake, asked } = billingService();
  const runs = await listRuns({ url: 'https://reports.test', key: 'lk_1', limit: 5, fetch: fake });
  assert.equal(runs[0]!.url, 'https://reports.test/r/abc');
  assert.deepEqual(asked, ['GET /v1/runs?limit=5']);
});

test('the plan is read, and upgrading prints the Stripe checkout', async () => {
  const { fake, asked } = billingService();
  const service = { url: 'https://reports.test', key: 'lk_1', fetch: fake };
  assert.equal((await plan(service)).url, null);
  assert.equal((await plan({ ...service, go: 'upgrade' })).url, 'https://checkout.stripe.test/c');
  await assert.rejects(plan({ ...service, go: 'manage' }), /opening the billing portal: this organization has not paid yet/);
  assert.deepEqual(asked, ['GET /v1/billing', 'GET /v1/billing', 'POST /v1/billing/checkout', 'GET /v1/billing', 'POST /v1/billing/portal']);
});

test('flake trends are read for the project asked', async () => {
  const asked: string[] = [];
  const fake = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    asked.push(`${url.pathname}${url.search}`);
    return new Response(JSON.stringify({ runs: 3, cases: [{ id: 'down', state: 'broken', firstTryRate: 0 }] }), { status: 200 });
  }) as typeof fetch;
  const found = await flakes({ url: 'https://reports.test', key: 'lk_1', project: 'my app', runs: 10, fetch: fake });
  assert.equal(found.cases[0]!.state, 'broken');
  assert.deepEqual(asked, ['/v1/flakes?project=my%20app&runs=10']);
});

test('says what a pushed run broke and fixed, and nothing for a first run', () => {
  assert.deepEqual(describeChanges({ newFailures: ['login'], fixed: ['deposit', 'withdraw'] }), [
    'newly failing (1): login',
    'fixed since the run before (2): deposit, withdraw',
  ]);
  assert.deepEqual(describeChanges({ newFailures: [], fixed: [] }), []);
  assert.deepEqual(describeChanges(undefined), []);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { listRuns, plan, pushRun } from '../commands/report.js';

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
    [
      'POST /v1/runs',
      'PUT /v1/runs/r1/cases',
      'PUT /v1/runs/r1/files/home/video.mp4',
      'PUT /v1/runs/r1/files/home/01-app-login.png',
      'POST /v1/runs/r1/finish',
    ],
  );
  assert.ok(asked.every((a) => a.auth === 'Bearer lk_1'));
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
    return new Response(JSON.stringify({ error: 'this organisation has not paid yet' }), { status: 409 });
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
  await assert.rejects(plan({ ...service, go: 'manage' }), /opening the billing portal: this organisation has not paid yet/);
  assert.deepEqual(asked, ['GET /v1/billing', 'GET /v1/billing', 'POST /v1/billing/checkout', 'GET /v1/billing', 'POST /v1/billing/portal']);
});

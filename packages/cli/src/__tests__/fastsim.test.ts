import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { type FastsimRelease, fastsimVariant, installFastsim, newestFirst } from '../commands/fastsim.js';

const archive = (files: Record<string, string>) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-fastsim-src-'));
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
  }
  const file = path.join(dir, '..', `${path.basename(dir)}.tar.gz`);
  assert.equal(spawnSync('tar', ['-czf', file, '-C', dir, '.']).status, 0);
  return fs.readFileSync(file);
};

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const pair = crypto.generateKeyPairSync('ed25519');
const sign = (b: Buffer) => crypto.sign(null, b, pair.privateKey).toString('base64');

type Asked = { url: string; auth: string | null; redirect: RequestInit['redirect'] };

const service = (releases: FastsimRelease[], bodies: Record<string, Buffer>, status = 200) => {
  const asked: Asked[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    asked.push({ url, auth: new Headers(init?.headers).get('authorization'), redirect: init?.redirect });
    if (status !== 200) return new Response(JSON.stringify({ error: 'this organization has no Lynkeus FastSim entitlement' }), { status });
    if (url.endsWith('/v1/fastsim/releases')) return Response.json({ releases });
    const key = url.split('/v1/fastsim/releases/')[1];
    const body = key ? bodies[key] : undefined;
    return body ? new Response(body) : new Response(JSON.stringify({ error: 'no such fastsim release' }), { status: 404 });
  }) as typeof fetch;
  return { asked, fetchImpl };
};

const options = (fetchImpl: typeof fetch, dir: string) => ({
  cloud: 'https://lynkeus.io',
  key: 'lk_abc',
  version: 'latest',
  variant: 'darwin-arm64',
  dir,
  fetchImpl,
  releaseKey: pair.publicKey,
});

test('fastsim install takes the newest release for the variant, checks its digest and unpacks it', async () => {
  const newer = archive({ 'README.md': 'how to run', 'bin/fastsim-host': 'host' });
  const older = archive({ 'README.md': 'old' });
  const releases = [
    { version: '2026.11.3', variant: 'darwin-arm64', sha256: sha(older), bytes: older.length, signature: sign(older) },
    { version: '2026.11.17', variant: 'darwin-arm64', sha256: sha(newer), bytes: newer.length, signature: sign(newer) },
  ];
  const { asked, fetchImpl } = service(releases, { '2026.11.17/darwin-arm64': newer, '2026.11.3/darwin-arm64': older });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-fastsim-'));
  const result = await installFastsim(options(fetchImpl, dir));
  assert.equal(result.release.version, '2026.11.17');
  assert.equal(result.installed, true);
  assert.equal(fs.readFileSync(path.join(dir, '2026.11.17', 'darwin-arm64', 'bin/fastsim-host'), 'utf8'), 'host');
  assert.ok(asked.every((a) => a.auth === 'Bearer lk_abc' && a.redirect === 'manual'));

  // The same release again is kept, not downloaded.
  const again = await installFastsim(options(fetchImpl, dir));
  assert.equal(again.installed, false);
  assert.equal(asked.filter((a) => a.url.includes('/2026.11.17/')).length, 1);
});

test('fastsim install refuses an archive whose digest is not the release', async () => {
  const body = archive({ 'README.md': 'x' });
  const releases = [{ version: '2026.11.17', variant: 'darwin-arm64', sha256: '0'.repeat(64), bytes: body.length, signature: sign(body) }];
  const { fetchImpl } = service(releases, { '2026.11.17/darwin-arm64': body });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-fastsim-'));
  await assert.rejects(installFastsim(options(fetchImpl, dir)), /arrived damaged/);
  assert.equal(fs.existsSync(path.join(dir, '2026.11.17', 'darwin-arm64')), false);
});

test('fastsim install refuses a release with no signature, a tampered archive and a key that is not lynkeus', async () => {
  const body = archive({ 'README.md': 'x' });
  const release = { version: '2026.11.17', variant: 'darwin-arm64', sha256: sha(body), bytes: body.length };
  const refused = /Lynkeus FastSim 2026\.11\.17 is not signed by lynkeus: not installed/;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-fastsim-'));

  const unsigned = service([release], { '2026.11.17/darwin-arm64': body });
  await assert.rejects(installFastsim(options(unsigned.fetchImpl, dir)), refused);

  // One byte changed after signing, with the digest of the changed bytes: only the signature can catch it.
  const tampered = Buffer.from(body);
  tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
  const swapped = service([{ ...release, sha256: sha(tampered), signature: sign(body) }], { '2026.11.17/darwin-arm64': tampered });
  await assert.rejects(installFastsim(options(swapped.fetchImpl, dir)), refused);

  const other = crypto.generateKeyPairSync('ed25519');
  const wrongKey = service([{ ...release, signature: crypto.sign(null, body, other.privateKey).toString('base64') }], { '2026.11.17/darwin-arm64': body });
  await assert.rejects(installFastsim(options(wrongKey.fetchImpl, dir)), refused);

  const garbage = service([{ ...release, signature: '!!not base64!!' }], { '2026.11.17/darwin-arm64': body });
  await assert.rejects(installFastsim(options(garbage.fetchImpl, dir)), refused);

  assert.deepEqual(fs.readdirSync(dir), []);
  // The built-in key is lynkeus's, so a test key's signature does not pass without releaseKey.
  const signed = service([{ ...release, signature: sign(body) }], { '2026.11.17/darwin-arm64': body });
  await assert.rejects(installFastsim({ ...options(signed.fetchImpl, dir), releaseKey: undefined }), refused);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('fastsim install says what the organization may install when the version is not offered', async () => {
  const body = archive({ 'README.md': 'x' });
  const releases = [{ version: '2026.11.17', variant: 'darwin-arm64', sha256: sha(body), bytes: body.length }];
  const { fetchImpl } = service(releases, {});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-fastsim-'));
  await assert.rejects(installFastsim({ ...options(fetchImpl, dir), version: '2026.1.1' }), /can install: 2026\.11\.17 darwin-arm64/);
});

test('fastsim install passes on the service refusal and refuses a release name that could leave the cache', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-fastsim-'));
  const refused = service([], {}, 403);
  await assert.rejects(installFastsim(options(refused.fetchImpl, dir)), /no Lynkeus FastSim entitlement/);
  const sly = service([{ version: '../../etc', variant: 'darwin-arm64', sha256: 'a'.repeat(64), bytes: 1 }], {});
  await assert.rejects(installFastsim({ ...options(sly.fetchImpl, dir), version: '../../etc' }), /not well formed/);
  await assert.rejects(installFastsim({ ...options(sly.fetchImpl, dir), cloud: 'http://lynkeus.io' }), /HTTPS/);
});

test('newestFirst orders date versions by number, not as text', () => {
  const order = newestFirst([
    { version: '2026.9.30', variant: 'v', sha256: '', bytes: 0 },
    { version: '2026.11.3', variant: 'v', sha256: '', bytes: 0 },
    { version: '2026.11.17', variant: 'v', sha256: '', bytes: 0 },
  ]).map((r) => r.version);
  assert.deepEqual(order, ['2026.11.17', '2026.11.3', '2026.9.30']);
});

test('the build is chosen by the machine and the platform; Windows goes through WSL2', () => {
  assert.equal(fastsimVariant('ios', 'darwin', 'arm64'), 'darwin-arm64-ios');
  assert.equal(fastsimVariant('android', 'darwin', 'arm64'), 'darwin-arm64-android');
  assert.equal(fastsimVariant('android', 'linux', 'x64'), 'linux-x64-android');
  assert.equal(fastsimVariant('ios', 'linux', 'arm64'), 'linux-arm64-ios');
  assert.throws(() => fastsimVariant('ios', 'darwin', 'x64'), /Apple Silicon/);
  assert.throws(() => fastsimVariant('ios', 'win32', 'x64'), /WSL2/);
  assert.throws(() => fastsimVariant('web', 'darwin', 'arm64'), /ios or android/);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { netCacheName, startNetRecord, takeNetRecord, writeNetCache } from '../netCache.js';

test('a URL is kept under the name the React Native host and the Flutter agent give it', () => {
  assert.equal(netCacheName('https://images.example/photo.png'), 'd1f88d0472c300623644b9b7d2a9412a');
});

test('recorded fetches are taken a piece at a time into the folder, body and what it was', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-net-'));
  const pieces = [
    {
      entries: [{ url: 'https://a.example/1.png', status: 200, headers: { 'content-type': 'image/png' }, body: Buffer.from([1, 2]).toString('base64') }],
      left: 1,
    },
    { entries: [{ url: 'https://a.example/2.json', status: 200, headers: {}, body: Buffer.from('{}').toString('base64') }], left: 0 },
  ];
  const asked: unknown[] = [];
  const device = {
    command: async (name: string, params?: unknown) => {
      asked.push([name, params]);
      return (params as { take?: boolean }).take ? pieces.shift() : { recording: true };
    },
  };
  assert.equal(await startNetRecord(device, false), true);
  assert.deepEqual(await takeNetRecord(device, dir), { files: 2, bytes: 4 });
  assert.deepEqual(asked[0], ['netcache', { record: true, credentials: false }]);
  const name = netCacheName('https://a.example/1.png');
  assert.deepEqual([...fs.readFileSync(path.join(dir, name))], [1, 2]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8')), {
    url: 'https://a.example/1.png',
    status: 200,
    headers: { 'content-type': 'image/png' },
  });
  assert.equal(writeNetCache(dir, []).files, 0);
});

test('an agent without the command says it cannot record', async () => {
  assert.equal(await startNetRecord({ command: async () => Promise.reject(new Error('Unknown method netcache')) }, false), false);
});

test('a HEAD keeps its status beside an empty body, and never replaces what a GET of the URL recorded', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-net-'));
  const check = 'https://captive.example/internet-check';
  const page = 'https://a.example/page';
  const written = writeNetCache(dir, [
    { method: 'HEAD', url: check, status: 204, headers: {}, body: '' },
    { url: page, status: 200, headers: {}, body: Buffer.from('hello').toString('base64') },
    { method: 'HEAD', url: page, status: 200, headers: {}, body: '' },
  ]);
  assert.deepEqual(written, { files: 2, bytes: 5 });
  assert.equal(fs.readFileSync(path.join(dir, netCacheName(check))).length, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, `${netCacheName(check)}.json`), 'utf8')), {
    url: check,
    status: 204,
    headers: {},
    method: 'HEAD',
  });
  assert.equal(fs.readFileSync(path.join(dir, netCacheName(page)), 'utf8'), 'hello');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, `${netCacheName(page)}.json`), 'utf8')).method, undefined);
});

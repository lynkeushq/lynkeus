import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { RunCase, RunManifest } from 'lynkeus-protocol';

import { readRun, REPORT_FILE, writeRunReport } from '../commands/localReport.js';
import { caseCommands } from '../commands/cases.js';
import { reportCommands } from '../commands/report.js';
import { type Base, register } from '../registry.js';
import { execute } from '../runtime.js';

register([...caseCommands, ...reportCommands]);

const manifest: RunManifest = {
  schema: 1,
  startedAt: '2026-11-27T05:06:48.387Z',
  finishedAt: '2026-11-27T05:08:17.665Z',
  platform: 'ios',
  native: true,
  git: { branch: 'main', commit: 'd355411', remote: 'https://github.com/acme/shop', pushed: { branch: true, commit: true } },
};

const step = (n: number, extra: Partial<RunCase['steps'][number]> = {}): RunCase['steps'][number] => ({
  step: `app.press #b${n}`,
  status: 'passed',
  ms: 120,
  section: 'steps',
  screenshot: `login/0${n}.avif`,
  ...extra,
});

const run = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-local-report-'));
  fs.mkdirSync(path.join(dir, 'login'));
  fs.writeFileSync(path.join(dir, 'login', '01.avif'), Buffer.from([1, 2, 3]));
  fs.writeFileSync(path.join(dir, 'login', 'video.mp4'), Buffer.from([4, 5]));
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(manifest));
  const failed: RunCase = {
    id: 'login',
    title: 'Signing <in>',
    file: 'cases/login.md',
    attempt: 1,
    result: 'failed',
    startedAt: manifest.startedAt,
    ms: 2100,
    video: 'login/video.mp4',
    steps: [
      step(1, { videoS: 0.5 }),
      step(2, {
        status: 'failed',
        error: 'not on screen: "Welcome"',
        // A path out of the folder is never linked.
        screenshot: '../../etc/passwd',
        requests: [{ id: 1, method: 'POST', url: 'https://api.test/v1/login', startedAt: 0, status: 500, ms: 40, response: { body: '{"error":"<b>"}' } }],
        logs: [{ at: 0, level: 'error', source: 'js', text: '<script>alert(1)</script>' }],
      }),
    ],
    diagnosis: ['the server answered 500'],
  };
  const retried: RunCase = { ...failed, attempt: 2, result: 'passed', steps: [step(1)], diagnosis: undefined };
  const other: RunCase = { ...failed, id: 'home', title: 'Home', attempt: 1, result: 'passed', steps: [], video: undefined, diagnosis: undefined };
  fs.writeFileSync(path.join(dir, 'cases.jsonl'), `${[failed, other, retried].map((c) => JSON.stringify(c)).join('\n')}\n{"cut short`);
  return dir;
};

test('the local report shows each case by its last attempt, its steps, frames, film, requests and why it failed, escaped', () => {
  const dir = run();
  const written = writeRunReport(dir, { project: 'Shop' });
  assert.ok('file' in written);
  const html = fs.readFileSync(path.join(dir, REPORT_FILE), 'utf8');
  assert.match(html, /<title>Shop: 2\/2 passed<\/title>/);
  assert.match(html, /Signing &lt;in&gt;/);
  assert.match(html, /attempt 2 · earlier: attempt 1 failed/);
  assert.match(html, /<img loading="lazy" src="login\/01\.avif"/);
  assert.match(html, /<video controls preload="metadata" src="login\/video\.mp4">/);
  assert.match(html, /href="https:\/\/github\.com\/acme\/shop\/commit\/d355411"/);
  assert.match(html, /Content-Security-Policy" content="default-src 'none'/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /etc\/passwd"/);
  assert.equal((html.match(/<section class="case/g) ?? []).length, 2);
});

test('embed carries the frames as stored and links the film; embedFilm inlines it', () => {
  const dir = run();
  writeRunReport(dir, { embed: true });
  const html = fs.readFileSync(path.join(dir, REPORT_FILE), 'utf8');
  assert.match(html, /src="data:image\/avif;base64,AQID"/);
  assert.doesNotMatch(html, /data:video/);
  assert.match(html, /<video[^>]*src="[^"d][^"]*\.mp4"|<source[^>]*\.mp4/);
});

test('the failed attempt alone, embedded with the film, carries its frames and film and names the failure', () => {
  const dir = run();
  const lines = fs.readFileSync(path.join(dir, 'cases.jsonl'), 'utf8').split('\n');
  fs.writeFileSync(path.join(dir, 'cases.jsonl'), `${lines[0]}\n`);
  writeRunReport(dir, { embedFilm: true });
  const html = fs.readFileSync(path.join(dir, REPORT_FILE), 'utf8');
  assert.match(html, /src="data:image\/avif;base64,AQID"/);
  assert.match(html, /src="data:video\/mp4;base64,BAU="/);
  assert.match(html, /<button class="seek" data-at="0.5">/);
  assert.match(html, /not on screen: &quot;Welcome&quot;/);
  assert.match(html, /the server answered 500/);
  assert.match(html, /POST<\/code> https:\/\/api\.test\/v1\/login <span>500<\/span>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('a folder that is not a run, or of a schema this lynkeus does not know, is refused with why', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-local-report-'));
  assert.match(String(readRun(empty)), /no cases\.jsonl/);
  const dir = run();
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ ...manifest, schema: 2 }));
  assert.match(String(readRun(dir)), /schema 2, and this lynkeus reads 1/);
  const base = { root: dir, config: {}, attached: false, err: () => undefined } as unknown as Base;
  const answer = await execute(['report', 'html', empty], base);
  assert.equal(answer.code, 2);
});

test('report html writes the page and says where', async () => {
  const dir = run();
  const base = { root: dir, config: {}, attached: false, err: () => undefined } as unknown as Base;
  const answer = await execute(['report', 'html', dir], base);
  assert.equal(answer.code ?? 0, 0);
  assert.match(answer.text ?? '', new RegExp(`${REPORT_FILE} \\(.* MB; open it in a browser, no network needed\\)`));
  assert.ok(fs.existsSync(path.join(dir, REPORT_FILE)));
});

test('a large embedded page says to drop only the flag that was passed', async () => {
  const dir = run();
  // A frame of 11 MB: --embed alone already makes the page large.
  fs.writeFileSync(path.join(dir, 'login', '01.avif'), Buffer.alloc(11_000_000, 1));
  const base = { root: dir, config: {}, attached: false, err: () => undefined } as unknown as Base;
  const frames = await execute(['report', 'html', dir, '--embed'], base);
  assert.match(frames.text ?? '', /warning: .* is large for one file; drop --embed \(the frames\) and share the folder instead\./);
  assert.doesNotMatch(frames.text ?? '', /--embed-film or/);
  const film = await execute(['report', 'html', dir, '--embed-film'], base);
  assert.match(film.text ?? '', /drop --embed-film \(the film\)/);
});

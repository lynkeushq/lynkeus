import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { appStamp, caseVersion, Flakes, whereOf } from '../flakes.js';
import type { CaseReport } from '../runner.js';

const report = (result: CaseReport['result'], retried = false, error = 'not on screen: Sent\nmore'): CaseReport & { retried?: boolean } => ({
  id: 'pay',
  file: 'pay.md',
  result,
  ms: 10,
  steps: result === 'failed' ? [{ step: 'app.see Sent', status: 'failed', ms: 3000, error }] : [],
  retried,
});

test('the ledger keeps each run and calls a case flaky when its runs disagree', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-flakes-')), 'flakes.json');
  const first = new Flakes(file);
  first.note(report('passed'));
  first.note(report('passed'));
  assert.deepEqual(first.flaky(['pay']), []);
  first.save();

  const second = new Flakes(file);
  second.note(report('passed', true));
  second.note(report('failed'));
  assert.deepEqual(second.flaky(['pay']), ['⚠ pay is flaky: 2 of its last 4 runs failed or needed a second chance']);
  second.save();

  const kept = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(kept.pay.runs, 4);
  assert.equal(kept.pay.failed, 1);
  assert.equal(kept.pay.retried, 1);
  assert.equal(kept.pay.last.at(-1).error, 'not on screen: Sent');
});

test('a case starts its history again when what it runs changes', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-flakes-')), 'flakes.json');
  const ledger = new Flakes(file);
  const before = caseVersion({ setup: [], steps: [{ verb: 'app.see', value: 'Sent' }], teardown: [] });
  const after = caseVersion({ setup: [], steps: [{ verb: 'app.see', value: 'Sent!' }], teardown: [] });
  assert.notEqual(before, after);
  ledger.note(report('failed'), new Date(), before);
  ledger.note(report('passed'), new Date(), before);
  assert.equal(ledger.flaky(['pay']).length, 1);
  ledger.note(report('passed'), new Date(), after);
  assert.deepEqual(ledger.flaky(['pay']), []);
  ledger.save();
  const kept = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(kept.pay.runs, 1);
  assert.equal(kept.pay.version, after);
});

test('a run with no app attached, or a case that cannot run as written, is not counted as a flake', () => {
  const ledger = new Flakes(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-flakes-')), 'flakes.json'));
  ledger.note(report('passed'));
  ledger.note(report('failed', false, 'No app attached on 127.0.0.1:8123 within 15000ms.'));
  ledger.note(report('failed', false, 'app.tap is not a step: Lynkeus has no command tap, and the project declares no macro for it'));
  ledger.note(report('failed', false, 'no command reset registered; registered: events, stores'));
  ledger.note(report('passed'));
  assert.deepEqual(ledger.flaky(['pay']), []);
  ledger.note(report('failed'));
  assert.deepEqual(ledger.flaky(['pay']), ['⚠ pay is flaky: 1 of its last 3 runs failed or needed a second chance']);
});

test('a macro the case calls is part of what it runs: changing it in the config starts the history again', () => {
  const c = { setup: [], steps: [{ verb: 'app.login', value: {} }], teardown: [] };
  const one = caseVersion(c, { 'app.login': [{ 'app.press': '#a' }], 'app.other': [] });
  assert.equal(one, caseVersion(c, { 'app.login': [{ 'app.press': '#a' }], 'app.other': [{ 'app.press': '#z' }] }));
  assert.notEqual(one, caseVersion(c, { 'app.login': [{ 'app.press': '#b' }] }));
  // A macro another macro calls counts too.
  const nested = (inner: string) => caseVersion(c, { 'app.login': [{ 'app.reset': {} }], 'app.reset': [{ 'app.press': inner }] });
  assert.notEqual(nested('#a'), nested('#b'));
});

test('a failure that reproduces is a break, not a flake', () => {
  const ledger = new Flakes(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-flakes-')), 'flakes.json'));
  ledger.note(report('passed'));
  // Failed on its second chance too.
  ledger.note(report('failed', true));
  ledger.note(report('passed'));
  assert.deepEqual(ledger.flaky(['pay']), []);
  // The same step failing the same way in two runs, then fixed.
  ledger.note(report('failed', false, 'not on screen: Total'));
  ledger.note(report('failed', false, 'not on screen: Total'));
  ledger.note(report('passed'));
  assert.deepEqual(ledger.flaky(['pay']), []);
  ledger.note(report('passed', true));
  assert.deepEqual(ledger.flaky(['pay']), ['⚠ pay is flaky: 1 of its last 4 runs failed or needed a second chance']);
});

test('runs on another target, or of another app source, are not compared', () => {
  const ledger = new Flakes(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-flakes-')), 'flakes.json'));
  ledger.note(report('passed'), new Date(), 'v', { where: 'ios', app: 'a1' });
  ledger.note(report('failed'), new Date(), 'v', { where: 'android', app: 'a1' });
  ledger.note(report('passed'), new Date(), 'v', { where: 'host:ios', app: 'a1' });
  assert.deepEqual(ledger.flaky(['pay']), []);
  // The app changed and the case fails from then on: a break, not a flake.
  ledger.note(report('failed', false, 'not on screen: Welcome'), new Date(), 'v', { where: 'ios', app: 'a2' });
  assert.deepEqual(ledger.flaky(['pay']), []);
  ledger.note(report('passed'), new Date(), 'v', { where: 'ios', app: 'a2' });
  assert.deepEqual(ledger.flaky(['pay']), ['⚠ pay is flaky on ios: 1 of its last 2 runs failed or needed a second chance']);
});

test('a run whose driver could not take its port is not counted', () => {
  const ledger = new Flakes(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-flakes-')), 'flakes.json'));
  ledger.note(report('passed'));
  ledger.note(report('failed', false, 'Port 8123 is already taken: another Lynkeus run is probably still driving the app there.'));
  assert.deepEqual(ledger.flaky(['pay']), []);
});

test('where names a phone by its platform, FastSim and hosts apart', () => {
  assert.equal(whereOf({ platform: 'ios', native: true, commands: [] }), 'ios');
  assert.equal(whereOf({ platform: 'android', native: true, commands: ['clock'] }), 'fastsim:android');
  assert.equal(whereOf({ platform: 'ios', native: false }), 'host:ios');
  assert.equal(whereOf(undefined), undefined);
});

test('the app stamp follows the working tree, not the excluded folders', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-stamp-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  fs.mkdirSync(path.join(dir, 'cases'));
  fs.writeFileSync(path.join(dir, 'app.ts'), 'a\n');
  fs.writeFileSync(path.join(dir, 'cases', 'x.md'), 'x\n');
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'one');
  const first = appStamp(dir, ['cases']);
  assert.ok(first);
  fs.writeFileSync(path.join(dir, 'cases', 'x.md'), 'y\n');
  assert.equal(appStamp(dir, ['cases']), first);
  fs.writeFileSync(path.join(dir, 'app.ts'), 'b\n');
  assert.notEqual(appStamp(dir, ['cases']), first);
  assert.equal(appStamp(os.tmpdir()), undefined);
});

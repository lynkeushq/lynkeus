import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { caseVersion, Flakes } from '../flakes.js';
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

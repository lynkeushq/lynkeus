import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CaseReport } from '../cases/runner.js';
import { missingEvidence } from '../commands/cases.js';

const run = (over: Partial<CaseReport> = {}): CaseReport => ({ id: 'a', file: 'a.md', result: 'passed', ms: 1, steps: [{ step: 'press', status: 'passed', ms: 1 }], ...over });

test('a run where the app sent no analytics event says to check its build', () => {
  const lines = missingEvidence([run()], { video: false });
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? '', /analytics event/);
});

test('backend events alone do not count as the app sending its own', () => {
  const steps = [{ step: 'press', status: 'passed' as const, ms: 1, sent: [{ provider: 'mixpanel', name: 'Signed In', via: 'server' as const }] }];
  assert.equal(missingEvidence([run({ steps })], { video: false }).length, 1);
});

test('an SDK call or an event read from the app is enough', () => {
  const steps = [{ step: 'press', status: 'passed' as const, ms: 1, sent: [{ provider: 'mixpanel', name: 'Tap', via: 'sdk' as const }] }];
  assert.deepEqual(missingEvidence([run({ steps })], { video: false }), []);
  assert.deepEqual(missingEvidence([run({ events: [{ name: 'Tap' } as NonNullable<CaseReport['events']>[number]] })], { video: false }), []);
});

test('asking for film on a host that keeps none says so', () => {
  const steps = [{ step: 'press', status: 'passed' as const, ms: 1, sent: [{ provider: 'mixpanel', name: 'Tap', via: 'sdk' as const }] }];
  assert.match(missingEvidence([run({ steps })], { video: true }).join('\n'), /no film/);
  assert.deepEqual(missingEvidence([run({ steps, video: '/x/video.mp4' })], { video: true }), []);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { CaseReport } from '../cases/runner.js';
import { analyticsSdksOf, missingEvidence } from '../commands/cases.js';

const MIXPANEL = ['mixpanel-react-native'];

const run = (over: Partial<CaseReport> = {}): CaseReport => ({
  id: 'a',
  file: 'a.md',
  result: 'passed',
  ms: 1,
  steps: [{ step: 'press', status: 'passed', ms: 1 }],
  ...over,
});

test('a run where the app sent no analytics event says to check its build', () => {
  const lines = missingEvidence([run()], { video: false, sdks: MIXPANEL });
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? '', /analytics event from the app, which depends on mixpanel-react-native/);
});

test('an app with no analytics SDK is not warned that it sent no event', () => {
  assert.deepEqual(missingEvidence([run()], { video: false, sdks: [] }), []);
});

test('the analytics SDKs are read from the app’s dependencies', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-sdks-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { expo: '55.0.0', '@sentry/react-native': '7' } }));
  assert.deepEqual(analyticsSdksOf(root), ['@sentry/react-native']);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { expo: '55.0.0' } }));
  assert.deepEqual(analyticsSdksOf(root), []);
});

test('backend events alone do not count as the app sending its own', () => {
  const steps = [{ step: 'press', status: 'passed' as const, ms: 1, sent: [{ provider: 'mixpanel', name: 'Signed In', via: 'server' as const }] }];
  assert.equal(missingEvidence([run({ steps })], { video: false, sdks: MIXPANEL }).length, 1);
});

test('an SDK call or an event read from the app is enough', () => {
  const steps = [{ step: 'press', status: 'passed' as const, ms: 1, sent: [{ provider: 'mixpanel', name: 'Tap', via: 'sdk' as const }] }];
  assert.deepEqual(missingEvidence([run({ steps })], { video: false, sdks: MIXPANEL }), []);
  assert.deepEqual(missingEvidence([run({ events: [{ name: 'Tap' } as NonNullable<CaseReport['events']>[number]] })], { video: false, sdks: MIXPANEL }), []);
});

test('asking for film on a host that keeps none says so', () => {
  const steps = [{ step: 'press', status: 'passed' as const, ms: 1, sent: [{ provider: 'mixpanel', name: 'Tap', via: 'sdk' as const }] }];
  assert.match(missingEvidence([run({ steps })], { video: true, sdks: MIXPANEL }).join('\n'), /no film/);
  assert.deepEqual(missingEvidence([run({ steps, video: '/x/video.mp4' })], { video: true, sdks: MIXPANEL }), []);
});

test('frames asked for and none taken on a host the run started blames the bundle, not a simulator', () => {
  const steps = [{ step: 'press', status: 'passed' as const, ms: 1, sent: [{ provider: 'mixpanel', name: 'Tap', via: 'sdk' as const }] }];
  const own = missingEvidence([run({ steps })], { video: false, sdks: [], screenshots: true, ownHost: true }).join('\n');
  assert.match(own, /--screenshots kept no frame/);
  assert.match(own, /fastsim-bundle/);
  assert.match(missingEvidence([run({ steps })], { video: false, sdks: [], screenshots: true }).join('\n'), /simulator or emulator/);
  assert.deepEqual(
    missingEvidence([run({ steps: [{ ...steps[0]!, screenshot: '/x/01.avif' }] })], { video: false, sdks: [], screenshots: true, ownHost: true }),
    [],
  );
});

test('a run asked to film names the cases whose recorder left nothing that plays, and why', async () => {
  const { filmGaps } = await import('../commands/cases.js');
  const { filmLine } = await import('../commands/evidence.js');
  const broken = run({ id: 'b', warnings: ['no film: the file is empty: the recorder never finished it'] });
  const filmed = run({ id: 'a', video: '/run/a/video.mp4' });
  assert.deepEqual(filmGaps([filmed, broken], true), [
    '⚠ --video: 1 of 2 case(s) have no film that plays (b): the file is empty: the recorder never finished it',
  ]);
  assert.deepEqual(filmGaps([filmed, broken], false), []);
  const lines = missingEvidence([filmed, broken], { video: true, sdks: [], ownHost: true });
  assert.equal(lines.length, 1, 'the general "does not film" line is not said beside the reason');
  assert.equal(filmLine([{ label: 'fastsim:ios', reports: [filmed], dir: '/run' }]), 'film: every case has one (1)');
  assert.equal(
    filmLine([{ label: 'fastsim:ios', reports: [filmed, broken], dir: '/run' }]),
    '⚠ film missing for 1 of 2 case(s): b — the file is empty: the recorder never finished it',
  );
});

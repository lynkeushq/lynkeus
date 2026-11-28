import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Element, Screen } from 'lynkeus-protocol';

import type { CaseReport } from '../cases/runner.js';
import { describe, onceUnlessVerbose } from '../commands/cases.js';
import { describeScreen } from '../device/driver.js';

const frame = { x: 0, y: 0, w: 300, h: 40 };

// A wallet's activity screen as an app shows it: a header, a search field, a long list, a legal paragraph and a tab bar.
const activity = (): Screen => {
  const elements: Element[] = [];
  const add = (e: Omit<Element, 'i' | 'frame' | 'enabled' | 'depth'>) => elements.push({ i: elements.length, frame, enabled: true, depth: 2, ...e });
  add({ kind: 'text', text: 'Activity' });
  add({ kind: 'button', testId: 'activity-filter', text: 'Filter' });
  add({ kind: 'input', testId: 'activity-search', value: '', placeholder: 'Search by name, amount or reference' });
  for (let n = 1; n <= 30; n++) {
    add({ kind: 'button', testId: `activity-row-${n}`, text: `Payment to Merchant ${n}` });
    add({ kind: 'text', text: `-$${(n * 3.17).toFixed(2)} · Nov ${n % 28 || 28}, 2026 · Completed` });
  }
  add({
    kind: 'text',
    text: 'Transfers are processed by our banking partner, member FDIC. Balances held in your account are eligible for pass-through insurance up to the applicable limits. Terms apply.',
  });
  for (const tab of ['home', 'activity', 'cards', 'rewards', 'profile'])
    add({ kind: 'button', testId: `tab-${tab}`, text: tab[0]!.toUpperCase() + tab.slice(1) });
  return { route: 'Activity.Main', path: ['Tabs', 'Activity.Main'], commit: 40, busy: false, window: { w: 390, h: 844 }, costMs: 3, elements } as Screen;
};

const failed = (): CaseReport => ({
  id: 'activity-filter-by-card',
  file: 'cases/activity-filter-by-card.md',
  result: 'failed',
  ms: 14_200,
  steps: [
    { step: 'app.login as: u', status: 'passed', ms: 3100 },
    { step: 'app.press #tab-activity', status: 'passed', ms: 400 },
    { step: 'app.press #activity-filter', status: 'passed', ms: 380 },
    {
      step: 'app.wait what: #filter-card, timeoutMs: 10000',
      status: 'failed',
      ms: 10_000,
      error: 'not on screen: {"testId":"filter-card"} (never in the tree, after 2 scrolls)',
    },
    { step: 'app.press #filter-card', status: 'skipped', ms: 0 },
    { step: 'app.see text: Card ending 4242', status: 'skipped', ms: 0 },
  ],
  evidence: {
    screen: describeScreen(activity(), { limit: 40 }),
    requests: [
      '200 GET https://api.example.test/v2/me',
      '200 GET https://api.example.test/v2/accounts?include=balances,limits',
      '200 GET https://api.example.test/v2/activity?page=1&per_page=30',
      '200 GET https://api.example.test/v2/rewards/summary',
      '200 POST https://api.example.test/v2/analytics/batch',
      '401 GET https://api.example.test/v2/cards?status=active',
      '200 GET https://api.example.test/v2/feature-flags',
      '… GET https://api.example.test/v2/notifications/unread',
    ],
    why: '  • 401 GET /v2/cards: the app was refused the cards list, and its filter shows none\n  • #filter-card was never in the tree',
  },
  diagnosis: ['401 GET /v2/cards: the app was refused the cards list, and its filter shows none', '#filter-card was never in the tree'],
});

test('a failed case keeps its broken step, error, testIDs and the request that failed, in under half the bytes', () => {
  const report = failed();
  const verbose = describe(report, { verbose: true, headline: false });
  const compact = describe(report, { headline: false });
  assert.match(compact, /failed at step 4 of 6: app\.wait what: #filter-card/);
  assert.match(compact, /never in the tree, after 2 scrolls/);
  assert.match(compact, /401 GET https:\/\/api\.example\.test\/v2\/cards/);
  assert.match(compact, /… GET .*notifications/);
  assert.doesNotMatch(compact, /200 GET/);
  assert.match(compact, /#activity-filter/);
  assert.match(compact, /#activity-row-2 .*\n.*… \d+ more like it/);
  assert.doesNotMatch(compact, /#activity-row-3 /);
  assert.match(compact, /more \(verbose shows the whole screen\)/);
  assert.match(compact, /refused the cards list/);
  assert.match(verbose, /200 GET .*feature-flags/);
  const bytes = (s: string) => Buffer.byteLength(s);
  assert.ok(bytes(compact) * 2 < bytes(verbose), `compact ${bytes(compact)} B, verbose ${bytes(verbose)} B`);
  if (process.env.LYNKEUS_PRINT_SIZES) console.log(`failed case: verbose ${bytes(verbose)} B, compact ${bytes(compact)} B\n${compact}`);
});

test('a notice the last run gave word for word is one line, unless verbose', () => {
  const notice = 'native values headless could not answer';
  const lines = ['native values headless could not answer (2):', '  • A.b', '  • C.d'];
  assert.deepEqual(onceUnlessVerbose(notice, lines, false), lines);
  assert.deepEqual(onceUnlessVerbose(notice, lines, false), [`${notice}: as the last run said (3 lines; verbose repeats them)`]);
  assert.deepEqual(onceUnlessVerbose(notice, lines, true), lines);
  const changed = [...lines, '  • E.f'];
  assert.deepEqual(onceUnlessVerbose(notice, changed, false), changed);
});

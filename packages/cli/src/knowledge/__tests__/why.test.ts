import assert from 'node:assert/strict';
import { test } from 'node:test';

import { explain } from '../why.js';
import type { Element, RequestRecord, Screen, TraceEvent } from 'lynkeus-protocol';

const el = (p: Partial<Element>, i: number): Element =>
  ({ i, kind: 'button', frame: { x: 0, y: 0, w: 10, h: 10 }, enabled: true, depth: 1, tag: i + 1, ...p }) as Element;
const screen = (elements: Element[], route?: string): Screen => ({ route, path: route ? [route] : [], elements, commit: 5, costMs: 1 }) as unknown as Screen;
const req = (status: number | undefined, url: string, error?: string): RequestRecord => ({ id: 1, method: 'GET', url, status, startedAt: 0, ms: 10, error });
const rules = (f: ReturnType<typeof explain>) => f.map((x) => x.rule);

test('a dead navigator and a gone session are named', () => {
  assert.deepEqual(rules(explain({ screen: screen([]), requests: [], inFlight: 0 })), ['dead-navigator']);
  assert.ok(
    rules(explain({ screen: screen([el({}, 0)], 'Home'), requests: [req(401, 'http://x/a'), req(401, 'http://x/b')], inFlight: 0 })).includes('session-gone'),
  );
});

test('a covered target, a near text and a capped list', () => {
  const s = screen([el({ testId: 'submit', covered: true }, 0), el({ kind: 'text', text: 'Café Ünïcode wörks here' }, 1)], 'Home');
  assert.ok(rules(explain({ screen: s, requests: [], inFlight: 0, target: { testId: 'submit' } })).includes('covered'));
  assert.ok(rules(explain({ screen: s, requests: [], inFlight: 0, target: { text: 'Cafe Unicode works here' } })).includes('near-match'));
  assert.ok(rules(explain({ screen: s, requests: [], inFlight: 0, target: { text: 'cafe unicode works here' } })).includes('near-match'));
  assert.ok(!rules(explain({ screen: s, requests: [], inFlight: 0, target: { text: 'A completely different sentence' } })).includes('near-match'));
  const list = screen(
    Array.from({ length: 12 }, (_, i) => el({ testId: `row-${i}-item`, text: `Item${i}` }, i)),
    'Search',
  );
  assert.ok(rules(explain({ screen: list, requests: [req(200, 'http://x/search')], inFlight: 0, target: { text: 'itemabc' } })).includes('capped-list'));
});

test('backend and loading conditions', () => {
  const s = screen([el({}, 0)], 'Home');
  assert.ok(rules(explain({ screen: s, requests: [req(500, 'http://x/api/a')], inFlight: 0 })).includes('backend-error'));
  assert.ok(rules(explain({ screen: s, requests: [req(200, 'http://x/a')], inFlight: 2, target: { testId: 'x' } })).includes('in-flight'));
  const stall: TraceEvent = { seq: 1, t: 1, kind: 'stall', renders: 2000, windowMs: 3000, component: 'Feed' };
  assert.ok(rules(explain({ screen: s, requests: [], inFlight: 0, trace: [stall] })).includes('render-loop'));
  assert.deepEqual(rules(explain({ screen: s, requests: [req(200, 'http://x/a')], inFlight: 0 })), []);
});

test('an answer the case mocked is not blamed on the backend', () => {
  const s = screen([el({}, 0)], 'Home');
  const mocked = (status: number, url: string): RequestRecord => ({ ...req(status, url), mocked: true });
  const blamed = ['backend-error', 'session-gone', 'forbidden', 'rate-limited'];
  const found = rules(
    explain({
      screen: s,
      requests: [mocked(500, 'http://x/api/limit'), mocked(403, 'http://x/a'), mocked(403, 'http://x/b'), mocked(429, 'http://x/c'), req(200, 'http://x/d')],
      inFlight: 0,
    }),
  );
  assert.deepEqual(
    found.filter((r) => blamed.includes(r)),
    [],
  );
  assert.ok(!rules(explain({ screen: s, requests: [mocked(401, 'http://x/a'), mocked(401, 'http://x/b')], inFlight: 0 })).includes('session-gone'));
  // The server's own 500 next to a mocked one is still named, and it is the one named.
  const both = explain({ screen: s, requests: [mocked(500, 'http://x/api/mocked'), req(502, 'http://x/api/real')], inFlight: 0 });
  assert.match(both.find((f) => f.rule === 'backend-error')?.message ?? '', /502 on GET \/api\/real/);
});

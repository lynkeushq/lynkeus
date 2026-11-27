import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as whyModule from '../why.js';
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

test('a request still in flight is named, with how long it has been open, even if it started before the command', () => {
  const hung = { ...req(undefined, 'http://localhost:3000/api/mobile/v3/user/?x=1'), startedAt: 1_000 };
  const found = explain({ screen: screen([el({}, 0)], 'Home'), requests: [], inFlight: 1, pending: [hung], now: 21_500 });
  const message = found.find((f) => f.rule === 'in-flight')?.message ?? '';
  assert.match(message, /GET \/api\/mobile\/v3\/user\/ \(open 20\.5 s\)/);
  // On a virtual clock the age would be nonsense: the request is still named, without it.
  const virtual = explain({ screen: screen([el({}, 0)], 'Home'), requests: [], inFlight: 1, pending: [hung], now: 1_800_000_000_000 });
  assert.match(virtual.find((f) => f.rule === 'in-flight')?.message ?? '', /\(GET \/api\/mobile\/v3\/user\/\):/);
  // Without the records, the count alone, as before.
  const bare = explain({ screen: screen([el({}, 0)], 'Home'), requests: [], inFlight: 2 });
  assert.match(bare.find((f) => f.rule === 'in-flight')?.message ?? '', /^2 request\(s\) still in flight when the command gave up:/);
});

test('a missing element next to a failed request is put down to that request, mocked or not', () => {
  const s = screen([el({ kind: 'text', text: 'Orders' }, 0)], 'Orders');
  const mocked = { ...req(500, 'http://x/api/orders'), mocked: true };
  const found = explain({ screen: s, requests: [mocked], inFlight: 0, target: { testId: 'order-0' } });
  const linked = found.find((f) => f.rule === 'request-failed');
  assert.match(
    linked?.message ?? '',
    /^#order-0 is not on screen and GET \/api\/orders 500 \(mocked\) failed: the screen is likely showing its empty or error state/,
  );
  assert.ok(
    rules(
      explain({ screen: s, requests: [req(undefined, 'http://x/api/orders', 'Network request failed')], inFlight: 0, target: { text: 'Order #1' } }),
    ).includes('request-failed'),
  );
  // An element that is there is not explained by a request.
  assert.ok(!rules(explain({ screen: s, requests: [mocked], inFlight: 0, target: { text: 'Orders' } })).includes('request-failed'));
});

test('a missing element whose screen got its data says so, when nothing else explains it', () => {
  const s = screen([el({ kind: 'text', text: 'No orders yet' }, 0)], 'Orders');
  const found = explain({ screen: s, requests: [req(200, 'http://x/api/orders'), req(304, 'http://x/api/me')], inFlight: 0, target: { testId: 'order-0' } });
  assert.deepEqual(rules(found), ['requests-ok']);
  assert.match(found[0]!.message, /GET \/api\/orders 200, GET \/api\/me 304\): the data came/);
  assert.ok(
    !rules(explain({ screen: s, requests: [req(200, 'http://x/api/orders')], inFlight: 0, target: { text: 'No orders yet' } })).includes('requests-ok'),
  );
});

test('a sought text that is not on screen names the closest one there, by edits, containment or shared words', () => {
  const at = (texts: string[]) =>
    screen(
      texts.map((text, i) => el({ kind: 'text', text }, i)),
      'Home',
    );
  const near = (texts: string[], text: string) =>
    explain({ screen: at(texts), requests: [], inFlight: 0, target: { text } }).find((f) => f.rule === 'near-match')?.message;
  assert.equal(near(['Podcasts', 'Meet the community'], 'Community'), '"Community" is not on screen; "Meet the community" is (the text may have changed)');
  assert.equal(
    near(['Sign in to continue', 'Help'], 'Sign in to your account'),
    '"Sign in to your account" is not on screen; "Sign in to continue" is (the text may have changed)',
  );
  // The closest wins over the first close one.
  assert.match(near(['Communities near you', 'Comunity'], 'Community') ?? '', /; "Comunity" is/);
  assert.equal(near(['Podcasts', 'Settings'], 'Community'), undefined);
  assert.equal(near(['Book'], 'ok'), undefined);
});

const DIFF = `diff --git a/app/i18n/en.ts b/app/i18n/en.ts
index 1..2 100644
--- a/app/i18n/en.ts
+++ b/app/i18n/en.ts
@@ -3 +3 @@ const en = {
-  common: { ok: "OK!" },
+  common: { ok: "Okay" },
@@ -12 +12 @@ const en = {
-    title: "Community",
+    title: "Meet the community",
`;

test('a diff that took the sought text out names its file and line, and what replaced it', () => {
  const { textChangeIn } = whyModule;
  assert.deepEqual(textChangeIn(DIFF, 'Community'), {
    file: 'app/i18n/en.ts',
    line: 12,
    before: 'title: "Community",',
    after: 'title: "Meet the community",',
  });
  assert.equal(textChangeIn(DIFF, 'community'), undefined);
  assert.equal(textChangeIn(DIFF, 'Podcasts'), undefined);
  const s = screen([el({ kind: 'text', text: 'Meet the community' }, 0)], 'Home');
  const found = explain({ screen: s, requests: [], inFlight: 0, target: { text: 'Community' }, sourceDiff: DIFF });
  assert.equal(
    found[0]?.message,
    '"Community" is not on screen; "Meet the community" is (the text may have changed)\n    app/i18n/en.ts:12 changed it in the working tree: title: "Community", → title: "Meet the community",',
  );
  const elsewhere = explain({
    screen: screen([el({ kind: 'text', text: 'Podcasts' }, 0)], 'Home'),
    requests: [],
    inFlight: 0,
    target: { text: 'Community' },
    sourceDiff: DIFF,
  });
  assert.equal(elsewhere[0]?.rule, 'text-changed');
  assert.match(elsewhere[0]?.message ?? '', /^"Community" is not on screen; app\/i18n\/en\.ts:12 changed it/);
});

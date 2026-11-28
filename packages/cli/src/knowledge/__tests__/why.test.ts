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

test('a 2xx the app logged an error about is named as a body of the wrong shape', () => {
  const s = screen([el({ kind: 'text', text: 'So empty... so sad' }, 0)], 'DemoPodcastList');
  const feed = { ...req(200, 'http://x/v1/api.json'), mocked: true };
  const found = explain({
    screen: s,
    requests: [feed],
    inFlight: 0,
    target: { text: 'RNR 1: Episode' },
    logs: [
      { level: 'info', text: 'loaded' },
      { level: 'error', text: 'Error fetching episodes: bad-data\n  at getEpisodes' },
    ],
  });
  assert.deepEqual(rules(found), ['bad-body']);
  assert.match(found[0]!.message, /GET \/v1\/api\.json 200 \(mocked\) answered, and then the app logged "Error fetching episodes: bad-data"/);
  assert.match(found[0]!.message, /mocked body is the case’s own/);
  // Without the console, a mocked 2xx still says the data came and that its body is the case's.
  const quiet = explain({ screen: s, requests: [feed], inFlight: 0, target: { text: 'RNR 1: Episode' } });
  assert.deepEqual(rules(quiet), ['requests-ok']);
  assert.match(quiet[0]!.message, /mocked body is the case’s own/);
  // A request that failed outright is that request's doing, not its body's.
  assert.ok(
    !rules(
      explain({
        screen: s,
        requests: [req(500, 'http://x/v1/a'), req(200, 'http://x/v1/b')],
        inFlight: 0,
        target: { text: 'X' },
        logs: [{ level: 'error', text: 'boom' }],
      }),
    ).includes('bad-body'),
  );
});

test('a probe Lynkeus sends itself is never the last command that failed', () => {
  const s = screen([el({}, 0)], 'Home');
  const probe: TraceEvent = { seq: 1, t: 1, kind: 'command', method: 'memory', ms: 1, error: 'Unknown method memory' };
  assert.deepEqual(rules(explain({ screen: s, requests: [], inFlight: 0, trace: [probe] })), []);
  const own: TraceEvent = { seq: 2, t: 2, kind: 'command', method: 'signOut', ms: 1, error: 'Unknown method signOut' };
  assert.deepEqual(rules(explain({ screen: s, requests: [], inFlight: 0, trace: [own, probe] })), ['last-error']);
});

test('a request a host with no network could not send says so and to mock it, not that the network failed', () => {
  const s = screen([el({ kind: 'text', text: 'So empty... so sad' }, 0)], 'DemoPodcastList');
  const feed = req(0, 'https://api.rss2json.com/v1/api.json?rss_url=x', 'network error or aborted');
  const local = req(0, 'http://localhost:3000/health', 'network error or aborted');
  const found = explain({ screen: s, requests: [feed, local], inFlight: 0, target: { text: 'Episode One' }, noNetwork: true });
  assert.deepEqual(rules(found), ['host-offline', 'request-failed']);
  assert.equal(
    found[0]?.message,
    'this host has no network: GET /v1/api.json never left it (it reaches only this machine); mock the request (app.mock: { route: "GET /v1/api.json", body: … })',
  );
  // Only the local request, which this host does send, is left for request-failed.
  assert.match(found[1]?.message ?? '', /GET \/health network error or aborted failed/);
  assert.doesNotMatch(found[1]?.message ?? '', /api\.json/);
  // A mocked answer is the case's own; a host with network is not told it has none.
  assert.ok(
    !rules(explain({ screen: s, requests: [{ ...feed, mocked: true }], inFlight: 0, target: { text: 'Episode One' }, noNetwork: true })).includes(
      'host-offline',
    ),
  );
  assert.ok(!rules(explain({ screen: s, requests: [feed], inFlight: 0, target: { text: 'Episode One' } })).includes('host-offline'));
});

test("React's act() warnings on the headless host are never given as why", () => {
  const s = screen([el({ kind: 'text', text: 'Login' }, 0)], 'Login');
  const act = {
    level: 'error',
    text: 'Warning: An update to ForwardRef(Screen) inside a test was not wrapped in act(...).\n\nWhen testing, code that causes React state updates should be wrapped into act(...)',
  };
  assert.deepEqual(rules(explain({ screen: s, requests: [], inFlight: 0, target: { text: 'Welcome' }, logs: [act] })), []);
  assert.deepEqual(
    rules(explain({ screen: s, requests: [], inFlight: 0, target: { text: 'Welcome' }, logs: [act, { level: 'error', text: 'TypeError: x is undefined' }] })),
    ['app-logged'],
  );
});

test('a missing item whose kind is on screen says the case points at another item, before blaming the body', () => {
  const s = screen(
    [
      el({ kind: 'text', text: 'RNR 902 - Mocked Second Episode' }, 0),
      el({ kind: 'text', text: 'RNR 903 - Mocked Third Episode' }, 1),
      el({ kind: 'button', text: 'Log In' }, 2),
    ],
    'DemoPodcastList',
  );
  const feed = { ...req(200, 'https://api.rss2json.com/v1/api.json'), mocked: true };
  const logs = [{ level: 'error', text: 'Error fetching episodes: {"kind":"server"}' }];
  const found = explain({ screen: s, requests: [feed], inFlight: 0, target: { text: 'RNR 901 - Mocked First Episode' }, logs });
  assert.deepEqual(rules(found), ['same-kind']);
  assert.match(
    found[0]!.message,
    /^"RNR 901 - Mocked First Episode" is not on screen, but others of its kind are \("RNR 902 - Mocked Second Episode", "RNR 903 - Mocked Third Episode"\): the data came/,
  );
  // Two words are not a kind: a missing "Log Out" is not put down to "Log In".
  assert.ok(!rules(explain({ screen: s, requests: [feed], inFlight: 0, target: { text: 'Log Out' } })).includes('same-kind'));
});

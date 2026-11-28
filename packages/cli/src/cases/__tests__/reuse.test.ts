import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Seen } from '../coverage.js';
import { draftCase } from '../draft.js';
import { type Case, parseCase, type Step } from '../format.js';
import { macroSnippet, repeatedOpening, stepLine, wayTo } from '../reuse.js';
import { label } from '../runner.js';

const make = (id: string, setup: Step[], steps: Step[], file = `${id}.md`): Case => ({ file, id, meta: {}, setup, teardown: [], steps });

const login: Step[] = [
  { verb: 'app.type', value: { target: '#email', text: '{{u.email}}' } },
  { verb: 'app.type', value: { target: '#password', text: 'secret' } },
  { verb: 'app.press', value: '#sign-in' },
];
const user: Step = { verb: 'create_user', value: { as: 'u' } };

const pay = make('pay-ten', [user], [...login, { verb: 'app.press', value: '#pay' }, { verb: 'app.press', value: '#amount-10' }]);
// What the last passing run kept: the screen after each step.
const walked = (c: Case, routes: (string | undefined)[]): Seen => ({
  routes: routes.filter((r): r is string => !!r),
  steps: [...c.setup, ...c.steps].map((s, i) => ({ step: label(s), ...(routes[i] ? { route: routes[i] } : {}) })),
});
const paySeen = walked(pay, [undefined, 'Login.Main', 'Login.Main', 'Home.Main', 'Pay.Main', 'Pay.Amount']);

test('a case whose last passing run reached the screen offers its setup and its steps up to there', () => {
  const way = wayTo([pay], { 'pay-ten': paySeen }, 'Pay.Main');
  assert.equal(way?.source, 'pay-ten');
  assert.equal(way?.how, 'ran');
  assert.deepEqual(way?.setup, [user]);
  assert.deepEqual(way?.steps, [...login, { verb: 'app.press', value: '#pay' }]);
});

test('a run kept for a case that has changed since is not trusted; a step that names the screen still is', () => {
  const changed = make(
    'pay-ten',
    [user],
    [...login, { verb: 'app.press', value: '#pay-now' }, { verb: 'app.wait', value: { what: 'Pay.Main', timeoutMs: 5000 } }],
  );
  const way = wayTo([changed], { 'pay-ten': paySeen }, 'Pay.Main');
  assert.equal(way?.how, 'named');
  assert.equal(way?.steps.length, 5);
  assert.equal(wayTo([changed], { 'pay-ten': paySeen }, 'Pay.Amount'), undefined);
});

test('the shortest way wins, the case being drafted is left out, and --from takes only the steps after that screen', () => {
  const nav = make('settings', [], [{ verb: 'app.nav', value: 'Pay.Main' }]);
  assert.equal(wayTo([pay, nav], { 'pay-ten': paySeen }, 'Pay.Main')?.source, 'settings');
  assert.equal(wayTo([pay, nav], { 'pay-ten': paySeen }, 'Pay.Main', { skip: 'settings' })?.source, 'pay-ten');
  const fromHome = wayTo([pay], { 'pay-ten': paySeen }, 'Pay.Amount', { from: 'Home.Main' });
  assert.deepEqual(fromHome?.setup, []);
  assert.deepEqual(fromHome?.steps, [
    { verb: 'app.press', value: '#pay' },
    { verb: 'app.press', value: '#amount-10' },
  ]);
});

test('the macros a way calls are named', () => {
  const c = make(
    'a',
    [],
    [
      { verb: 'app.login', value: { as: 'u' } },
      { verb: 'app.see', value: { route: 'Home.Main' } },
    ],
  );
  assert.deepEqual(wayTo([c], {}, 'Home.Main', { macros: ['app.login'] })?.macros, ['app.login']);
});

test('a draft with a way from a case is a case that parses, says where the way comes from, and checks the screen once', () => {
  const way = wayTo([pay], { 'pay-ten': paySeen }, 'Pay.Main')!;
  const text = draftCase({ id: 'pay-other', from: 'Home.Main', to: 'Pay.Main', path: undefined, way });
  assert.match(text, /# The way to Pay\.Main from case pay-ten \(its last passing run was on Pay\.Main after these steps\):/);
  const c = parseCase(text, 'pay-other.md');
  assert.deepEqual(c.setup, [user]);
  assert.deepEqual(c.steps, [...login, { verb: 'app.press', value: '#pay' }, { verb: 'app.see', value: { route: 'Pay.Main' } }]);
  const named = wayTo(
    [
      make(
        'w',
        [],
        [
          { verb: 'app.press', value: '#go' },
          { verb: 'app.see', value: { route: 'Pay.Main' } },
        ],
      ),
    ],
    {},
    'Pay.Main',
  )!;
  const again = parseCase(draftCase({ id: 'x', from: 'Home.Main', to: 'Pay.Main', path: undefined, way: named }), 'x.md');
  assert.equal(again.steps.filter((s) => s.verb === 'app.see').length, 1);
});

test('a step goes back into a case as the YAML it came from', () => {
  for (const step of [
    { verb: 'app.press', value: '#refresh' },
    { verb: 'app.type', value: { target: '#name', text: '{{u.email}}', timeoutMs: 400 } },
    { verb: 'app.back', value: null },
    { verb: 'app.see', value: 'Count: 2' },
  ] as Step[]) {
    const c = parseCase(`---\nid: x\n---\nsteps:\n  ${stepLine(step)}\n`, 'x.md');
    assert.deepEqual(c.steps, [step]);
  }
  const on = parseCase(`---\nid: x\n---\nsteps:\n  ${stepLine({ verb: 'app.press', value: '#ok', on: 'ios' })}\n`, 'x.md');
  assert.deepEqual(on.steps, [{ verb: 'app.press', value: '#ok', on: 'ios' }]);
});

const opens = (id: string, extra: Step[] = [], file?: string) => make(id, [user], [...login, ...extra], file);

test('three case files that open with the same app steps get one macro to declare', () => {
  const late = { verb: 'app.type', value: { target: '#email', text: '{{u.email}}', timeoutMs: 9000 } } as Step;
  const cases = [
    opens('a', [{ verb: 'app.press', value: '#pay' }]),
    opens('b', [{ verb: 'app.press', value: '#cards' }]),
    make('c', [user], [late, ...login.slice(1)]),
    make('d', [], [{ verb: 'app.press', value: '#sign-up' }]),
  ];
  const r = repeatedOpening(cases);
  assert.deepEqual(r?.cases, ['a', 'b', 'c']);
  assert.equal(r?.steps.length, 3);
  assert.equal(
    macroSnippet(r!),
    '"app.openCase": [{"app.type":{"target":"#email","text":"{{u.email}}"}},{"app.type":{"target":"#password","text":"secret"}},{"app.press":"#sign-in"}]',
  );
});

test('two cases, one step, or matrix variants of one file are not worth a macro', () => {
  assert.equal(repeatedOpening([opens('a'), opens('b')]), undefined);
  const one = [0, 1, 2].map((n) =>
    make(
      `x${n}`,
      [],
      [
        { verb: 'app.press', value: '#go' },
        { verb: 'app.press', value: `#n${n}` },
      ],
    ),
  );
  assert.equal(repeatedOpening(one), undefined);
  assert.equal(repeatedOpening([opens('m[a=1]', [], 'm.md'), opens('m[a=2]', [], 'm.md'), opens('m[a=3]', [], 'm.md')]), undefined);
});

test('a macro is named after the screen its steps reach, and one already declared is named instead', () => {
  const toHome = [...login, { verb: 'app.wait', value: { what: 'Home.Main' } }] as Step[];
  const cases = ['a', 'b', 'c'].map((id) => make(id, [], toHome));
  assert.equal(repeatedOpening(cases)?.macro, 'app.goToHomeMain');
  const declared = repeatedOpening(cases, { 'app.login': toHome.map((s) => ({ [s.verb]: s.value })) });
  assert.equal(declared?.declared, 'app.login');
});

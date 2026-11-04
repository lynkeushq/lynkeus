import assert from 'node:assert/strict';
import { test } from 'node:test';

import { coverageOf, impactOf, routesNamed } from '../coverage.js';
import type { Case } from '../format.js';

const c = (id: string, steps: Case['steps']): Case => ({ file: `${id}.md`, id, meta: {}, setup: [], steps });

test('a case touches the routes it goes to, waits for or checks', () => {
  const k = c('a', [
    { verb: 'app.nav', value: 'Home.Main' },
    { verb: 'app.wait', value: { what: 'Pay.Main', timeoutMs: 1 } },
    { verb: 'app.see', value: { route: 'Pay.Done' } },
    { verb: 'app.see', value: { text: 'Hello' } },
    { verb: 'app.wait', value: '#button' },
  ]);
  assert.deepEqual(routesNamed(k), ['Home.Main', 'Pay.Main', 'Pay.Done']);
});

test('coverage counts named and seen routes, and flags names the app does not know', () => {
  const cov = coverageOf(
    [c('a', [{ verb: 'app.nav', value: 'Home.Main' }]), c('b', [{ verb: 'app.nav', value: 'Old.Screen' }])],
    ['Home.Main', 'Pay.Main', 'Pay.Done'],
    { b: ['Pay.Main'] },
  );
  assert.deepEqual(cov.covered, ['Home.Main', 'Pay.Main']);
  assert.deepEqual(cov.uncovered, ['Pay.Done']);
  assert.deepEqual(cov.unknown, ['Old.Screen']);
});

test('impact runs the cases that touch a reached screen, nearest first, and lists reached screens nobody covers', () => {
  const cov = coverageOf(
    [c('far', [{ verb: 'app.nav', value: 'Home.Main' }]), c('near', [{ verb: 'app.nav', value: 'Pay.Main' }])],
    ['Home.Main', 'Pay.Main', 'Pay.Done'],
  );
  const impact = impactOf(
    [
      { route: 'Home.Main', distance: 3, via: 'a.ts', through: [] },
      { route: 'Pay.Main', distance: 1, via: 'b.ts', through: [] },
      { route: 'Pay.Done', distance: 1, via: 'b.ts', through: [] },
    ],
    cov,
  );
  assert.deepEqual(
    impact.cases.map((x) => x.id),
    ['near', 'far'],
  );
  assert.deepEqual(impact.untested, ['Pay.Done']);
});

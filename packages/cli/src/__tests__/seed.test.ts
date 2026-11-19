import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { interpolate, type Scope, seeded } from '../cases/format.js';

const names = (id: string): string[] => {
  const scope: Scope = {};
  seeded(scope, id);
  return [interpolate('{{random.letters}}', scope), interpolate('{{random.letters}}', scope), interpolate('{{random.digits}}', scope)];
};

const names2 = (seed: string, id: string): string[] => {
  process.env.LYNKEUS_SEED = seed;
  try {
    return names(id);
  } finally {
    delete process.env.LYNKEUS_SEED;
  }
};

afterEach(() => {
  delete process.env.LYNKEUS_SEED;
});

test('a seeded case draws the same random values on every run, and its own', () => {
  process.env.LYNKEUS_SEED = 'compare';
  const first = names('send-money');
  assert.deepEqual(names('send-money'), first);
  assert.notEqual(first[0], first[1]);
  assert.notDeepEqual(names('request-money'), first);
  assert.match(first[0]!, /^[a-z]{6}$/);
  assert.match(first[2]!, /^\d{6}$/);
});

test('a setup made ahead hands its place in the sequence to the case', () => {
  process.env.LYNKEUS_SEED = 'compare';
  const whole: Scope = {};
  seeded(whole, 'send-money');
  const together = [interpolate('{{random.letters}}', whole), interpolate('{{random.letters}}', whole)];
  const setup: Scope = {};
  seeded(setup, 'send-money');
  const made = interpolate('{{random.letters}}', setup);
  const rest = structuredClone(setup);
  seeded(rest, 'send-money');
  assert.deepEqual([made, interpolate('{{random.letters}}', rest)], together);
});

test('without a seed every run differs', () => {
  assert.notDeepEqual(names('send-money'), names('send-money'));
});

test('a seed given to the run beats LYNKEUS_SEED', () => {
  process.env.LYNKEUS_SEED = 'env';
  const scope: Scope = {};
  seeded(scope, 'send-money', 'flag');
  const given = [interpolate('{{random.letters}}', scope), interpolate('{{random.letters}}', scope), interpolate('{{random.digits}}', scope)];
  delete process.env.LYNKEUS_SEED;
  assert.deepEqual(given, names2('flag', 'send-money'));
});

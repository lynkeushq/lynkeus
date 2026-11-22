import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { type Adapter, createAdapter, type ExactWire, mapElements, spawnWire } from '../index.js';

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'example', 'fake-exact.mjs');
let wire: ExactWire;
let adapter: Adapter;

before(() => {
  wire = spawnWire(process.execPath, [fake]);
  adapter = createAdapter(wire, { epochMs: Date.parse('2026-03-01T09:00:00Z') });
});
after(() => wire.close());

const screen = () => adapter.call('screen', undefined) as Promise<import('lynkeus-protocol').Screen>;

test('screen lists the app as elements: kinds, text, labels and frames', async () => {
  const s = await screen();
  assert.deepEqual(s.window, { w: 402, h: 874 });
  const byId = Object.fromEntries(s.elements.filter((e) => e.testId).map((e) => [e.testId, e]));
  assert.equal(byId.count?.kind, 'text');
  assert.equal(byId.count?.text, 'Count: 0');
  assert.equal(byId.increment?.kind, 'button');
  assert.equal(byId.increment?.text, 'Add one');
  assert.equal(byId.name?.kind, 'input');
  assert.equal(byId.name?.placeholder, 'Your name');
  assert.equal(byId.locked?.enabled, false);
  assert.deepEqual(byId.increment?.frame, { x: 16, y: 40 + 3 * 48, w: 200, h: 44 });
});

test('press taps the element a target names, by test id or by its label', async () => {
  await adapter.call('press', { testId: 'increment' });
  await adapter.call('press', { text: 'Add one' });
  const s = await screen();
  assert.equal(s.elements.find((e) => e.testId === 'count')?.text, 'Count: 2');
});

test('press refuses a disabled control and a target that matches nothing, saying so', async () => {
  await assert.rejects(adapter.call('press', { testId: 'locked' }), /disabled/);
  await assert.rejects(adapter.call('press', { testId: 'nope' }), /No element matches/);
});

test('type writes into a field it taps first, and into the focused one without a target', async () => {
  await adapter.call('type', { text: 'Ana', target: { testId: 'name' } });
  await adapter.call('type', { text: ' Ruiz' });
  const s = await screen();
  assert.equal(s.elements.find((e) => e.testId === 'name')?.value, 'Ana Ruiz');
  await adapter.call('type', { text: 'Bo', target: { testId: 'name' }, clear: true });
  assert.equal((await screen()).elements.find((e) => e.testId === 'name')?.value, 'Bo');
});

test('waitFor spends the app’s own time: a three second countdown ends without waiting three seconds', async () => {
  await adapter.call('press', { testId: 'send' });
  assert.ok((await screen()).elements.some((e) => e.text === 'Resend in 3'));
  const started = Date.now();
  const answer = (await adapter.call('waitFor', { target: { text: 'Resend now' }, timeoutMs: 10_000 })) as { waitedMs: number };
  assert.ok(Date.now() - started < 2000, 'real time stayed short');
  assert.ok(answer.waitedMs >= 3000 && answer.waitedMs <= 3200, `waited ${answer.waitedMs} ms of app time`);
});

test('waitFor times out in app time and names what it waited for', async () => {
  await assert.rejects(adapter.call('waitFor', { target: { text: 'Never' }, timeoutMs: 500 }), /Timed out after 500 ms \(app time\)/);
});

test('clock advance moves the app’s clock by exactly that much and reports Date', async () => {
  const before = (await adapter.call('clock', {})) as { now: string };
  const after = (await adapter.call('clock', { advanceMs: 4000 })) as { now: string; advancedMs: number };
  assert.equal(after.advancedMs, 4000);
  assert.equal(Date.parse(after.now) - Date.parse(before.now), 4000);
});

test('clock now and reset say that the date is a launch fact', async () => {
  await assert.rejects(adapter.call('clock', { now: '2030-01-01T00:00:00Z' }), /launch fact/);
});

test('idle settles once the app stops changing, and batch runs calls in order', async () => {
  const answer = (await adapter.call('idle', { quietMs: 200 })) as { idle: boolean };
  assert.equal(answer.idle, true);
  const { results } = (await adapter.call('batch', { calls: [{ method: 'press', params: { testId: 'increment' } }, { method: 'screen' }] })) as {
    results: [unknown, import('lynkeus-protocol').Screen];
  };
  assert.equal(results[1].elements.find((e) => e.testId === 'count')?.text, 'Count: 3');
});

test('an unknown method is an error, as on every host', async () => {
  await assert.rejects(adapter.call('teleport', {}), /Unknown method teleport/);
});

test('mapElements leaves out plain wrappers and masks a secure field', () => {
  const { elements } = mapElements(
    [
      { id: 1, type: 'View', depth: 0, props: {} },
      { id: 2, type: 'TextInput', depth: 1, props: { testId: 'pin', value: '1234', secure: true } },
    ],
    [{ id: 2, x: 1, y: 2, w: 3, h: 4 }],
  );
  assert.equal(elements.length, 1);
  assert.equal(elements[0]?.value, '••••');
});

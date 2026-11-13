import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Turns } from '../turns.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

// Four jobs taking cases in order, each case "running" until the test lets it end.
const runner = () => {
  const turns = new Turns();
  const log: string[] = [];
  const running = new Set<string>();
  let most = 0;
  const ends = new Map<string, () => void>();
  const run = async (id: string, alone: boolean) => {
    const release = await turns.take(alone);
    running.add(id);
    log.push(`start ${id}${running.size > 1 ? ` with ${[...running].filter((r) => r !== id).join(',')}` : ''}`);
    most = Math.max(most, running.size);
    await new Promise<void>((resolve) => ends.set(id, resolve));
    running.delete(id);
    log.push(`end ${id}`);
    release();
  };
  const end = async (id: string) => {
    while (!ends.has(id)) await tick();
    ends.get(id)!();
    ends.delete(id);
    await tick();
  };
  return { turns, log, run, end, running, most: () => most };
};

test('cases side by side run together; one that runs alone waits for them and keeps the rest out', async () => {
  const r = runner();
  const done = [r.run('a', false), r.run('b', false), r.run('flags', true), r.run('c', false)];
  await tick();
  // a and b are in flight; flags waits for them, and c, which asked after flags, waits behind it.
  assert.deepEqual([...r.running].sort(), ['a', 'b']);
  await r.end('a');
  assert.deepEqual([...r.running], ['b']);
  await r.end('b');
  assert.deepEqual([...r.running], ['flags']);
  await r.end('flags');
  assert.deepEqual([...r.running], ['c']);
  await r.end('c');
  await Promise.all(done);
  // Nothing ran beside it.
  assert.ok(!r.log.some((l) => l.includes(' with ') && l.includes('flags')));
});

test('two cases that run alone take turns, and the others go after them', async () => {
  const r = runner();
  const done = [r.run('one', true), r.run('two', true), r.run('x', false)];
  await tick();
  assert.deepEqual([...r.running], ['one']);
  await r.end('one');
  assert.deepEqual([...r.running], ['two']);
  await r.end('two');
  assert.deepEqual([...r.running], ['x']);
  await r.end('x');
  await Promise.all(done);
  assert.equal(r.most(), 1);
});

test('busy says whether a case asking now would wait, and a release counts once', async () => {
  const turns = new Turns();
  assert.equal(turns.busy(true), false);
  const release = await turns.take(false);
  assert.equal(turns.busy(true), true);
  assert.equal(turns.busy(false), false);
  release();
  release();
  assert.equal(turns.busy(true), false);
  const alone = await turns.take(true);
  assert.equal(turns.busy(false), true);
  alone();
  assert.equal(turns.busy(false), false);
});

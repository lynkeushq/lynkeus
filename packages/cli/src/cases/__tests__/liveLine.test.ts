import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fit, LiveLine } from '../liveLine.js';

test('the status line is cut to the terminal’s width, an emoji counting two columns', () => {
  assert.equal(fit('12/52 ✅10', 40), '12/52 ✅10');
  assert.equal(fit('abcdefghij', 6), 'abcd…');
  // Two columns each: ✅ and ❌ take four of the five the line has room for.
  assert.equal(fit('✅✅✅✅', 6), '✅✅…');
  assert.equal(fit('a\n  b', 10), 'a b');
});

test('what else is written goes above the line, which is drawn again under it, and stopping gives the stream back', () => {
  const written: string[] = [];
  const stream = { columns: 30, write: (chunk: string | Uint8Array) => written.push(String(chunk)) > 0 };
  const original = stream.write;
  let status = '1/3';
  const line = new LiveLine(stream, () => status, 60_000);
  assert.deepEqual(written, ['1/3']);
  stream.write('▶ a case\n');
  assert.deepEqual(written.slice(1), ['\r\x1b[2K', '▶ a case\n', '1/3']);
  status = '2/3';
  line.refresh();
  assert.deepEqual(written.slice(-2), ['\r\x1b[2K', '2/3']);
  line.stop();
  assert.equal(written.at(-1), '\r\x1b[2K');
  assert.equal(stream.write, original);
});

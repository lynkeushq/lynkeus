import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { PNG } from 'pngjs';

import { compactFrame } from '../frames.js';

test('a PNG frame is kept as AVIF, a fraction of its bytes, and the PNG removed', async () => {
  const png = new PNG({ width: 64, height: 64 });
  for (let i = 0; i < png.data.length; i += 4) png.data.set([i % 255, 40, 200, 255], i);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-frame-')), '01-app-login.png');
  fs.writeFileSync(file, PNG.sync.write(png));
  const out = await compactFrame(file);
  assert.equal(out, file.replace(/\.png$/, '.avif'));
  assert.ok(fs.existsSync(out));
  assert.ok(!fs.existsSync(file));
  assert.equal(fs.readFileSync(out).subarray(4, 12).toString(), 'ftypavif');
});

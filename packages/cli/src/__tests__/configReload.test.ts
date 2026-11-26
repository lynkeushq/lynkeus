import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { configReader } from '../config.js';

test('the config a long-lived process reads follows the file, and only parses it again when it changed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-config-'));
  const file = path.join(root, 'lynkeus.config.json');
  const read = configReader(root);
  assert.deepEqual(read(), {});

  fs.writeFileSync(file, JSON.stringify({ app: 'com.one' }));
  assert.equal(read().app, 'com.one');
  const same = read();
  assert.equal(read(), same);

  fs.writeFileSync(file, JSON.stringify({ app: 'com.two', cases: { start: ['x'] } }));
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
  assert.equal(read().app, 'com.two');
  assert.deepEqual(read().cases?.start, ['x']);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { Fixtures } from '../fixtures.js';

test('a fixtures command that cannot start is not started again for every case', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lk-fixtures-'));
  const starts = path.join(dir, 'starts');
  const fixtures = new Fixtures({ command: `echo x >> ${starts}; echo 'cd: ../olympus: No such file or directory' >&2; exit 1` }, dir);
  for (let i = 0; i < 2; i++) await assert.rejects(fixtures.call('login_state', {}), /the fixtures command ended: cd: \.\.\/olympus/);
  await assert.rejects(fixtures.call('login_state', {}), /not started again in this run/);
  assert.equal(fs.readFileSync(starts, 'utf8').trim().split('\n').length, 2);
  fixtures.close();
});

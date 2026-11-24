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

test('a request names the case it belongs to, so a server can start each case afresh', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lk-fixtures-'));
  const echo = path.join(dir, 'echo.mjs');
  fs.writeFileSync(
    echo,
    "import readline from 'node:readline';\nfor await (const line of readline.createInterface({ input: process.stdin })) console.log(JSON.stringify({ ok: true, got: JSON.parse(line) }));\n",
  );
  const fixtures = new Fixtures({ command: `node ${echo}` }, dir);
  const inCase = await fixtures.call('create_user', { country: 'ar' }, 'sign-up');
  assert.deepEqual(inCase.got, { command: 'create_user', params: { country: 'ar' }, env: { COUNTRY: 'ar' }, case: 'sign-up' });
  const alone = await fixtures.call('create_user', {});
  assert.equal((alone.got as Record<string, unknown>).case, undefined);
  fixtures.close();
});

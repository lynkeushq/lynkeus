import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { Fixtures, lastDescription, readDescription } from '../cases/fixtures.js';
import { checkDescription } from '../commands/fixtures.js';

test('a server that answers names only is still described', () => {
  const d = readDescription({ commands: ['create_user', 'inspect'] });
  assert.deepEqual(d?.commands, ['create_user', 'inspect']);
  assert.deepEqual(d?.details, [{ name: 'create_user' }, { name: 'inspect' }]);
});

test('names and descriptions mix, and the details keep what the server said', () => {
  const d = readDescription({
    protocol: 1,
    commands: ['inspect', { name: 'create_user', summary: 'A user ready to sign in', params: { country: { values: ['ar', 'mx'] } } }],
  });
  assert.deepEqual(d?.commands, ['inspect', 'create_user']);
  assert.equal(d?.details[1]?.summary, 'A user ready to sign in');
  assert.equal(d?.protocol, 1);
});

test('anything that is not a list of names or descriptions is no description', () => {
  assert.equal(readDescription({ commands: [3] }), undefined);
  assert.equal(readDescription({ ok: false }), undefined);
  assert.equal(readDescription(undefined), undefined);
});

test('check fails a server that is down, repeats a name or speaks a newer protocol, and points at summaries', () => {
  assert.equal(checkDescription(undefined).ok, false);
  assert.equal(checkDescription(readDescription({ commands: ['a'], down: 'no database' })).ok, false);
  assert.equal(checkDescription(readDescription({ commands: ['a', 'a'] })).ok, false);
  assert.equal(checkDescription(readDescription({ protocol: 99, commands: ['a'] })).ok, false);
  const fine = checkDescription(readDescription({ commands: ['a', { name: 'b', summary: 'B' }] }));
  assert.equal(fine.ok, true);
  assert.match(fine.lines.join('\n'), /1 without a summary \(a\)/);
});

test('what a server describes is kept for the next `fixtures describe`, under the command that answered', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-fixtures-'));
  const server = path.join(root, 'server.js');
  fs.writeFileSync(
    server,
    "require('readline').createInterface({ input: process.stdin }).on('line', () => console.log(JSON.stringify({ commands: ['inspect', { name: 'create_user', summary: 'A user' }] })));",
  );
  const command = `"${process.execPath}" server.js`;
  const fixtures = new Fixtures({ command }, root);
  const d = await fixtures.describe().finally(() => fixtures.close());
  assert.deepEqual(d?.commands, ['inspect', 'create_user']);
  assert.deepEqual(lastDescription(root, command)?.description.commands, ['inspect', 'create_user']);
  assert.equal(lastDescription(root, 'another'), undefined);
});

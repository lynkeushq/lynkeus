import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { describeHolder, portHolder, type Run } from '../device/portHolder.js';

const answers =
  (table: Record<string, string>): Run =>
  async (file, args) => {
    const key = `${file} ${args.join(' ')}`;
    if (key in table) return table[key]!;
    throw new Error(`unexpected ${key}`);
  };

test('names a stale lynkeus mcp of another project, with its release and folder', async () => {
  const holder = await portHolder(
    8123,
    answers({
      'lsof -nP -iTCP:8123 -sTCP:LISTEN -t': '13646\n',
      'ps -o args= -p 13646': 'npm exec lynkeus@0.7.6 mcp\n',
      'lsof -a -p 13646 -d cwd -Fn': 'p13646\nfcwd\nn/Users/me/trials/run2/ShopTrial\n',
    }),
  );
  assert.deepEqual(holder, { pid: 13646, command: 'npm exec lynkeus@0.7.6 mcp', lynkeus: { project: '/Users/me/trials/run2/ShopTrial', version: '0.7.6' } });
  const line = describeHolder(8123, holder, '/Users/me/trials/run3/ShopTrial');
  assert.match(
    line,
    /^port 8123 is taken by pid 13646 \(npm exec lynkeus@0\.7\.6 mcp\): Lynkeus 0\.7\.6 for another project, \/Users\/me\/trials\/run2\/ShopTrial\./,
  );
  assert.match(line, /each project has its own token/);
  assert.match(line, /`kill 13646`/);
});

test('reads the release from the package a node script belongs to, and --root over the folder it runs in', async () => {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'holder-'));
  const dir = path.join(top, 'node_modules', 'lynkeus');
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'lynkeus', version: '0.7.7' }));
  fs.writeFileSync(path.join(dir, 'dist', 'cli.js'), '');
  const holder = await portHolder(
    8123,
    answers({
      'lsof -nP -iTCP:8123 -sTCP:LISTEN -t': '42\n',
      'ps -o args= -p 42': `node ${dir}/dist/cli.js mcp --root app`,
      'lsof -a -p 42 -d cwd -Fn': 'n/work/repo\n',
    }),
  );
  assert.deepEqual(holder?.lynkeus, { project: '/work/repo/app', version: '0.7.7' });
  assert.match(describeHolder(8123, holder, '/work/repo/app'), /Lynkeus 0\.7\.7 for this same project, left by another session/);
  fs.rmSync(top, { recursive: true, force: true });
});

test('a process that is not Lynkeus is named as such, and nothing is claimed when lsof cannot tell', async () => {
  const other = await portHolder(8123, answers({ 'lsof -nP -iTCP:8123 -sTCP:LISTEN -t': '7\n', 'ps -o args= -p 7': 'python3 -m http.server 8123' }));
  assert.deepEqual(other, { pid: 7, command: 'python3 -m http.server 8123' });
  assert.match(describeHolder(8123, other, '/x'), /pid 7 \(python3 -m http\.server 8123\), which is not Lynkeus/);
  assert.equal(await portHolder(8123, answers({})), undefined);
  assert.match(describeHolder(8123, undefined, '/x'), /lsof could not name it/);
  // lynkeus-agent in a path is not the CLI.
  const agent = await portHolder(
    8123,
    answers({ 'lsof -nP -iTCP:8123 -sTCP:LISTEN -t': '9\n', 'ps -o args= -p 9': 'node /app/node_modules/lynkeus-agent/x.js' }),
  );
  assert.equal(agent?.lynkeus, undefined);
});

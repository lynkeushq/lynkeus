/**
 * The runtime boundary: the import rule holds, and a React Native project never loads another runtime's code, so a
 * change inside another runtime's directory cannot reach it.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('no core module imports a runtime, and no runtime imports past the core API', () => {
  const run = spawnSync(process.execPath, [path.join(cli, '..', 'scripts', 'check-runtime-boundary.mjs')], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
});

// Every module the process loads, written to stderr when it ends.
const RECORD = `data:text/javascript,${encodeURIComponent(
  'import{registerHooks}from"node:module";const seen=[];registerHooks({load(url,ctx,next){seen.push(url);return next(url,ctx)}});process.on("exit",()=>process.stderr.write("\\nLOADED "+JSON.stringify(seen)+"\\n"))',
)}`;

const loaded = (cwd: string, ...argv: string[]): string[] => {
  const run = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--import', RECORD, path.join(cli, 'cli.ts'), ...argv], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, LYNKEUS_TOKEN: '', LYNKEUS_CONFIG: '' },
  });
  const line = run.stderr.split('\n').find((l) => l.startsWith('LOADED '));
  assert.ok(line, run.stderr);
  return (JSON.parse(line.slice('LOADED '.length)) as string[]).filter((url) => url.includes('/src/runtimes/')).map((url) => url.replace(/^.*\/src\//, ''));
};

test('`lynkeus --help` loads no runtime, and a React Native project loads only its own', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-boundary-'));
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '0.81.0' } }));
  assert.deepEqual(loaded(project, '--help').sort(), ['runtimes/detect.ts', 'runtimes/index.ts']);
  const status = loaded(project, 'status', '--offline');
  assert.ok(status.includes('runtimes/react-native/index.ts'), status.join(', '));
  assert.deepEqual(
    status.filter((m) => /^runtimes\/(?!react-native\/)[^/]+\//.test(m)),
    [],
  );
});

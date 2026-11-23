#!/usr/bin/env node
// Makes the React Native invariance goldens from another ref's CLI (main by default): checks that ref out in a
// temporary worktree, copies src/__tests__/goldens into it, runs generate.ts there and writes the goldens here.
// The goldens are what that ref does, never something typed in; rnInvariance.test.ts compares the CLI with them.
//
//   pnpm --filter lynkeus goldens:rn [-- --ref origin/main]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const at = process.argv.indexOf('--ref');
const ref = at >= 0 ? process.argv[at + 1] : 'origin/main';
const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const goldens = path.join(cli, 'src/__tests__/goldens');
const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: cli, encoding: 'utf8' }).trim();
const sha = execFileSync('git', ['rev-parse', '--short', ref], { cwd: repo, encoding: 'utf8' }).trim();
const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-goldens-'));
const run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: 'inherit' });

try {
  run('git', ['worktree', 'add', '--detach', tree, sha], repo);
  const there = path.join(tree, 'packages/cli/src/__tests__/goldens');
  fs.rmSync(there, { recursive: true, force: true });
  fs.cpSync(goldens, there, { recursive: true, filter: (file) => !file.startsWith(path.join(goldens, 'rn')) });
  try {
    run('pnpm', ['install', '--frozen-lockfile', '--offline'], tree);
  } catch {
    run('pnpm', ['install', '--frozen-lockfile'], tree);
  }
  run('pnpm', ['--filter', 'lynkeus-protocol', '--filter', 'lynkeus-client', 'run', 'build'], tree);
  run(process.execPath, ['--import', 'tsx', 'src/__tests__/goldens/generate.ts', '--out', path.join(goldens, 'rn'), '--ref', `${ref} ${sha}`], path.join(tree, 'packages/cli'));
} finally {
  execFileSync('git', ['worktree', 'remove', '--force', tree], { cwd: repo });
}

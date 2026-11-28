/**
 * A diff against a base git cannot make (a ref that is not there, a shallow checkout without the base) is an error in
 * every command that picks cases or screens from it: "nothing changed" from it would pass a branch untested.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { ciCommands } from '../commands/ci.js';
import { coverageCommands } from '../commands/coverage.js';
import { changedSources, DiffError, mapCommands } from '../commands/map.js';
import type { ScreenGraph } from '../knowledge/types.js';
import { type Base, register } from '../registry.js';
import { execute } from '../runtime.js';

register([...mapCommands, ...coverageCommands, ...ciCommands]);

const SOURCES = { pattern: /\.[jt]sx?$/, relative: true };

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'init.defaultBranch=main', '-c', 'protocol.file.allow=always', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

/** An app on `main`, a `feature` branch that changed a screen, and `main` gone on past where they split. */
const upstream = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-diff-up-'));
  git(root, 'init', '-q');
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"app","dependencies":{"react-native":"0.80.0"}}');
  fs.mkdirSync(path.join(root, 'cases'));
  fs.writeFileSync(path.join(root, 'cases', 'home.md'), '---\nid: home\n---\nsteps:\n  - app.wait: Home\n');
  fs.writeFileSync(path.join(root, 'Home.tsx'), 'export const Home = 1\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'app');
  git(root, 'checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(root, 'Home.tsx'), 'export const Home = 2\n');
  git(root, 'commit', '-q', '-am', 'feature');
  git(root, 'checkout', '-q', 'main');
  fs.writeFileSync(path.join(root, 'Other.tsx'), 'export const Other = 1\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'main goes on');
  git(root, 'checkout', '-q', 'feature');
  return root;
};

/** A checkout of `feature` with a route map of one screen, as a CI job has after `map build`. */
const checkout = (from: string, ...cloneArgs: string[]) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-diff-ci-'));
  git(os.tmpdir(), 'clone', '-q', ...cloneArgs, '--branch', 'feature', `file://${from}`, root);
  fs.mkdirSync(path.join(root, '.lynkeus'), { recursive: true });
  const graph: ScreenGraph = {
    app: root,
    root,
    extractedAt: new Date().toISOString(),
    screens: { Home: { route: 'Home', component: 'Home', file: 'Home.tsx', declaredIn: 'Home.tsx' } },
    files: {},
    warnings: [],
  };
  fs.writeFileSync(path.join(root, '.lynkeus', 'graph.json'), JSON.stringify(graph));
  return root;
};

const base = (root: string): Base => ({
  root,
  config: { cases: { dir: 'cases', base: root } },
  attached: false,
  err: () => undefined,
  graph: () => JSON.parse(fs.readFileSync(path.join(root, '.lynkeus', 'graph.json'), 'utf8')) as ScreenGraph,
  device: async () => {
    throw new Error('no app');
  },
});

test('a diff against a ref that is not there throws, naming the base, what git said and how to fix it', () => {
  const root = checkout(upstream());
  assert.deepEqual(changedSources(root, 'origin/main', SOURCES), ['Home.tsx']);
  assert.throws(
    () => changedSources(root, 'origin/does-not-exist', SOURCES),
    (error: unknown) =>
      error instanceof DiffError &&
      /^could not diff against origin\/does-not-exist: fatal: .*does-not-exist/.test(error.message) &&
      /origin\/does-not-exist is not a ref in this checkout: pass --base .*git fetch origin does-not-exist/.test(error.message),
  );
});

test('a shallow checkout that does not hold where the branch left its base says to fetch the history', () => {
  const root = checkout(upstream(), '--depth', '1', '--no-single-branch');
  assert.equal(git(root, 'rev-parse', '--is-shallow-repository').trim(), 'true');
  assert.throws(
    () => changedSources(root, 'origin/main', SOURCES),
    (error: unknown) => error instanceof DiffError && /the checkout is shallow .*git fetch --unshallow.*fetch-depth: 0/.test(error.message),
  );
  // Only the branch fetched, shallow: the base is not there at all, and both fixes are named.
  const single = checkout(upstream(), '--depth', '1');
  assert.throws(
    () => changedSources(single, 'origin/main', SOURCES),
    (error: unknown) =>
      error instanceof DiffError && /is not a ref in this checkout.*the checkout is also shallow: `git fetch --unshallow`/.test(error.message),
  );
});

test('case impact, map check and ci --affected fail on a diff they cannot make, instead of finding nothing to run', async () => {
  const root = checkout(upstream());
  const ref = 'origin/does-not-exist';
  for (const argv of [
    ['case', 'impact', '--base', ref],
    ['map', 'check', '--base', ref],
  ]) {
    const outcome = await execute(argv, base(root));
    assert.equal(outcome.code, 1, argv.join(' '));
    assert.match(outcome.error ?? '', /^could not diff against origin\/does-not-exist: fatal:/);
    assert.doesNotMatch(outcome.text ?? '', /no case touches them/);
  }
  const ci = await execute(['ci', '--affected', '--base', ref, '--dry-run'], base(root));
  assert.equal(ci.code, 1);
  assert.match(ci.text ?? '', /^could not diff against origin\/does-not-exist[\s\S]*--affected ran no case: .*--on-diff-error all/);
  const all = await execute(['ci', '--affected', '--base', ref, '--dry-run', '--on-diff-error', 'all'], base(root));
  assert.equal(all.code, 0, all.text);
  assert.match(all.text ?? '', /All 1 case files: the diff against origin\/does-not-exist failed, and --on-diff-error all runs them all/);
  assert.equal((await execute(['ci', '--affected', '--on-diff-error', 'some'], base(root))).code, 2);
  // A base that is there still picks the cases its changes reach.
  const impact = await execute(['case', 'impact', '--base', 'origin/main'], base(root));
  assert.equal(impact.code, 0, impact.error);
  assert.match(impact.text ?? '', /^1 source file changed against origin\/main/);
});

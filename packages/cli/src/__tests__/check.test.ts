import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { Screen } from 'lynkeus-protocol';

import { diffGraphs, newFindings } from '../commands/check.js';
import { casesJobPlan, ciVersion, mapCheckWorkflow, mapCommands } from '../commands/map.js';
import type { LynkeusConfig } from '../config.js';
import { register } from '../registry.js';
import { execute } from '../runtime.js';
import { summarizeRuns } from '../commands/flake.js';
import type { FlowReport } from '../flow/types.js';
import { lintScreen } from '../knowledge/lint.js';
import type { ScreenGraph } from '../knowledge/types.js';

const graph = (screens: Record<string, string | null>, files: Record<string, { selectors?: string[]; navigates?: string[] }>): ScreenGraph =>
  ({
    app: 'x',
    root: '/x',
    extractedAt: '',
    warnings: [],
    screens: Object.fromEntries(Object.entries(screens).map(([route, file]) => [route, { route, component: route, file, declaredIn: 'nav.tsx' }])),
    files: Object.fromEntries(
      Object.entries(files).map(([file, f]) => [
        file,
        {
          selectors: (f.selectors ?? []).map((id) => ({ id, line: 1 })),
          navigates: (f.navigates ?? []).map((to) => ({ to, line: 1, confidence: 'static', via: { kind: 'unknown' } })),
          imports: [],
        },
      ]),
    ),
  }) as unknown as ScreenGraph;

test('a graph diff names routes, navigations and testIDs that changed', () => {
  const base = graph({ A: 'a.tsx', B: 'b.tsx' }, { 'a.tsx': { selectors: ['go-b'], navigates: ['B'] }, 'b.tsx': { selectors: ['submit'] } });
  const head = graph({ A: 'a.tsx', B: 'b.tsx', C: 'c.tsx' }, { 'a.tsx': { selectors: ['go-b', 'go-c'], navigates: ['B', 'C'] }, 'b.tsx': {}, 'c.tsx': {} });
  const d = diffGraphs(base, head);
  assert.deepEqual(d.routesAdded, ['C']);
  assert.deepEqual(d.edgesAdded, [{ from: 'A', to: 'C' }]);
  assert.deepEqual(d.selectorsAdded, [{ file: 'a.tsx', id: 'go-c' }]);
  assert.deepEqual(d.selectorsRemoved, [{ file: 'b.tsx', id: 'submit' }]);
});

test('lint findings already in the baseline are not new', () => {
  const f1 = { finding: { rule: 'unlabeled-control', severity: 'warn' as const, element: 3, message: 'button without a label' }, testId: 'x' };
  const f2 = { finding: { rule: 'small-target', severity: 'warn' as const, element: 4, message: '20×20' }, testId: 'y' };
  const fresh = newFindings({ A: [{ rule: 'unlabeled-control', testId: 'x', message: 'button without a label' }] }, 'A', [f1, f2]);
  assert.deepEqual(fresh, [f2]);
});

test('a known finding whose measurement moved is still known', () => {
  const screen = (side: number): Screen => ({
    route: 'A',
    path: ['A'],
    commit: 1,
    busy: false,
    window: { w: 390, h: 844 },
    costMs: 1,
    elements: [{ i: 0, kind: 'button', testId: 'close', enabled: true, depth: 0, frame: { x: 0, y: 0, w: side, h: side } }],
  });
  const linted = (side: number) => lintScreen(screen(side)).map((finding) => ({ finding, testId: 'close' }));
  const saved = { A: linted(32).map((f) => ({ rule: f.finding.rule, testId: f.testId, subject: f.finding.subject, message: f.finding.message })) };
  assert.notEqual(linted(30)[0]!.finding.message, linted(32)[0]!.finding.message);
  assert.deepEqual(newFindings(saved, 'A', linted(30)), []);
  // A baseline from before findings named their subject matches on the message it kept.
  const older = { A: linted(32).map((f) => ({ rule: f.finding.rule, testId: f.testId, message: f.finding.message })) };
  assert.deepEqual(newFindings(older, 'A', linted(32)), []);
});

test('flake runs are summarized by the step and error they died on', () => {
  const ok = (ms: number): FlowReport => ({ name: 'f', ok: true, totalMs: ms, vars: {}, steps: [{ step: { press: { testId: 'a' } }, ok: true, ms: 1 }] });
  const bad = (err: string): FlowReport => ({
    name: 'f',
    ok: false,
    totalMs: 900,
    vars: {},
    steps: [
      { step: { press: { testId: 'a' } }, ok: true, ms: 1 },
      { step: { waitFor: { route: 'A' } }, ok: false, ms: 1, error: err },
    ],
  });
  const s = summarizeRuns([ok(100), bad('Timed out waiting for A (on Z)'), ok(300), bad('Timed out waiting for A (on Y)')]);
  assert.equal(s.passed, 2);
  assert.equal(s.failures.length, 1);
  assert.equal(s.failures[0]!.times, 2);
  assert.equal(s.failures[0]!.step, 2);
  assert.match(s.failures[0]!.what, /waitFor/);
});

test('the map check workflow diffs against the pull request base and keeps one comment', () => {
  const yml = mapCheckWorkflow(4, '^0.7.5');
  assert.match(yml, /'lynkeus@\^0\.7\.5' map check --base origin\/\$\{\{ github\.base_ref \}\} --depth 4/);
  // Pinned: an unpinned npx would run whatever is latest the day CI runs.
  assert.doesNotMatch(yml, /npx --yes lynkeus /);
  assert.match(yml, /--edit-last/);
  assert.match(yml, /pull-requests: write/);
});

test('the map check workflow runs the lynkeus range the app depends on, never a dev build CI cannot fetch', () => {
  const app = (deps: Record<string, Record<string, string>>) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'map-ci-'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(deps));
    return root;
  };
  assert.deepEqual(ciVersion(app({ devDependencies: { lynkeus: '^0.7.6' } }), '0.7.7'), { range: '^0.7.6' });
  // The agent is released with the CLI: an app that has only the agent gets the same range.
  assert.deepEqual(ciVersion(app({ dependencies: { 'lynkeus-agent': '~0.7.5' } }), '0.7.7'), { range: '~0.7.5' });
  const dev = ciVersion(app({ dependencies: { 'lynkeus-agent': '0.7.7-dev.20261127010441' } }), '0.7.7-dev.20261127010441');
  assert.equal(dev.range, '^0.7.7');
  assert.match(dev.note ?? '', /lynkeus-agent is 0\.7\.7-dev\.20261127010441 in package\.json, which CI cannot install/);
  assert.equal(ciVersion(app({ devDependencies: { lynkeus: 'file:../lynkeus' } }), '0.7.6').range, '^0.7.6');
  assert.deepEqual(ciVersion(app({}), '0.7.6'), { range: '^0.7.6' });
  assert.equal(ciVersion(app({}), '0.7.7-dev.1').range, '^0.7.7');
});

test('map ci --cases adds a job that runs the affected cases on the CI targets, installing and bundling FastSim first', () => {
  const plan = casesJobPlan({ cases: { targets: ['fastsim:ios', 'fastsim:android', 'ios'] }, ci: { push: true } });
  assert.ok(typeof plan !== 'string');
  assert.deepEqual(plan, {
    declared: true,
    targets: ['fastsim:ios', 'fastsim:android'],
    secrets: ['LYNKEUS_TOKEN', 'LYNKEUS_CLOUD_KEY', 'LYNKEUS_REPORTS_KEY'],
    backend: false,
  });
  const yml = mapCheckWorkflow(4, '^0.7.7', { ...plan, manager: 'pnpm' });
  assert.match(yml, /\n {2}cases:\n {4}runs-on: ubuntu-latest\n {4}env:\n {6}LYNKEUS_TOKEN: \$\{\{ secrets\.LYNKEUS_TOKEN \}\}/);
  assert.match(yml, /- run: corepack enable && pnpm install --frozen-lockfile/);
  assert.match(yml, /'lynkeus@\^0\.7\.7' fastsim install --platform ios --json/);
  assert.match(yml, /"\$kit\/bin\/fastsim-bundle" \. \.lynkeus\/fastsim-android android/);
  assert.match(yml, /run: npx --yes 'lynkeus@\^0\.7\.7' ci --affected --base origin\/\$\{\{ github\.base_ref \}\}/);
  assert.doesNotMatch(mapCheckWorkflow(4, '^0.7.7'), /cases:/);
  const headless = casesJobPlan({ cases: { targets: ['headless'] }, ci: { backend: { up: 'up' } } });
  assert.deepEqual(headless, { declared: true, targets: ['headless'], secrets: ['LYNKEUS_TOKEN'], backend: true });
  assert.match(String(casesJobPlan({ cases: { targets: ['web'] } })), /web is not a target/);
});

test('map ci hints at --cases when the project has CI targets, and refuses --cases with none a job can start', async () => {
  register(mapCommands);
  const run = (config: LynkeusConfig, args: string[] = []) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'map-ci-cases-'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ devDependencies: { lynkeus: '^0.7.7' } }));
    return execute(['map', 'ci', ...args], {
      root,
      config,
      attached: true,
      err: () => undefined,
      graph: () => {
        throw new Error('no graph');
      },
      device: async () => {
        throw new Error('no app');
      },
    }).then((r) => ({ ...r, yml: fs.readFileSync(path.join(root, '.github', 'workflows', 'lynkeus-map-check.yml'), 'utf8') }));
  };
  const hinted = await run({ cases: { targets: ['fastsim:ios', 'ios'] } });
  assert.equal(hinted.code ?? 0, 0);
  assert.match(
    hinted.text ?? '',
    /\n--cases would also run the cases each pull request reaches on fastsim:ios \(`lynkeus ci --affected`\); that job needs LYNKEUS_TOKEN, LYNKEUS_CLOUD_KEY in the repository's secrets and a backend \(ci\.backend\)$/,
  );
  assert.doesNotMatch(hinted.yml, /\n {2}cases:/);
  const quiet = await run({ cases: { targets: ['ios'] } });
  assert.doesNotMatch(quiet.text ?? '', /--cases/);
  const added = await run({ cases: { targets: ['headless'] }, ci: { backend: { up: 'up' } } }, ['--cases']);
  assert.match(
    added.text ?? '',
    /with a cases job\)\nthe cases job runs `lynkeus ci --affected` on headless; it needs LYNKEUS_TOKEN in the repository's secrets$/,
  );
  assert.match(added.yml, /\n {2}cases:/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'map-ci-none-'));
  const refused = await execute(['map', 'ci', '--cases'], {
    root,
    config: { cases: { targets: ['ios', 'android'] } },
    attached: true,
    err: () => undefined,
    graph: () => {
      throw new Error('no graph');
    },
    device: async () => {
      throw new Error('no app');
    },
  });
  assert.equal(refused.code, 2);
  assert.match(refused.text ?? '', /no target a CI job can start/);
});

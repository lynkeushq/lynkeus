import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  caseLine,
  declaredTargets,
  parseTargets,
  runOnTargets,
  type SuiteReport,
  type SuiteResult,
  type TargetName,
  type TargetPlan,
} from '../cases/onTargets.js';
import { lastRunFile, statusOf } from '../cases/progress.js';
import { caseCommands, deviceProbes, fastsimBundles, fastsimHostCommand } from '../commands/cases.js';
import { driveCommands } from '../commands/drive.js';
import type { Device } from '../device/driver.js';
import { type Base, type Ctx, register } from '../registry.js';
import { execute } from '../runtime.js';

register([...driveCommands, ...caseCommands]);

const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const passed = (id: string, extra: Partial<SuiteReport> = {}): SuiteReport => ({
  id,
  file: `${id}.md`,
  result: 'passed',
  ms: 10,
  steps: [{ step: 'app.press: "#go"', status: 'passed', ms: 5 }],
  ...extra,
});

const failed = (id: string, error = 'no element matches #welcome\nwaited 5000 ms'): SuiteReport => ({
  id,
  file: `${id}.md`,
  result: 'failed',
  ms: 10,
  steps: [
    { step: 'app.press: "#go"', status: 'passed', ms: 5 },
    { step: 'app.see: "#welcome"', status: 'failed', ms: 5, error },
    { step: 'app.press: "#next"', status: 'skipped', ms: 0 },
  ],
});

const ctxIn = (root: string, flags: Record<string, string | boolean | number | undefined> = {}, signal?: AbortSignal): Ctx & { said: string[] } => {
  const said: string[] = [];
  return {
    root,
    config: {},
    attached: true,
    err: (line) => said.push(line),
    graph: () => {
      throw new Error('no graph');
    },
    device: async () => {
      throw new Error('no app');
    },
    args: [],
    flags,
    passthrough: [],
    ...(signal ? { signal } : {}),
    said,
  };
};

test('--on takes the target names, emulator and device for simulator, all, and targets; in the order the answer lists them', () => {
  assert.deepEqual(parseTargets('all'), ['ios', 'android', 'fastsim:ios', 'fastsim:android', 'headless']);
  assert.deepEqual(parseTargets('headless, emulator'), ['simulator', 'headless']);
  assert.deepEqual(parseTargets('android,IOS'), ['ios', 'android']);
  assert.deepEqual(parseTargets('fastsim:android,fastsim'), ['fastsim', 'fastsim:android']);
  assert.deepEqual(parseTargets('device,fastsim,all'), ['simulator', 'ios', 'android', 'fastsim', 'fastsim:ios', 'fastsim:android', 'headless']);
  assert.equal(parseTargets('targets'), 'declared');
  assert.match(String(parseTargets('targets,ios')), /^--on targets: alone/);
  assert.match(String(parseTargets('web')), /^--on web: not a target\. Name headless, fastsim:ios, fastsim:android, ios \(the app on the iOS Simulator/);
  assert.match(String(parseTargets(' , ')), /^--on: name headless, fastsim:ios/);
});

test("a case's targets are its own frontmatter's, else the project's; a name that is not a target is said", () => {
  assert.deepEqual(declaredTargets({}, ['fastsim:android', 'fastsim:ios']), ['fastsim:ios', 'fastsim:android']);
  assert.deepEqual(declaredTargets({ targets: ['ios'] }, ['headless']), ['ios']);
  assert.deepEqual(declaredTargets({ targets: 'headless, android' }, undefined), ['android', 'headless']);
  assert.equal(declaredTargets({}, undefined), undefined);
  assert.match(String(declaredTargets({}, ['web'])), /^cases\.targets in lynkeus\.config\.json: web is not a target/);
  assert.match(String(declaredTargets({ targets: [1] }, undefined, 'a.md')), /^a\.md: targets is a list of target names/);
  assert.match(String(declaredTargets({ targets: [] }, undefined, 'a.md')), /^a\.md: targets is empty: name one or more/);
});

test('a case on a target is one line: the result, and for a failure the step and the first line of its error', () => {
  assert.equal(caseLine(passed('login'), 'simulator'), '✅ simulator  login');
  assert.equal(caseLine(passed('login', { retried: true }), 'headless'), '✅ headless  login  ⚠ passed on retry');
  assert.equal(caseLine(failed('login'), 'headless'), '❌ headless  login — step 2/3 app.see: "#welcome": no element matches #welcome');
  const lost = { ...failed('login', 'No app attached'), diagnosis: ['during this case the host exited (1): out of memory'] };
  assert.equal(
    caseLine(lost, 'fastsim'),
    '❌ fastsim  login — step 2/3 app.see: "#welcome": No app attached (during this case the host exited (1): out of memory)',
  );
  const unsupported: SuiteReport = {
    id: 'film',
    file: 'film.md',
    result: 'unsupported',
    ms: 1,
    steps: [{ step: 'os.biometric: enroll', status: 'unsupported', ms: 1, error: 'Unknown method' }],
  };
  assert.equal(caseLine(unsupported, 'headless'), '🚫 headless  film — step 1/1 os.biometric: enroll: not on this host');
});

/** Targets planned and run by fakes: `plans` says which can run, `results` what each run answers. */
const onTargets = async (
  o: {
    plans: Partial<Record<TargetName, TargetPlan>>;
    results: Partial<Record<TargetName, SuiteResult>>;
    cases?: string[];
    verbose?: boolean;
    brief?: boolean;
    signal?: AbortSignal;
    hold?: Promise<void>;
  },
  root = tmp('lynkeus-on-'),
) => {
  const ctx = ctxIn(root, { on: 'all', jobs: 2, verbose: o.verbose }, o.signal);
  const started: TargetName[] = [];
  const seen: { target: TargetName; flags: Ctx['flags']; signal?: AbortSignal }[] = [];
  const outcome = await runOnTargets(ctx, {
    targets: ['simulator', 'fastsim', 'headless'],
    cases: (o.cases ?? ['login']).map((id) => ({ id })),
    plan: async (t) => o.plans[t] ?? { unavailable: 'nothing here' },
    run: async (sub, t) => {
      started.push(t);
      seen.push({ target: t, flags: sub.flags, signal: sub.signal });
      sub.err(`▶ login`);
      sub.progress?.({ type: 'case-start', at: new Date().toISOString(), id: 'login', job: 0, attempt: 1, steps: 1 });
      await o.hold;
      sub.progress?.({ type: 'case-end', at: new Date().toISOString(), id: 'login', job: 0, attempt: 1, result: 'passed', ms: 10 });
      return o.results[t] ?? { text: 'never planned', code: 1 };
    },
    detail: (r) => `— failed at ${r.id}\n    the screen`,
    verbose: !!o.verbose,
    brief: !!o.brief,
    progressFile: path.join(root, '.lynkeus', 'last-run.progress.ndjson'),
  });
  return { outcome, ctx, started, seen, root };
};

const host = (jobs = 1): TargetPlan => ({ flags: { 'host-command': 'start {port}', ports: '9001', jobs }, jobs });

test('every target that can run takes the cases at once; one that cannot is said once and fails nothing', async () => {
  let release: () => void = () => undefined;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const run = onTargets({
    plans: {
      simulator: { flags: { jobs: 1 }, jobs: 1, label: 'emulator' },
      headless: host(2),
      fastsim: { unavailable: 'not installed: `lynkeus fastsim install`' },
    },
    results: {
      simulator: { code: 0, reports: [passed('login')], notes: [] },
      headless: { code: 0, reports: [passed('login')], notes: ['native values the headless host did not answer:', '  Foo.bar'] },
    },
    hold,
  });
  // Both are running before either ends.
  await new Promise((r) => setTimeout(r, 20));
  release();
  const { outcome, started, seen, ctx, root } = await run;
  assert.deepEqual(started.sort(), ['headless', 'simulator']);
  assert.equal(outcome.code, 0);
  assert.equal(
    outcome.text,
    [
      '✅ emulator  login',
      '✅ headless  login',
      '○ fastsim not available: not installed: `lynkeus fastsim install`',
      'headless:',
      '  native values the headless host did not answer:',
      '    Foo.bar',
      'emulator 1/1 passed · headless 1/1 passed · fastsim not available',
    ].join('\n'),
  );
  // Each target's run takes its own flags over the caller's, never --on again, and says whose its lines are.
  const headless = seen.find((s) => s.target === 'headless')!;
  assert.equal(headless.flags.on, undefined);
  assert.equal(headless.flags['host-command'], 'start {port}');
  assert.equal(headless.flags.progress, 'none');
  assert.ok(ctx.said.includes('emulator: ▶ login') && ctx.said.includes('headless: ▶ login'));
  // case status reads one run with every target's cases in it, each job its own.
  const progress = (JSON.parse(fs.readFileSync(lastRunFile(root), 'utf8')) as { progress: string }).progress;
  const status = statusOf(progress);
  assert.equal(status.state, 'finished');
  assert.equal(status.total, 2);
  assert.equal(status.jobs, 3);
  assert.equal(status.passed, 2);
});

test('a failure on any target fails the run, with its step and error on its line; verbose adds the whole failure', async () => {
  const plans = { simulator: { flags: {}, jobs: 1 }, headless: host() };
  const results = { simulator: { code: 0, reports: [passed('login')] }, headless: { code: 1, reports: [failed('login')] } };
  const compact = await onTargets({ plans, results });
  assert.equal(compact.outcome.code, 1);
  assert.match(compact.outcome.text ?? '', /^✅ simulator {2}login\n❌ headless {3}login — step 2\/3 app\.see: "#welcome": no element matches #welcome\n/);
  assert.match(
    compact.outcome.text ?? '',
    /simulator 1\/1 passed · headless 0\/1 passed · fastsim not available\na failure's screen and requests: run that target again alone, or with verbose$/,
  );
  assert.doesNotMatch(compact.outcome.text ?? '', /the screen/);
  const verbose = await onTargets({ plans, results, verbose: true });
  assert.match(verbose.outcome.text ?? '', /❌ headless {3}login — .*\n {4}— failed at login\n {8}the screen\n/);
  assert.doesNotMatch(verbose.outcome.text ?? '', /run that target again/);
});

test('a target whose run could not start fails the run and says why', async () => {
  const { outcome } = await onTargets({
    plans: { simulator: { flags: {}, jobs: 1 }, fastsim: host() },
    results: {
      simulator: { code: 0, reports: [passed('login')] },
      fastsim: {
        text: 'the FastSim bundle at /b is older than App.tsx, and bundling it again failed (exit 1); fix that and run:\n  fastsim-bundle /app /b ios',
        code: 1,
      },
    },
  });
  assert.equal(outcome.code, 1);
  assert.match(outcome.text ?? '', /✖ fastsim could not run: the FastSim bundle at \/b is older than App\.tsx.*\n {4} {2}fastsim-bundle \/app \/b ios/);
  assert.match(outcome.text ?? '', /simulator 1\/1 passed · fastsim could not run · headless not available$/);
});

test('with no target to run on, nothing runs and the answer says why for each', async () => {
  const { outcome, started } = await onTargets({ plans: {}, results: {} });
  assert.equal(outcome.code, 1);
  assert.deepEqual(started, []);
  assert.equal(
    outcome.text,
    [
      '○ simulator not available: nothing here',
      '○ fastsim not available: nothing here',
      '○ headless not available: nothing here',
      'no target could run the cases',
    ].join('\n'),
  );
});

test('a caller cancelling the run stops every target', async () => {
  const caller = new AbortController();
  let release: () => void = () => undefined;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const run = onTargets({
    plans: { simulator: { flags: {}, jobs: 1 }, headless: host() },
    results: { simulator: { code: 130, reports: [] }, headless: { code: 130, reports: [] } },
    signal: caller.signal,
    hold,
  });
  await new Promise((r) => setTimeout(r, 20));
  caller.abort();
  release();
  const { outcome, seen } = await run;
  assert.ok(seen.every((s) => s.signal?.aborted && s.signal.reason === 'the caller cancelled case run'));
  assert.equal(outcome.code, 130);
  assert.match(outcome.text ?? '', /⏹ stopped \(the caller cancelled case run\)/);
});

/** A FastSim kit as fastsim install leaves it: `<kits>/<version>/<variant>` with its platform and fastsim-run. */
const kit = (kits: string, platform: string): string => {
  const dir = path.join(kits, '2026.11.17', `darwin-arm64-${platform}`);
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'share'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.sha256'), 'x');
  fs.writeFileSync(path.join(dir, 'share', 'platform'), platform);
  fs.writeFileSync(path.join(dir, 'bin', 'fastsim-run'), '#!/bin/sh\n', { mode: 0o755 });
  return dir;
};

const bundle = (root: string, name: string, platform: string, at: number): string => {
  const dir = path.join(root, '.lynkeus', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'host.args'), `--platform ${platform}\n`);
  fs.writeFileSync(path.join(dir, 'app.hbc'), '');
  fs.utimesSync(path.join(dir, 'app.hbc'), at, at);
  return dir;
};

test('the FastSim target runs the installed kit on the last bundle under .lynkeus, or says what is missing', () => {
  const root = tmp('lynkeus-on-fastsim-');
  const kits = tmp('lynkeus-on-kits-');
  assert.match(JSON.stringify(fastsimHostCommand(root, { kits })), /not installed: `lynkeus fastsim install --platform ios\|android`/);
  const ios = kit(kits, 'ios');
  const none = fastsimHostCommand(root, { kits });
  assert.ok('unavailable' in none);
  assert.ok(none.unavailable.startsWith(`no bundle under .lynkeus: make one with ${path.join(ios, 'bin', 'fastsim-bundle')} ${root}`));
  const older = bundle(root, 'fastsim-ios', 'ios', 1_000);
  const newer = bundle(root, 'fastsim-android', 'android', 2_000);
  assert.deepEqual(fastsimBundles(root), [newer, older]);
  assert.match(JSON.stringify(fastsimHostCommand(root, { kits })), /the bundle draws android, and no Lynkeus FastSim for it is installed/);
  assert.deepEqual(fastsimHostCommand(root, { kits, bundle: older }), {
    command: `${JSON.stringify(path.join(ios, 'bin', 'fastsim-run'))} ${JSON.stringify(older)} {port}`,
  });
  // A project's own FastSim host command (ci.hosts.command) is the one it runs.
  const configured = '/opt/fastsim/bin/fastsim-run .lynkeus/fastsim-ios {port}';
  assert.deepEqual(fastsimHostCommand(root, { kits, configured }), { command: configured });
  assert.match(JSON.stringify(fastsimHostCommand(root, { kits, configured: 'LYNKEUS_PORT={port} lynkeus headless start' })), /draws android/);
  // fastsim:ios and fastsim:android each take their own platform's kit and last bundle.
  assert.deepEqual(fastsimHostCommand(root, { kits, platform: 'ios' }), {
    command: `${JSON.stringify(path.join(ios, 'bin', 'fastsim-run'))} ${JSON.stringify(older)} {port}`,
  });
  assert.deepEqual(fastsimHostCommand(root, { kits, platform: 'ios', bundle: newer }), {
    command: `${JSON.stringify(path.join(ios, 'bin', 'fastsim-run'))} ${JSON.stringify(older)} {port}`,
  });
  assert.match(JSON.stringify(fastsimHostCommand(root, { kits, platform: 'android' })), /not installed: `lynkeus fastsim install --platform android`/);
  const android = kit(kits, 'android');
  assert.deepEqual(fastsimHostCommand(root, { kits, platform: 'android', configured }), {
    command: `${JSON.stringify(path.join(android, 'bin', 'fastsim-run'))} ${JSON.stringify(newer)} {port}`,
  });
  assert.deepEqual(fastsimHostCommand(root, { kits, platform: 'ios', configured }), { command: configured });
  fs.rmSync(newer, { recursive: true });
  assert.ok(
    String((fastsimHostCommand(root, { kits, platform: 'android' }) as { unavailable: string }).unavailable).startsWith(
      `no android bundle under .lynkeus: make one with ${path.join(android, 'bin', 'fastsim-bundle')} ${root} ${path.join(root, '.lynkeus', 'fastsim-android')} android`,
    ),
  );
});

/** A project with one case, and an app on a Simulator that answers every step at once. */
const simulatorProject = (hello: Record<string, unknown> | null) => {
  const root = tmp('lynkeus-on-run-');
  fs.mkdirSync(path.join(root, 'cases'));
  fs.writeFileSync(path.join(root, 'cases', 'one.md'), '---\nid: one\n---\nsteps:\n  - app.wait: "#go"\n');
  const device = {
    server: {
      connected: true,
      hello,
      port: 19_250 + (process.pid % 50),
      call: async (method: string) =>
        method === 'find' ? { i: 0, kind: 'button', testId: 'go', enabled: true, depth: 0, frame: { x: 0, y: 0, w: 100, h: 40 } } : null,
    },
    info: { id: 'sim', name: 'iPhone 16', platform: 'ios', type: 'simulator' },
    screen: async () => ({ route: 'Home', path: ['Home'], commit: 1, busy: false, window: { w: 390, h: 844 }, costMs: 1, elements: [] }),
    trace: async () => ({ last: 0, events: [] }),
    requests: async () => ({ inFlight: 0, requests: [] }),
    idle: async () => ({ idle: true }),
    press: async () => ({ x: 0, y: 0, mode: 'native' }),
    waitFor: async () => ({ waitedMs: 0 }),
    command: async () => ({}),
  } as unknown as Device;
  const base: Base = {
    root,
    config: { port: device.server.port, cases: { dir: 'cases' } },
    attached: true,
    err: () => undefined,
    graph: () => {
      throw new Error('no graph');
    },
    device: async () => device,
  };
  return { root, base };
};

/** The Simulators and emulators the device targets find booted, for the length of `body`. */
const withDevices = async <T>(ios: number, android: number, body: () => Promise<T>): Promise<T> => {
  const before = { ...deviceProbes };
  const one = (platform: 'ios' | 'android', i: number) =>
    ({ id: `${platform}-${i}`, name: `${platform} ${i}`, platform, type: platform === 'ios' ? 'simulator' : 'emulator', connected: true }) as const;
  deviceProbes.ios = async () => Array.from({ length: ios }, (_, i) => one('ios', i));
  deviceProbes.android = async () => Array.from({ length: android }, (_, i) => one('android', i));
  try {
    return await body();
  } finally {
    Object.assign(deviceProbes, before);
  }
};

test('case run --on simulator runs on the attached app and names the targets this machine lacks', async () => {
  const kits = tmp('lynkeus-on-nokits-');
  const before = process.env.LYNKEUS_FASTSIM_DIR;
  process.env.LYNKEUS_FASTSIM_DIR = kits;
  try {
    const p = simulatorProject({ native: true, commands: [], platform: 'ios' });
    const outcome = await withDevices(1, 0, () => execute(['case', 'run', '--on', 'simulator,fastsim,headless', '--once'], p.base));
    const lines = (outcome.text ?? '').split('\n');
    assert.equal(lines[0], '✅ simulator  one');
    assert.match(lines[1] ?? '', /^○ fastsim not available: not installed/);
    assert.match(lines[2] ?? '', /^○ headless not available: not set up/);
    assert.equal(lines.at(-1), 'simulator 1/1 passed · fastsim not available · headless not available');
    assert.equal(outcome.code, 0);
    // The attached app's run keeps the ledger a plain run keeps.
    assert.ok(fs.existsSync(path.join(p.root, '.lynkeus', 'flakes.json')));
  } finally {
    if (before === undefined) delete process.env.LYNKEUS_FASTSIM_DIR;
    else process.env.LYNKEUS_FASTSIM_DIR = before;
  }
});

test('the simulator target is not available when the attached app runs on a host', async () => {
  const p = simulatorProject({ native: true, commands: ['clock', 'screenshot'], platform: 'ios' });
  const outcome = await withDevices(1, 0, () => execute(['case', 'run', '--on', 'simulator'], p.base));
  assert.equal(outcome.code, 1);
  assert.match(
    outcome.text ?? '',
    /^○ simulator not available: the app on port \d+ runs on a host \(FastSim\), not on a Simulator or emulator\nno target could run the cases$/,
  );
});

test('--on targets runs each case on its declared targets only; a declared target missing here leaves the check incomplete', async () => {
  const root = tmp('lynkeus-on-declared-');
  const ctx = ctxIn(root, { on: 'targets' });
  const planned: TargetName[] = [];
  const given: Record<string, string[]> = {};
  const outcome = await runOnTargets(ctx, {
    targets: ['ios', 'fastsim:ios', 'fastsim:android', 'headless'],
    cases: [
      { id: 'a', file: '/cases/a.md', targets: ['fastsim:ios', 'headless'] },
      { id: 'b', file: '/cases/b.md', targets: ['fastsim:ios', 'fastsim:android'] },
    ],
    declared: true,
    plan: async (t) => {
      planned.push(t);
      return t === 'fastsim:android' ? { unavailable: 'not installed' } : host();
    },
    run: async (sub, t) => {
      given[t] = sub.args;
      const ids = t === 'headless' ? ['a'] : ['a', 'b'];
      return { code: 0, reports: ids.map((id) => passed(id)) };
    },
    detail: () => '',
    verbose: false,
  });
  // No case asks for ios: it is not even planned.
  assert.deepEqual(planned.sort(), ['fastsim:android', 'fastsim:ios', 'headless']);
  // A target every case takes keeps the caller's files; one only some take gets theirs.
  assert.deepEqual(given, { 'fastsim:ios': [], headless: ['/cases/a.md'] });
  assert.equal(outcome.code, 1);
  assert.equal(
    outcome.text,
    [
      '✅ fastsim:ios  a',
      '✅ headless     a',
      '✅ fastsim:ios  b',
      '✖ fastsim:android not available: not installed',
      'fastsim:ios 2/2 passed · headless 1/1 passed · fastsim:android not available',
      '⚠ check incomplete: fastsim:android (1 case(s)) declared but not available here, so not checked there; run on a machine that has it, or change the declared targets',
    ].join('\n'),
  );
});

test('case run --on targets takes cases.targets, a case may override them, and none declared asks for them', async () => {
  const kits = tmp('lynkeus-on-nokits-');
  const before = process.env.LYNKEUS_FASTSIM_DIR;
  process.env.LYNKEUS_FASTSIM_DIR = kits;
  try {
    const bare = simulatorProject({ native: true, commands: [], platform: 'ios' });
    const none = await execute(['case', 'run', '--on', 'targets'], bare.base);
    assert.equal(none.code, 2);
    assert.match(none.text ?? '', /^--on targets: the project declares no targets \(cases\.targets in lynkeus\.config\.json\)\. Ask the person/);

    const p = simulatorProject({ native: true, commands: [], platform: 'ios' });
    p.base.config.cases = { dir: 'cases', targets: ['simulator', 'fastsim:ios'] };
    fs.writeFileSync(path.join(p.root, 'cases', 'two.md'), '---\nid: two\ntargets: [simulator]\n---\nsteps:\n  - app.wait: "#go"\n');
    const outcome = await withDevices(1, 0, () => execute(['case', 'run', '--on', 'targets', '--once'], p.base));
    const lines = (outcome.text ?? '').split('\n');
    assert.deepEqual(lines.slice(0, 3), [
      '✅ simulator  one',
      '✅ simulator  two',
      '✖ fastsim:ios not available: not installed: `lynkeus fastsim install --platform ios` (Team plan)',
    ]);
    assert.equal(lines[3], 'simulator 2/2 passed · fastsim:ios not available');
    assert.match(lines.at(-1) ?? '', /^⚠ check incomplete: fastsim:ios \(1 case\(s\)\) declared but not available here/);
    assert.equal(outcome.code, 1);

    p.base.config.cases = { dir: 'cases', targets: ['simulator', 'web'] };
    const wrong = await execute(['case', 'run', '--on', 'targets'], p.base);
    assert.equal(wrong.code, 2);
    assert.match(wrong.text ?? '', /^cases\.targets in lynkeus\.config\.json: web is not a target/);
  } finally {
    if (before === undefined) delete process.env.LYNKEUS_FASTSIM_DIR;
    else process.env.LYNKEUS_FASTSIM_DIR = before;
  }
});

test('--on refuses the flags that pick one place to run, and names that are not targets', async () => {
  const p = simulatorProject(null);
  const clash = await execute(['case', 'run', '--on', 'all', '--host'], p.base);
  assert.equal(clash.code, 2);
  assert.equal(clash.text, "--on starts each target's hosts itself: leave out --host");
  const unknown = await execute(['case', 'run', '--on', 'web'], p.base);
  assert.equal(unknown.code, 2);
  assert.match(unknown.text ?? '', /^--on web: not a target/);
});

test('--on ios,android runs on the iOS Simulator and the Android emulator side by side, each app on its own connection', async () => {
  const ios = simulatorProject({ native: true, commands: [], platform: 'ios' });
  const android = simulatorProject({ native: true, commands: [], platform: 'android' });
  const apps = [await ios.base.device(), await android.base.device()];
  const stopped: string[] = [];
  const base: Base = {
    ...ios.base,
    device: async () => {
      throw new Error('the run asked the caller for its app');
    },
    forApp: (accepts, share) => {
      const app = apps.find((d) => d.server.hello && accepts(d.server.hello))!;
      return {
        base: { ...ios.base, device: async () => app, shares: share },
        stop: async () => {
          stopped.push(String(app.server.hello?.platform));
        },
      };
    },
  };
  const outcome = await withDevices(1, 1, () => execute(['case', 'run', '--on', 'ios,android', '--once'], base));
  const lines = (outcome.text ?? '').split('\n');
  assert.deepEqual(lines, ['✅ ios      one', '✅ android  one', 'ios 1/1 passed · android 1/1 passed']);
  assert.equal(outcome.code, 0);
  assert.deepEqual(stopped.sort(), ['android', 'ios']);
  // Side by side, each keeps a ledger of its own.
  assert.ok(fs.existsSync(path.join(ios.root, '.lynkeus', 'flakes.ios.json')));
  assert.ok(fs.existsSync(path.join(ios.root, '.lynkeus', 'flakes.android.json')));
});

test('a platform with no Simulator or emulator up is said at once, and its connection is let go', async () => {
  const p = simulatorProject({ native: true, commands: [], platform: 'ios' });
  let opened = 0;
  const base: Base = {
    ...p.base,
    forApp: () => {
      opened++;
      return { base: p.base, stop: async () => undefined };
    },
  };
  const outcome = await withDevices(1, 0, () => execute(['case', 'run', '--on', 'ios,android', '--once'], base));
  const lines = (outcome.text ?? '').split('\n');
  assert.equal(lines[0], '✅ ios  one');
  assert.equal(lines[1], '○ android not available: no Android emulator or phone is up (adb devices lists none)');
  assert.equal(opened, 1);
});

test('brief leaves out the cases that passed and cuts notes to a line; the counts and failures stay', async () => {
  const { outcome } = await onTargets({
    plans: { simulator: { flags: { jobs: 1 }, jobs: 1, label: 'ios' }, headless: host() },
    results: {
      simulator: { code: 1, reports: [passed('login'), failed('cart'), passed('tabs', { retried: true })], notes: [] },
      headless: {
        code: 0,
        reports: [passed('login'), passed('cart'), passed('tabs')],
        notes: ['native values the headless host did not answer:\n  Foo.bar\n  Foo.baz'],
      },
    },
    cases: ['login', 'cart', 'tabs'],
    brief: true,
  });
  const text = outcome.text ?? '';
  assert.doesNotMatch(text, /✅ \S+\s+login/);
  assert.match(text, /❌ ios\s+cart — step 2\/3/);
  assert.match(text, /✅ ios\s+tabs {2}⚠ passed on retry/);
  assert.match(text, /headless: native values the headless host did not answer:$/m);
  assert.doesNotMatch(text, /Foo\.bar/);
  assert.match(text, /ios 2\/3 passed · headless 3\/3 passed/);
});

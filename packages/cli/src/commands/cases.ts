import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import { Fixtures } from '../cases/fixtures.js';
import { caseLaunch, fillLaunch, launchEnv, recordLaunch, resolveLaunch } from '../cases/launch.js';
import type { RunLaunch } from 'lynkeus-protocol';
import { caseArtifactId, readCases } from '../cases/format.js';
import type { Case } from '../cases/format.js';
import { type CasesConfig, type CaseReport, expandSteps, missingFixtures, type Prepared, preparable, runCase } from '../cases/runner.js';
import { CONFIG, EXAMPLE_CASE, FIXTURES, FORMAT } from '../cases/templates.js';
import { claimPorts, freePorts, listenedPorts } from '../cases/portClaim.js';
import { HostPids, hostsFileOf } from '../cases/hostPids.js';
import { configFile, DEFAULT_PORT, portFromEnv } from '../config.js';
import { type Device, nextHello } from '../device/driver.js';
import { readJson, writeJson } from '../files.js';
import { Ahead, InMemory, type Store } from '../cases/ahead.js';
import { appStamp, caseVersion, Flakes, whereOf } from '../cases/flakes.js';
import { headlessEntryOf } from './appEntry.js';
import { SEEN_DIR } from '../cases/coverage.js';
import { readNativeSpecs } from '../cases/nativeSpecs.js';
import { describeNativeValues, mergeNativeValues, nativeValuesEnv } from '../cases/nativeValues.js';
import { RunFile } from '../cases/runfile.js';
import { Turns } from '../cases/turns.js';
import { eventsFile } from '../knowledge/events.js';
import { type Base, type Ctx, define, type Result } from '../registry.js';
import { androidDevices, bootedSimulators } from '../device/devices.js';
import { onPhone } from '../runtime.js';
import { runtimeAt } from '../runtimes/index.js';
import type { FlagValues } from '../args.js';
import {
  DEVICE_TARGETS,
  declaredTargets,
  parseTargets,
  runOnTargets,
  type SuiteResult,
  TARGETS,
  type TargetName,
  type TargetPlan,
  targetSlug,
} from '../cases/onTargets.js';
import { fastsimBundleDir, freshBundle, staleDeviceJs, staleJsWarning } from '../cases/staleBundle.js';
import { hostGrantEnv, installedFastsim, installedKit } from './fastsim.js';
import { writeRunReport } from './localReport.js';
import { describeChanges, type LiveRun, pushRun, service, startLiveRun } from './report.js';
import { TraceSink } from '../cases/traces.js';
import { megabytes, sizeOf } from '../cases/runDirs.js';
import { type NativeLogs, startNativeLogs } from '../cases/nativeLogs.js';
import { describeStatus, lastRunFile, PROGRESS_FILE, type ProgressEvent, RunState, statusLine, statusOf, writeLastRun } from '../cases/progress.js';
import { LiveLine } from '../cases/liveLine.js';

/** Why a host that came up is gone: how it exited, what it printed last, where its log is. */
const lastWords = new WeakMap<ChildProcess, () => string>();
let started = 0;

const QUICK_ATTACH_MS = 3000;

/** What the device targets ask the OS for; tests stand in for the Simulators and emulators of the machine. */
export const deviceProbes = { ios: bootedSimulators, android: androidDevices };

/** Why a device target cannot be there, decided without waiting for an app: no Simulator or emulator (of the platform asked for) is up. */
const phoneProbe = async (ctx: Ctx, platform?: 'ios' | 'android'): Promise<string | undefined> => {
  if (ctx.flags.launch) return undefined;
  const [ios, android] = await Promise.all([
    platform === 'android' ? [] : deviceProbes.ios().catch(() => null),
    platform === 'ios' ? [] : deviceProbes.android().catch(() => null),
  ]);
  // A probe that failed is not proof of nothing running.
  if (!ios || !android) return undefined;
  if (ios.length + android.length > 0) return undefined;
  return platform === 'ios'
    ? 'no iOS Simulator is booted'
    : platform === 'android'
      ? 'no Android emulator or phone is up (adb devices lists none)'
      : 'no Simulator or emulator is running';
};

export const startHost = async (root: string, err: (line: string) => void, port: number, launch?: RunLaunch): Promise<ChildProcess> => {
  // Its own process group: the host starts a test runner of its own, and stopping one without the other leaves an app dialing in.
  const host = spawn(process.execPath, [process.argv[1]!, 'headless', 'start'], {
    cwd: root,
    env: { ...process.env, ...launchEnv(launch), LYNKEUS_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  // Everything the host prints, for the render errors and warnings a failed case points at; the console keeps the run's own lines.
  // A host started again after one died gets a log of its own: the dead one's says why it died.
  started += 1;
  const logFile = path.join(os.tmpdir(), `lynkeus-headless-${process.pid}${started > 1 ? `-${started}` : ''}.log`);
  const logStream = fs.createWriteStream(logFile);
  logStream.on('error', () => {});
  host.once('exit', () => logStream.end());
  let output = '';
  const tail = (n: number) => output.trim().split('\n').slice(-n).join(' · ');
  // `headless start` ends a crash with what it usually means; without that, the error line jest printed.
  const why = () => {
    const plain = stripVTControlCharacters(output);
    const explained = plain.split('lynkeus: what this looks like')[1];
    if (explained)
      return explained
        .trim()
        .split('\n')
        .map((line) => line.trim())
        .join(' · ');
    // Jest prints a suite that throws while loading as "● Test suite failed to run", then the thrown message, which
    // can run over several lines ("doesn't seem to be linked. Make sure: …"): all of it, up to the stack or code frame.
    const thrown = thrownMessage(plain);
    return thrown ?? plain.match(/^\s*(\w*Error\b.*|Cannot find module.*)$/m)?.[1]?.trim() ?? tail(3);
  };
  await new Promise<void>((resolve, reject) => {
    const settle = (error?: Error) => {
      clearTimeout(timer);
      if (!error) return resolve();
      // A host that never came up is still running, and nobody holds it to stop it later.
      if (host.pid && !exited(host)) stopGroup(host.pid);
      reject(error);
    };
    const timer = setTimeout(() => settle(new Error(`the host did not come up within 180 s: ${tail(3)}`)), 180_000);
    const read = (chunk: Buffer) => {
      logStream.write(chunk);
      output = (output + chunk.toString()).slice(-4000);
      if (/waiting for a driver/.test(output)) settle();
    };
    host.stdout?.on('data', read);
    host.stderr?.on('data', read);
    // A suite that fails to load exits right after printing why, so its explanation is read in full here.
    host.once('exit', (code) => settle(new Error(`${/Test suite failed/.test(output) ? 'the host failed to start' : `the host exited (${code})`}: ${why()}`)));
  });
  // The listeners above stay: the log takes all the host prints until it stops.
  err(`host: up (its log: ${logFile})`);
  lastWords.set(host, () => `exited (${host.exitCode ?? host.signalCode}): ${why()} (its log: ${logFile})`);
  return host;
};

/** The whole message of the error a suite threw while loading, as one line; undefined when jest printed none. */
export const thrownMessage = (output: string): string | undefined => {
  const after = output.split(/Test suite failed to run\s*\n/)[1];
  if (!after) return undefined;
  const lines: string[] = [];
  for (const line of after.split('\n')) {
    if (/^\s*at\s|^\s*>?\s*\d+\s*\||^\s*(Details|Test Suites):/.test(line)) break;
    if (line.trim()) lines.push(line.trim());
    if (lines.length === 12) break;
  }
  return lines.length ? lines.join(' ') : undefined;
};

const exited = (host: ChildProcess) => host.exitCode !== null || host.signalCode !== null;

/**
 * What became of the run's host, worded to follow "the host": gone, or alive with no app attached; undefined while
 * it serves. An app that reloads redials within moments, so `waitMs` gives it that long before the host counts as lost.
 */
export const hostLost = async (
  host: ChildProcess,
  server: { connected: boolean; waitForApp: (ms: number) => Promise<unknown> } | undefined,
  waitMs = 0,
): Promise<string | undefined> => {
  if (exited(host)) return lastWords.get(host)?.() ?? `exited (${host.exitCode ?? host.signalCode})`;
  if (!server || server.connected) return undefined;
  if (
    waitMs > 0 &&
    (await server.waitForApp(waitMs).then(
      () => true,
      () => false,
    ))
  )
    return undefined;
  return 'is running but its app is not attached';
};

/**
 * A case that found no app while the host it started still runs: the host loaded the app, and the app's agent never
 * dialed in. That is a bundle with the agent off or left out, which the client's own hint (a dev build) does not name.
 */
export const agentSilent = (report: Pick<CaseReport, 'result' | 'steps'>, host: ChildProcess | undefined, headless = false): string | undefined => {
  if (!(report.result === 'failed' && host && !exited(host) && report.steps.some((s) => s.error?.startsWith('No app attached')))) return undefined;
  // A headless host runs the agent whatever the bundle says: an app that never attached dialed elsewhere or was still starting.
  if (headless)
    return "is running, but its app never attached on this case's port: a headless host always runs the agent, so it dials another port (its LYNKEUS_PORT) or had not finished starting";
  return 'is running the app, but no Lynkeus agent dialed in: the bundle has the agent off (auto() or <Lynkeus> with enabled false; before lynkeus-agent 0.7.6 a FastSim bundle, a release build, left it off unless enabled said otherwise) or was made without it';
};

/**
 * Starts a case on a headless host an earlier case used, as on a host of its own: the host's reset empties its mocked
 * storage (MMKV, keychain, AsyncStorage), network rules, clock, offline state and native mocks, runs the app's own
 * `reset` command when it registered one, and mounts the app again. What the app keeps at module scope survives.
 */
export const resetSharedHost = async (base: Base, log: (line: string) => void): Promise<boolean> => {
  const started = Date.now();
  try {
    const device = await base.device();
    await device.command('reset');
    // The remount is done when reset answers; a short quiet lets the first effects (fonts, i18n, a stored session) land.
    await device.idle({ quietMs: 100, timeoutMs: 5000 }).catch(() => undefined);
    log(`  ↺ the shared host was reset for this case (${Date.now() - started} ms)`);
    return true;
  } catch (error) {
    log(`  ↺ the shared host could not be reset for this case: ${(error as Error).message}`);
    return false;
  }
};

/** The command a run uses to start a headless host of its own on a port: this same CLI, so the host matches it. */
export const selfHeadlessCommand = (): string =>
  `LYNKEUS_PORT={port} ${JSON.stringify(process.execPath)} ${JSON.stringify(process.argv[1] ?? 'lynkeus')} headless start`;

/** A host command that starts a headless host (ours, `npx lynkeus headless start`, …), whose agent is always on. */
export const startsHeadless = (command: string | undefined): boolean => command !== undefined && /\bheadless(\s+start)?\b/.test(command);

export type HostMemory = { heapUsedMb?: number; heapLimitMb?: number };

/**
 * A host's heap past `percent` of where V8 gives up, as "<used> MB of <limit> MB"; undefined below it. A host that
 * does not say its limit is taken at node's usual 4 GB.
 */
export const heapPast = (memory: HostMemory | undefined, percent: number): string | undefined => {
  if (!memory?.heapUsedMb) return undefined;
  const limit = memory.heapLimitMb ?? 4096;
  return memory.heapUsedMb >= (limit * percent) / 100 ? `${memory.heapUsedMb} MB of ${limit} MB` : undefined;
};

const stopGroup = (pid: number) => {
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {}
};

/**
 * Stops a host and waits until it is gone. The next case's host dials the same port, and a host still on
 * its way out dials it too: whichever reaches the driver first is the one the case talks to.
 */
export const stopHost = async (host: ChildProcess): Promise<void> => {
  if (!host.pid || host.exitCode !== null || host.signalCode !== null) return;
  const gone = new Promise<void>((resolve) => host.once('exit', () => resolve()));
  host.stdin?.end();
  stopGroup(host.pid);
  const late = setTimeout(() => {
    try {
      process.kill(-host.pid!, 'SIGKILL');
    } catch {}
  }, 2000);
  await gone;
  clearTimeout(late);
};

// What a failed case shows of itself unless asked for everything: an agent reads it after every run, and pays for
// each line on every turn after. The whole of it stays in the run's cases.jsonl and the --json answer.
const COMPACT = { errorLines: 8, screenLines: 20 };

/**
 * The lines of a screen listing a reader acts on first. Rows of a list (lines alike but for their numbers) show the
 * first two and how many more; then what has a testID or can be pressed or typed in comes before texts, in their order.
 */
const screenGist = (listing: string): string[] => {
  const [header = '', ...rest] = listing.split('\n');
  const cover = rest[0]?.startsWith('! ') ? [rest.shift()!] : [];
  const cut = rest.at(-1)?.startsWith('… ') ? Number(/\d+/.exec(rest.pop()!)?.[0] ?? 0) : 0;
  const shapes = new Map<string, number>();
  const lines: string[] = [];
  const alike = new Map<string, number>();
  for (const l of rest) {
    const shape = l.replace(/\d+/g, '0');
    const n = (shapes.get(shape) ?? 0) + 1;
    shapes.set(shape, n);
    if (n <= 2) lines.push(l);
    else alike.set(shape, n - 2);
  }
  const named = (l: string) => / #\S/.test(l) || /^(\d+ )?(button|input|switch|link)\b/.test(l);
  const keep = new Set<number>();
  for (const pass of [named, () => true]) for (const [i, l] of lines.entries()) if (keep.size < COMPACT.screenLines && pass(l)) keep.add(i);
  const shown = lines.flatMap((l, i) => {
    if (!keep.has(i)) return [];
    const more = alike.get(l.replace(/\d+/g, '0'));
    // After the second row of a kind, the count of the rest.
    return more && lines.findLastIndex((x) => x.replace(/\d+/g, '0') === l.replace(/\d+/g, '0')) === i ? [l, `… ${more} more like it`] : [l];
  });
  const left = lines.length - keep.size + cut;
  return [header, ...cover, ...shown, ...(left > 0 ? [`… ${left} more (verbose shows the whole screen)`] : [])];
};

// A request worth a look: one that failed, never answered or was answered by the case's own mock.
const notable = (line: string) => !/^[23]\d\d /.test(line) || line.endsWith('(mocked)');

/**
 * A case that did not pass: the step that broke and its error, the screen it broke on, the requests and why. `verbose`
 * keeps all of it; otherwise the screen is cut to what a check can name and only requests worth a look are listed.
 * `headline: false` leaves out the result line, for a summary that already names the case.
 */
export const describe = (report: CaseReport, o: { verbose?: boolean; headline?: boolean } = {}): string => {
  const counts = { passed: 0, failed: 0, skipped: 0, unsupported: 0 };
  for (const s of report.steps) counts[s.status] += 1;
  const headline = { passed: '✅ PASSED', failed: '❌ FAILED', unsupported: '🚫 NOT ON THIS HOST' }[report.result];
  const lines =
    o.headline === false
      ? []
      : [
          `${headline}  ✅ ${counts.passed}${counts.failed ? `  ❌ ${counts.failed}` : ''}${counts.unsupported ? `  🚫 ${counts.unsupported}` : ''}${counts.skipped ? `  ⏭️ ${counts.skipped}` : ''}  — ${(report.ms / 1000).toFixed(1)}s`,
        ];
  // The step's own error first: the evidence after it is read from the app, and may say nothing about it.
  for (const [i, s] of report.steps.entries())
    if (s.status === 'failed' || s.status === 'unsupported') {
      const error = (s.error ?? 'no error was given').split('\n');
      const shown = o.verbose ? error : error.slice(0, COMPACT.errorLines);
      lines.push(
        `— failed at step ${i + 1} of ${report.steps.length}: ${s.step}`,
        ...shown.map((l) => `    ${l}`),
        ...(shown.length < error.length ? [`    … ${error.length - shown.length} more lines (verbose)`] : []),
      );
    }
  const screen = report.evidence?.screen;
  if (screen) lines.push('— screen at the failure:', ...(o.verbose ? screen.split('\n') : screenGist(screen)).map((l) => `    ${l}`));
  const requests = o.verbose ? report.evidence?.requests : report.evidence?.requests?.filter(notable);
  if (requests?.length) lines.push(o.verbose ? '— requests:' : '— requests that failed or were mocked:', ...requests.map((l) => `    ${l}`));
  if (report.evidence?.why) lines.push('— why:', ...report.evidence.why.split('\n').map((l) => `    ${l}`));
  if (report.warnings?.length) lines.push(...report.warnings.map((w) => `⚠ ${w}`));
  return lines.join('\n');
};

// What this process last told a caller, by notice: an MCP server runs many case runs, and the agent behind it already
// has a notice the run before gave it, word for word.
const toldLast = new Map<string, string>();

/** A run's notice in full the first time, and one line while it says the same as the last run's did. */
export const onceUnlessVerbose = (notice: string, lines: string[], verbose: boolean): string[] => {
  const text = lines.join('\n');
  const same = toldLast.get(notice) === text;
  toldLast.set(notice, text);
  if (lines.length <= 1 || verbose || !same) return lines;
  return [`${notice}: as the last run said (${lines.length} lines; verbose repeats them)`];
};

/** The share of the machine's CPU that sat idle over the next 300 ms. */
const idleShare = async (): Promise<number> => {
  const total = () =>
    os.cpus().reduce(
      (sum, cpu) => {
        const t = cpu.times;
        return { idle: sum.idle + t.idle, all: sum.all + t.idle + t.user + t.sys + t.nice + t.irq };
      },
      { idle: 0, all: 0 },
    );
  const before = total();
  await new Promise((r) => setTimeout(r, 300));
  const after = total();
  return after.all > before.all ? (after.idle - before.idle) / (after.all - before.all) : 1;
};

/** Every case under a directory and its subdirectories, in path order, so a suite can group its cases in folders. */
const casesIn = (dir: string): string[] =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules')
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return casesIn(full);
      return e.name.endsWith('.md') && !/^(README|FORMAT|CATALOG)\.md$/i.test(e.name) ? [full] : [];
    });

/** The case files named (a directory stands for every case under it), or every case under the cases directory; a sentence when there are none. */
export const caseFiles = (args: string[], home: string, casesDir: string | undefined): string[] | string => {
  const dir = path.resolve(home, casesDir ?? 'cases');
  const named = args.map((f) => path.resolve(f));
  const missing = named.find((f) => !fs.existsSync(f));
  if (missing) return `no such case file: ${path.relative(process.cwd(), missing) || missing}`;
  const files = named.length ? named.flatMap((f) => (fs.statSync(f).isDirectory() ? casesIn(f) : [f])) : fs.existsSync(dir) ? casesIn(dir) : [];
  const where = named.length === 1 ? path.relative(home, named[0]!) : path.relative(home, dir);
  return files.length > 0 ? files : `no cases under ${where || '.'}; \`lynkeus case init\` writes one`;
};

type PrepareOptions = { base: Base; config: CasesConfig; store: Store; open: () => Fixtures; limit: number; idle: number; jobs: number };

/**
 * Runs the setups of `cases` ahead of them, in order, `jobs` at a time: never more than `limit` waiting
 * to be taken, and only while the machine has `idle` of its CPU to spare. A case that started first is skipped.
 */
const prepareAhead = async (cases: Case[], o: PrepareOptions): Promise<{ made: number; skipped: number }> => {
  let next = 0;
  let made = 0;
  let skipped = 0;
  // Far enough ahead, or the machine busy: a setup made then only takes the CPU from the cases
  // running now, and the suite gains nothing from having it early.
  const room = async (): Promise<boolean> => {
    if (o.store.waiting() < o.limit) return (await idleShare()) >= o.idle;
    // A timer, not a bare check: the jobs that take the waiting setups may run in this same process,
    // and a loop that never yields to the event loop would keep them from ever taking one.
    await new Promise((r) => setTimeout(r, 100));
    return false;
  };
  const worker = async () => {
    const fixtures = o.open();
    await fixtures.ahead();
    try {
      for (let c = cases[next++]; c; c = cases[next++]) {
        while (!o.store.started(c) && !(await room()));
        if (o.store.started(c)) {
          skipped++;
          continue;
        }
        const done = c;
        await runCase(done, { base: o.base, config: o.config, fixtures, setupOnly: { keep: (p) => o.store.keep(done, p) } });
        made++;
      }
    } finally {
      fixtures.close();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, o.jobs) }, worker));
  return { made, skipped };
};

/** A host for one case, started by the project's own command: `{port}` is where it dials the driver; `{seed}`, `{locale}`, `{time-zone}` and `{epoch}` are the launch facts (also in the environment), with the seed made the case's own by `caseLaunch`. */
const spawnHost = (command: string, port: number, job: number, cwd: string, env: NodeJS.ProcessEnv, launch?: RunLaunch, logFile?: string): ChildProcess => {
  // The run's own headless hosts (`--host` with jobs) keep a log, as the single `--host` does; a project's command logs where it says.
  const out = logFile ? fs.openSync(logFile, 'w') : 'ignore';
  const host = spawn('/bin/sh', ['-c', fillLaunch(command.replaceAll('{port}', String(port)).replaceAll('{job}', String(job)), launch)], {
    cwd,
    env: { ...env, ...launchEnv(launch) },
    // stdin stays open for the host's life: a host that serves until its stdin closes stops with the case.
    stdio: ['pipe', out, out],
    detached: true,
  });
  if (typeof out === 'number') {
    fs.closeSync(out);
    lastWords.set(host, () => `exited (${host.exitCode ?? host.signalCode}) (its log: ${logFile})`);
  }
  return host;
};

/** A run that could not be uploaded still ran: the failure is said, not raised. */
// A run that kept evidence but none of a kind says so when it ends, not only as a gap in the report.
// The packages whose calls the agent and the hosts keep (lynkeus-agent's sdks.ts, lynkeus-headless's analytics mocks).
const ANALYTICS_PACKAGES = [
  'mixpanel-react-native',
  'react-native-appsflyer',
  '@react-native-firebase/analytics',
  '@react-native-firebase/crashlytics',
  '@datadog/mobile-react-native',
  '@sentry/react-native',
  '@intercom/intercom-react-native',
  '@amplitude/analytics-react-native',
  '@amplitude/react-native',
  '@braze/react-native-sdk',
  'react-native-branch',
  'react-native-adjust',
  '@bugsnag/react-native',
  'clevertap-react-native',
  'react-native-onesignal',
  'react-native-fbsdk-next',
  '@iterable/react-native-sdk',
];

/** The analytics, crash and support SDKs among the app's dependencies that Lynkeus keeps the calls of. */
export const analyticsSdksOf = (root: string): string[] => {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return ANALYTICS_PACKAGES.filter((name) => manifest.dependencies?.[name] ?? manifest.devDependencies?.[name]);
  } catch {
    return [];
  }
};

/** `sdks`: the analytics SDKs the app depends on; an app with none sends no event, and that is nothing to warn about. */
export const missingEvidence = (reports: CaseReport[], asked: { video: boolean; sdks: string[]; screenshots?: boolean; ownHost?: boolean }): string[] => {
  if (reports.length === 0) return [];
  const steps = reports.flatMap((r) => r.steps);
  const fromApp = steps.some((s) => s.sent?.some((e) => e.via !== 'server')) || reports.some((r) => (r.events?.length ?? 0) > 0);
  return [
    ...(fromApp || asked.sdks.length === 0
      ? []
      : [
          `⚠ no case kept an analytics event from the app, which depends on ${asked.sdks.join(', ')} (the agent and the hosts keep the calls that reach them; on a simulator or emulator only where the SDK’s module can be wrapped).`,
        ]),
    ...(asked.screenshots && !steps.some((s) => s.screenshot)
      ? [
          asked.ownHost
            ? '⚠ --screenshots kept no frame: the host this run started does not take them. On Lynkeus FastSim the app needs lynkeus-agent 0.7.6 or newer and a bundle made by a fastsim-bundle that adds the host’s controls: update both and bundle again. The headless host draws nothing.'
            : '⚠ --screenshots kept no frame: neither the app nor the simulator or emulator gave one.',
        ]
      : []),
    ...(asked.video && !reports.some((r) => r.video)
      ? [
          asked.ownHost
            ? '⚠ --video kept no film: the host this run started does not film. Lynkeus FastSim films when its bundle has the host’s controls (lynkeus-agent 0.7.6 or newer, bundled again with a current fastsim-bundle); headless keeps nothing.'
            : '⚠ --video kept no film: the app’s host does not film and neither `xcrun simctl io recordVideo` (a Simulator) nor `adb shell screenrecord` (an emulator or phone) gave one. Headless keeps nothing.',
        ]
      : []),
  ];
};

const pushed = async (
  dir: string,
  to: Exclude<ReturnType<typeof service>, string>,
  project: string,
  err: (line: string) => void,
  afterPush: 'keep' | 'delete' = 'keep',
  live?: { run: LiveRun; manifest: unknown },
) => {
  try {
    const run = live
      ? await live.run.finish(live.manifest)
      : await pushRun(dir, { ...to, project, onReady: (url) => err(`report: ${url} (its frames are on their way)`), onProgress: err });
    return {
      url: run.url,
      text: [
        `report: ${run.url}${run.refused.length ? ` (not kept on this plan: ${run.refused.join(', ')})` : ''}`,
        ...describeChanges(run.changes),
        keptOrDeleted(dir, afterPush, run.refused.length === 0),
      ].join('\n'),
    };
  } catch (error) {
    return { text: `the report was not uploaded: ${(error as Error).message}` };
  }
};

// After a push: the folder deleted when the config asks and the service took every file, else how much it holds.
export const keptOrDeleted = (dir: string, afterPush: 'keep' | 'delete', complete: boolean): string => {
  const bytes = sizeOf(dir);
  if (afterPush === 'delete' && complete) {
    fs.rmSync(dir, { recursive: true, force: true });
    return `run folder deleted after the push (${megabytes(bytes)})`;
  }
  return `run folder: ${megabytes(bytes)} on disk${afterPush === 'delete' ? ', kept because some files were not taken' : ''} · \`lynkeus report prune ${path.dirname(dir)} --older 7d\` frees old ones`;
};

/** The case runs going in this process, for `case stop`: each stops with a reason and says when it has let go. */
type ActiveRun = { label: string; progress?: string; stop: (why: string) => void; done: Promise<void> };
const active = new Set<ActiveRun>();

/**
 * A warning when the app on a Simulator, emulator or phone runs JavaScript older than the app's source (an edit Fast
 * Refresh did not apply); undefined when its code is current, it runs on a host, or its agent does not say how old it is.
 */
const deviceJsWarning = async (device: Device, root: string, skip: string[]): Promise<string | undefined> => {
  if (!onPhone(device.server)) return undefined;
  const ask = async () => {
    const at = Date.now();
    const pong = await device.server.call('ping', undefined, 3000);
    return pong.js ? staleDeviceJs(root, pong.js, at, skip) : undefined;
  };
  let stale = await ask();
  // A file saved a moment ago may still be on its way through Metro: one more look before calling the code old.
  if (stale && stale.changedAgoS < 3) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    stale = await ask();
  }
  return stale ? staleJsWarning(stale, device.info.name) : undefined;
};

const STOP_POLL_MS = 500;
// A host started again for `app.relaunch` boots as the case's first did: a FastSim host takes seconds, not minutes.
const HOST_RELAUNCH_MS = 120_000;
// How often a kept host still on its way up is asked whether its app attached, at most.
const ATTACH_PROBE_MS = 250;

/** One run of `case run` on one place: the attached app, or the hosts its flags start. `as.target` names it when `--on` runs it beside others. */
const runSuite = async (ctx: Ctx, as: { target?: TargetName } = {}): Promise<SuiteResult> => {
  const config = ctx.config.cases ?? {};
  const home = config.base ?? ctx.root;
  const files = caseFiles(ctx.args, home, config.dir);
  if (typeof files === 'string') return { text: files, code: 1 };
  const cases = files.flatMap(readCases);
  const dry = !!ctx.flags['dry-run'];
  const verbose = !!ctx.flags.verbose;
  const launch = resolveLaunch(ctx.flags, ctx.config);
  if (typeof launch === 'string') return { text: launch, code: 2 };
  const startsHost = !!ctx.flags.host || typeof ctx.flags['host-command'] === 'string';
  const notApplied = recordLaunch(launch, startsHost)?.unsupported;
  if (notApplied?.length && !ctx.flags['dry-run'])
    ctx.err(
      `launch: ${notApplied.join(', ')} not applied: the app is attached, not started by this run (start the host with them, or use --host or --host-command)${notApplied.includes('seed') ? "; the seed still makes the cases' {{random.*}} repeatable, not the app's Math.random" : ''}${notApplied.includes('locale') ? `; for the app's language on a Simulator or emulator run \`os language ${launch.locale}\` once, which every relaunch Lynkeus makes keeps` : ''}`,
    );
  const seenDir = dry ? undefined : typeof ctx.flags.seen === 'string' ? path.resolve(ctx.flags.seen) : path.join(ctx.root, SEEN_DIR);
  const out =
    typeof ctx.flags.out === 'string' && !dry ? new RunFile(path.resolve(ctx.flags.out), ctx.root, new Date(), recordLaunch(launch, startsHost)) : undefined;
  if ((ctx.flags.screenshots || ctx.flags.video) && !out)
    return { text: '--screenshots and --video keep what they take in the run directory: add --out <dir>', code: 2 };
  // Checked before the run, so a missing key does not surface only after every case has run.
  const reportsTo = ctx.flags.push && out ? service() : undefined;
  if (ctx.flags.push && !out) return { text: '--push uploads the run directory: add --out <dir>', code: 2 };
  if (typeof reportsTo === 'string') return { text: reportsTo, code: 2 };
  const progressMode = typeof ctx.flags.progress === 'string' ? ctx.flags.progress : undefined;
  if (progressMode !== undefined && progressMode !== 'json' && progressMode !== 'none') return { text: `--progress ${progressMode}: json or none`, code: 2 };
  // Over MCP or in a session stdout is the protocol's: the events go to the caller's progress instead.
  const jsonProgress = progressMode === 'json' && !ctx.attached;
  const project = typeof ctx.flags.project === 'string' ? ctx.flags.project : path.basename(ctx.root);
  const evidenceOf = (id: string, attempt: number) =>
    out && (ctx.flags.screenshots || ctx.flags.video)
      ? {
          dir: out.evidenceDir(id, attempt),
          screenshots: !!ctx.flags.screenshots,
          settleMs: Number(ctx.flags.settle ?? 150),
          ...(ctx.flags.still ? { stillMs: Number(ctx.flags.still) } : {}),
          ...(ctx.flags['frames-on-change'] ? { onChange: true } : {}),
          frames: ctx.flags.frames === 'png' ? ('png' as const) : ('avif' as const),
          ...(ctx.flags.video
            ? { video: { fps: Number(ctx.flags['video-fps'] ?? 30), ...(ctx.flags['video-scale'] ? { scale: Number(ctx.flags['video-scale']) } : {}) } }
            : {}),
        }
      : undefined;
  const ledger = dry ? undefined : new Flakes(path.resolve(ctx.root, typeof ctx.flags.flakes === 'string' ? ctx.flags.flakes : '.lynkeus/flakes.json'));
  const casesAt = path.relative(ctx.root, path.resolve(config.base ?? ctx.root, config.dir ?? 'cases'));
  const stamp = ledger ? appStamp(ctx.root, ['.lynkeus', ...(casesAt && !casesAt.startsWith('..') ? [casesAt] : [])]) : undefined;
  // A run file files each event under its step, so it needs them collected.
  const events = typeof ctx.flags.events === 'string' || (out !== undefined && !ctx.flags['no-app-events']);
  const jobsAsked = Math.max(1, Number(ctx.flags.jobs ?? 1));
  // Hosts side by side need a port each; with none given, free ones are picked, past the one an attached app dials.
  const runPorts =
    typeof ctx.flags.ports === 'string'
      ? ctx.flags.ports.split(',').map(Number)
      : (jobsAsked > 1 || typeof ctx.flags['host-command'] === 'string' || !!ctx.flags.host) && !dry
        ? await freePorts(jobsAsked, portFromEnv(ctx.config) ?? DEFAULT_PORT)
        : undefined;
  if (runPorts && typeof ctx.flags.ports !== 'string') ctx.err(`driver ports: ${runPorts.join(', ')} (picked free; --ports chooses them)`);
  const runLabel = `${cases.length === 1 ? cases[0]!.id : `${cases.length} cases (${cases[0]?.id ?? 'none'}…)`}, started ${new Date().toLocaleTimeString()}${out ? `, out ${out.directory}` : ''}`;
  const claimed = dry
    ? undefined
    : claimPorts(runPorts ? runPorts.filter(Number.isInteger).slice(0, jobsAsked) : [portFromEnv(ctx.config) ?? DEFAULT_PORT], undefined, runLabel, ctx.shares);
  if (claimed && 'refused' in claimed) return { text: claimed.refused, code: 1 };
  // Another process's driver on a host's port (a `lynkeus mcp` server on 8123) would take that host's app: the
  // run would wait on an app that never reaches it.
  const listened = claimed && runPorts ? await listenedPorts(runPorts.filter(Number.isInteger).slice(0, jobsAsked)) : [];
  if (listened.length > 0) {
    claimed?.release();
    return {
      text: `port ${listened.join(', ')} is already in use by another process (a \`lynkeus mcp\` server or another run's driver?): this run's hosts would dial it. Stop that process, or give this run other --ports`,
      code: 1,
    };
  }
  // Stopped by the caller giving up (an MCP client cancelling the call), by `case stop`, or not at all.
  const halt = new AbortController();
  // What ended the run when it could not go on (a host's port taken), as against a caller stopping it.
  let fatal: string | undefined;
  const stopWith = (why: string) => {
    if (!halt.signal.aborted) halt.abort(why);
  };
  // `--on` stops the run of each target with its own reason: a stop asked with case stop is not a cancelled call.
  const cancelled = () => stopWith(typeof ctx.signal?.reason === 'string' ? ctx.signal.reason : 'the caller cancelled case run');
  if (ctx.signal?.aborted) cancelled();
  ctx.signal?.addEventListener('abort', cancelled, { once: true });
  // A port claim left behind would refuse every later run of this process on that port.
  const letGo = () => {
    claimed?.release();
    ctx.signal?.removeEventListener('abort', cancelled);
  };
  const progressFile = dry
    ? undefined
    : out
      ? path.join(out.directory, PROGRESS_FILE)
      : path.join(ctx.root, '.lynkeus', `last-run.${as.target ? `${targetSlug(as.target)}.` : ''}${PROGRESS_FILE}`);
  const hostPids = new HostPids(progressFile ? hostsFileOf(progressFile) : undefined);
  // `--host` starts a host per job on a free port of its own, as `lynkeus ci` and `--on headless` do. A host dialing the
  // configured port would meet whatever app is attached there (a Simulator's, an emulator's): the run would drive both,
  // mixing their screens and mocks, and with several jobs it would attach to no job's driver.
  const hostPerJob = !!ctx.flags.host && typeof ctx.flags['host-command'] !== 'string' && !dry;
  // With --keep-hosts, each job's own long-lived host, by job.
  const kept: (ChildProcess | undefined)[] = [];
  const fixtures = config.fixtures && !dry ? new Fixtures(config.fixtures, home) : undefined;
  const traces = ctx.flags.traces && !dry ? new TraceSink(Number(ctx.flags['traces-port'] ?? 4318)) : undefined;
  if (traces) {
    try {
      await traces.start();
    } catch (error) {
      fixtures?.close();
      letGo();
      return { text: `--traces could not listen on port ${traces.port}: ${(error as Error).message}`, code: 2 };
    }
    ctx.err(`backend traces: listening on http://localhost:${traces.port} (the backend's OTEL_EXPORTER_OTLP_ENDPOINT)`);
  }
  // Where the run stands, as events: in the run directory (or the project's .lynkeus when there is none), on
  // stdout with --progress json, to an MCP caller, and on the live line in a terminal.
  // `case stop` from another process leaves this file; the run looks for it between its own steps' waits.
  const stopFile = progressFile ? `${progressFile}.stop` : undefined;
  if (progressFile) {
    fs.mkdirSync(path.dirname(progressFile), { recursive: true });
    fs.writeFileSync(progressFile, '');
    if (stopFile) fs.rmSync(stopFile, { force: true });
    // Beside other targets, `--on` keeps the last run's file for the whole run, so case status and case stop see all of it.
    if (!as.target) writeLastRun(ctx.root, progressFile, stopFile);
  }
  const watching = stopFile
    ? setInterval(() => {
        if (!fs.existsSync(stopFile)) return;
        fs.rmSync(stopFile, { force: true });
        stopWith('stopped with case stop');
      }, STOP_POLL_MS)
    : undefined;
  watching?.unref();
  const state = new RunState();
  let live: LiveLine | undefined;
  // A stopped run says it ended once; a case still finishing its step after that is not news.
  let ended = false;
  const emit = (e: ProgressEvent) => {
    if (ended) return;
    if (e.type === 'run-end') ended = true;
    state.apply(e);
    if (progressFile) fs.appendFileSync(progressFile, `${JSON.stringify(e)}\n`);
    if (jsonProgress) process.stdout.write(`${JSON.stringify(e)}\n`);
    ctx.progress?.(e);
    live?.refresh();
  };
  const now = () => new Date().toISOString();
  let liveRun: LiveRun | undefined;
  // The hosts started for one case (--host-command), so a stopped run stops them too.
  const perCase = new Set<ChildProcess>();
  const stop = () => {
    live?.stop();
    traces?.close();
    letGo();
    fixtures?.close();
    for (const h of kept) if (h?.pid) stopGroup(h.pid);
    for (const h of perCase) if (h.pid) stopGroup(h.pid);
    if (watching) clearInterval(watching);
    // An MCP server runs many case runs: one's handlers left behind would end the server for a run long over.
    process.off('SIGINT', interrupted);
    process.off('SIGTERM', interrupted);
  };
  const interrupted = () => {
    stop();
    process.exit(130);
  };
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  let settle: () => void = () => undefined;
  const registered: ActiveRun = {
    label: runLabel,
    progress: progressFile,
    stop: stopWith,
    done: new Promise<void>((resolve) => {
      settle = resolve;
    }),
  };
  if (!dry) active.add(registered);
  const heapPercent = Number(ctx.flags['host-heap'] ?? 60);
  const reports: (CaseReport & { retried?: boolean })[] = [];
  let localReport: ReturnType<typeof writeRunReport> | undefined;
  // Said again with the summary: over MCP the summary is all the caller reads.
  let rebundled: string | undefined;
  // An app on a device running JavaScript older than the source, said again with the summary.
  let staleJs: string | undefined;
  let staleJsCheck: Promise<void> | undefined;
  try {
    // A case that names a fixture the server does not have fails halfway, after it has changed the backend. Better not to start.
    const described = await fixtures?.describe();
    if (described?.down) return { text: `the fixtures server cannot serve: ${described.down}`, code: 1 };
    if (described) {
      const missing = cases.flatMap((c) => missingFixtures(c, config, described.commands).map((name) => `${c.id}: no fixture ${name}`));
      if (missing.length > 0) return { text: [...missing, `the fixtures command answers: ${described.commands.join(', ')}`].join('\n'), code: 1 };
    }
    const jobs = Math.max(1, Number(ctx.flags.jobs ?? 1));
    const ports = runPorts ?? [];
    const hostCommand = typeof ctx.flags['host-command'] === 'string' && !dry ? ctx.flags['host-command'] : hostPerJob ? selfHeadlessCommand() : undefined;
    const keepHosts = (!!ctx.flags['keep-hosts'] || hostPerJob) && hostCommand !== undefined;
    const headlessHosts = startsHeadless(hostCommand);
    if (hostPerJob)
      ctx.err(
        jobs > 1
          ? `--host with --jobs ${jobs}: one headless host per job, on ports ${ports.slice(0, jobs).join(', ')}, kept for the run`
          : `--host: a headless host on port ${ports[0]}, its own (an app attached on the configured port is left alone), kept for the run`,
      );
    // One grant for the whole run, in the hosts' environment: fastsim-run would otherwise run `npx --no-install lynkeus`,
    // which finds nothing when lynkeus itself runs from the npx cache.
    let hostEnv: NodeJS.ProcessEnv = process.env;
    if (hostCommand) {
      // Never a run on a bundle older than the app's code: it would report on the app as it was.
      const fresh = await freshBundle(hostCommand, ctx.root, { skip: [path.resolve(home, config.dir ?? 'cases')], log: ctx.err, signal: halt.signal });
      if (!fresh.ok) return { text: fresh.text, code: 1 };
      rebundled = fresh.note;
      if (rebundled) ctx.err(rebundled);
      const granted = await hostGrantEnv(ctx, hostCommand);
      if ('failed' in granted) return granted.failed;
      hostEnv = granted.env;
    }
    // The config's native constants reach the host's environment: it reads them when it starts, before the app does.
    const nativeValues = nativeValuesEnv(config.nativeMocks);
    if (nativeValues) hostEnv = { ...hostEnv, LYNKEUS_NATIVE_VALUES: nativeValues };
    // A job's kept host serves case after case; one that died, lost its app or is about to run out of heap
    // would fail every case after it, so it is checked before each case and started again.
    const keptUp = async (index: number, port: number, log: (line: string) => void): Promise<void> => {
      if (halt.signal.aborted) return;
      const host = kept[index];
      if (host && !exited(host)) {
        const probe = ctx.forPort!(port);
        const memory = await probe.base.device().then(
          (d) => d.command<HostMemory>('memory').catch(() => ({})),
          () => undefined,
        );
        await probe.stop();
        const full = memory ? heapPast(memory, heapPercent) : undefined;
        if (memory && !full) return;
        log(`host on port ${port}: ${full ? `its heap is at ${full}` : 'is running but its app is not attached'}; starting it again`);
        await stopHost(host);
      } else if (host) log(`host on port ${port}: exited (${host.exitCode ?? host.signalCode}); starting it again`);
      const logFile = hostPerJob ? path.join(os.tmpdir(), `lynkeus-headless-${process.pid}-${port}.log`) : undefined;
      const started = spawnHost(hostCommand!, port, index, ctx.root, hostEnv, launch, logFile);
      if (logFile) log(`host on port ${port}: starting (its log: ${logFile})`);
      hostPids.add(started);
      kept[index] = started;
      const until = Date.now() + Number(ctx.flags['host-timeout'] ?? 600_000);
      while (!exited(started) && Date.now() < until && !halt.signal.aborted) {
        const probe = ctx.forPort!(port);
        const tried = Date.now();
        const failure = await probe.base.device().then(
          () => undefined,
          (error: unknown) => error ?? new Error('no app attached'),
        );
        await probe.stop();
        if (failure === undefined) return;
        // Waiting on would not free the port, and hosts dialing it reach the other process's driver.
        if ((failure as { code?: string }).code === 'port-in-use') {
          fatal ??= `port ${port} is taken by another process (a \`lynkeus mcp\` server or another run's driver?): its host cannot attach to this run. Stop that process, or give this run other --ports`;
          stopWith(fatal);
          return void (await stopHost(started));
        }
        // A probe that fails at once, with no wait for an app, would otherwise spin with no pause until the
        // timeout, starving the event loop and filling the heap.
        await new Promise((r) => setTimeout(r, Math.max(0, ATTACH_PROBE_MS - (Date.now() - tried))));
      }
      if (halt.signal.aborted) return void (await stopHost(started));
      log(`host on port ${port}: ${exited(started) ? `exited (${started.exitCode ?? started.signalCode})` : 'did not attach in time'}`);
    };
    if ((jobs > 1 || hostCommand) && (ports.length < jobs || ports.some((p) => !Number.isInteger(p)) || !ctx.forPort))
      return { text: `--jobs and --host-command need a driver port per job: --ports with ${jobs}`, code: 2 };
    // One simulator or emulator, one log: with several jobs a line could not be told to its case.
    const native: NativeLogs | undefined =
      out && jobs === 1 && !hostCommand && !ctx.flags.host && ctx.config.app
        ? await ctx
            .device()
            .then((d) => d.resolved())
            .then((info) => startNativeLogs(info, ctx.config.app as string))
            .catch(() => undefined)
        : undefined;
    // Checked beside the first case, once the app attaches: waiting for it here would add the attach wait twice when no app comes.
    staleJsCheck =
      !dry && !hostCommand && !ctx.flags.host
        ? ctx
            .device()
            .then((d) => deviceJsWarning(d, ctx.root, [path.resolve(home, config.dir ?? 'cases')]))
            .then(
              (warning) => {
                staleJs = warning;
                if (warning) ctx.err(warning);
              },
              () => undefined,
            )
        : undefined;
    // Several jobs finish together only if the longest cases start first: one left for the end runs alone
    // while the other jobs wait. A case the ledger has not timed goes first too, as it may be long.
    if (jobs > 1 && ledger && !ctx.flags['in-order']) {
      const took = (id: string) => ledger.lastMs(id) ?? Number.POSITIVE_INFINITY;
      cases.sort((a, b) => took(b.id) - took(a.id));
    }
    emit({
      type: 'run-start',
      at: now(),
      pid: process.pid,
      total: cases.length,
      jobs,
      cases: cases.map((c) => {
        const expectedMs = ledger?.lastMs(c.id);
        return { id: c.id, ...(c.title ? { title: c.title } : {}), ...(expectedMs !== undefined ? { expectedMs } : {}) };
      }),
      ...(out ? { out: out.directory } : {}),
    });
    if (!dry && !jsonProgress && progressMode !== 'none' && !ctx.attached && process.stderr.isTTY && !process.env.CI)
      live = new LiveLine(process.stderr, () => statusLine(state.status()));
    // The report is made now and filled case by case; a service that cannot gets the whole run at the end.
    if (reportsTo && out)
      try {
        liveRun = await startLiveRun(out.directory, { ...reportsTo, project, planned: cases.length, onError: ctx.err });
        emit({ type: 'report', at: now(), url: liveRun.url });
        ctx.err(`report: ${liveRun.url} (it fills as the cases run)`);
      } catch (error) {
        ctx.err(`the report will be uploaded when the run ends: ${(error as Error).message}`);
      }
    const limit = Number(ctx.flags.ahead ?? 0);
    const store: Store | undefined =
      typeof ctx.flags.prepared === 'string' && !dry ? new Ahead(path.resolve(ctx.flags.prepared)) : limit > 0 && fixtures ? new InMemory() : undefined;
    const declared = config.fixtures;
    // The setups of the cases to come, made while these run, in the order the jobs will take them.
    const preparing =
      limit > 0 && declared && store && !dry
        ? prepareAhead(
            // An exclusive case's setup may be what changes the shared state: it is made in its own turn.
            cases.filter((c) => preparable(c, config) && !c.exclusive),
            {
              base: ctx,
              config,
              store,
              open: () => new Fixtures(declared, home),
              limit,
              idle: Number(ctx.flags.idle ?? 0.25),
              jobs: 1,
            },
          )
        : undefined;
    let next = 0;
    const turns = new Turns();
    // The shared hosts that have served a case: the next case on one starts with a reset.
    const served = new WeakSet<ChildProcess>();
    const job = async (index: number) => {
      // Each job keeps its own connection to the fixtures server, warm from one case to the next.
      const own = index === 0 ? fixtures : declared && !dry ? new Fixtures(declared, home) : undefined;
      const port = ports[index];
      try {
        for (let c = cases[next++]; c && !halt.signal.aborted; c = cases[next++]) {
          const lines: string[] = [];
          // With several jobs a case's lines are held and printed together, not interleaved.
          const log = jobs > 1 ? (line: string) => lines.push(line) : ctx.err;
          if (c.exclusive && turns.busy(true)) ctx.err(`… ${c.id} runs alone: waiting for the cases in flight to end`);
          const release = await turns.take(!!c.exclusive);
          try {
            log(`▶ ${c.id}${c.title ? ` — ${c.title}` : ''}`);
            store?.start(c);
            const attempt = async (n: number, prepared?: Prepared) => {
              if (keepHosts && port !== undefined) await keptUp(index, port, log);
              let host =
                hostCommand && port !== undefined && !keepHosts && !halt.signal.aborted
                  ? spawnHost(hostCommand, port, index, ctx.root, hostEnv, caseLaunch(launch, c.id, n))
                  : undefined;
              if (host) {
                perCase.add(host);
                hostPids.add(host);
              }
              const scoped = port !== undefined && ctx.forPort ? ctx.forPort(port) : { base: ctx as Base, stop: async () => undefined };
              const startedAt = new Date();
              emit({
                type: 'case-start',
                at: startedAt.toISOString(),
                id: c.id,
                job: index,
                attempt: n,
                steps: (prepared ? 0 : c.setup.length) + c.steps.length,
                ...(port !== undefined ? { host: `port ${port}` } : ctx.flags.host ? { host: 'headless' } : {}),
              });
              try {
                // A host just started is still drawing its first screens; with the setup made ahead nothing
                // else gives it that moment before the first press.
                if (host)
                  await scoped.base
                    .device()
                    .then((d) => d.idle({ quietMs: 300, timeoutMs: 5000 }))
                    .catch(() => undefined);
                // A headless host shared by cases (`--host`, kept hosts) still holds what the last case left: mocked
                // storage, network rules, the clock, the screen. It starts this one as a host of its own would.
                const shared = headlessHosts && keepHosts && !host ? kept[index] : undefined;
                const reset = shared !== undefined && served.has(shared) && (await resetSharedHost(scoped.base, log));
                if (shared) served.add(shared);
                const report = await runCase(c, {
                  base: scoped.base,
                  config,
                  fixtures: own,
                  dry,
                  events,
                  evidence: evidenceOf(c.id, n),
                  keep: out !== undefined,
                  log,
                  prepared,
                  continue: !!ctx.flags.continue,
                  seed: launch.seed,
                  routes: seenDir ? (host || reset ? 'fresh' : true) : false,
                  traces,
                  nativeLogs: native,
                  ownHost: !!hostCommand,
                  signal: halt.signal,
                  // A host the run started is started again for a relaunch, as the next case would find it.
                  ...(hostCommand && port !== undefined
                    ? {
                        relaunch: async () => {
                          const attached = nextHello((await scoped.base.device()).server, HOST_RELAUNCH_MS);
                          if (keepHosts) {
                            if (kept[index]) await stopHost(kept[index]!);
                            kept[index] = spawnHost(hostCommand, port, index, ctx.root, hostEnv, launch);
                            hostPids.add(kept[index]!);
                          } else {
                            if (host) {
                              await stopHost(host);
                              perCase.delete(host);
                            }
                            host = spawnHost(hostCommand, port, index, ctx.root, hostEnv, caseLaunch(launch, c.id, n));
                            perCase.add(host);
                            hostPids.add(host);
                          }
                          if (!(await attached.done)) throw new Error(`the host started again did not attach within ${HOST_RELAUNCH_MS / 1000} s`);
                        },
                      }
                    : {}),
                  onStep: (p) => emit({ type: 'step', at: now(), id: c.id, job: index, ...p }),
                });
                const mine = keepHosts ? kept[index] : host;
                const lost = report.result === 'failed' && mine ? ((await hostLost(mine, undefined)) ?? agentSilent(report, mine, headlessHosts)) : undefined;
                if (lost) {
                  report.diagnosis = [...(report.diagnosis ?? []), `during this case the host ${lost}`];
                  report.evidence = {
                    ...report.evidence,
                    why: [report.evidence?.why, `  • during this case the host ${lost}`].filter(Boolean).join('\n'),
                  };
                }
                if (seenDir && report.result === 'passed' && report.routes?.length) {
                  fs.mkdirSync(seenDir, { recursive: true });
                  const walked = report.steps.map((s) => (s.route ? { step: s.step, route: s.route } : { step: s.step }));
                  fs.writeFileSync(
                    path.join(seenDir, `${caseArtifactId(c.id)}.json`),
                    `${JSON.stringify({ id: c.id, routes: report.routes, steps: walked }, null, 2)}\n`,
                  );
                }
                return { report, startedAt, hello: (await scoped.base.device().catch(() => undefined))?.server.hello ?? undefined };
              } finally {
                if (host) {
                  await stopHost(host);
                  perCase.delete(host);
                }
                await scoped.stop();
              }
            };
            let {
              report,
              startedAt,
              hello,
            }: { report: CaseReport & { retried?: boolean }; startedAt: Date; hello?: { platform?: string; native?: boolean; commands?: string[] } } =
              await attempt(1, store?.take(c));
            // What a stopped case did after the stop is not a result: it ran only until its step ended.
            if (halt.signal.aborted) break;
            seen ??= hello;
            const retry = report.result === 'failed' && !ctx.flags.once && !dry;
            emit({
              type: 'case-end',
              at: now(),
              id: c.id,
              job: index,
              attempt: 1,
              result: report.result,
              ms: report.ms,
              ...(retry ? { retrying: true } : {}),
            });
            log(describe(report, { verbose }));
            const first = out?.add(c, { report, attempt: 1, startedAt });
            if (first) liveRun?.add(first);
            if (retry) {
              log(`  retrying ${c.id} once`);
              const again = await attempt(2);
              if (halt.signal.aborted) break;
              report = { ...again.report, retried: true };
              startedAt = again.startedAt;
              emit({ type: 'case-end', at: now(), id: c.id, job: index, attempt: 2, result: report.result, ms: report.ms });
              log(describe(report, { verbose }));
              const second = out?.add(c, { report, attempt: 2, startedAt });
              if (second) liveRun?.add(second);
            }
            if (jobs > 1) ctx.err(lines.join('\n'));
            // A case whose app never attached did not run: its failure says nothing about the case.
            if (hello) ledger?.note(report, new Date(), caseVersion(c, config.macros), { where: whereOf(hello), app: stamp });
            if (typeof ctx.flags.events === 'string' && report.events) {
              const dir = path.resolve(ctx.flags.events as string, caseArtifactId(c.id));
              fs.mkdirSync(dir, { recursive: true });
              fs.writeFileSync(eventsFile(dir), report.events.map((e) => `${JSON.stringify(e)}\n`).join(''));
            }
            reports.push(report);
            if (ctx.flags.report) fs.appendFileSync(path.resolve(ctx.flags.report as string), `${JSON.stringify(report)}\n`);
          } finally {
            release();
          }
        }
      } finally {
        if (own !== fixtures) own?.close();
      }
    };
    let seen: { platform?: string; native?: boolean } | undefined;
    // A stop does not wait for the case on the app to reach the end of its step: the hosts and ports are let go
    // now, and that case ends on its own, starting no other step.
    const halted = new Promise<void>((resolve) => {
      if (halt.signal.aborted) resolve();
      halt.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    await Promise.race([Promise.all(Array.from({ length: jobs }, (_, i) => job(i))), halted]);
    if (!halt.signal.aborted) await preparing;
    if (out) out.finish({ platform: seen?.platform, native: seen?.native, nativeValues: mergeNativeValues(reports.map((r) => r.nativeValues)) });
    native?.stop();
    if (out) localReport = writeRunReport(out.directory, { project });
  } finally {
    stop();
    // Signalled is not gone: a run that ends while its hosts are still on their way out leaves them listed and
    // alive for whoever started it (`lynkeus ci` stops "hosts the run left running").
    await Promise.all([...kept, ...perCase].flatMap((h) => (h ? [stopHost(h)] : [])));
    active.delete(registered);
    settle();
  }
  const stoppedBy = halt.signal.aborted ? String(halt.signal.reason) : undefined;
  const count = (result: CaseReport['result']) => reports.filter((r) => r.result === result).length;
  const unsupported = count('unsupported');
  // A stopped run's report is finished with what ran; one that was to be uploaded at the end is not.
  const uploaded =
    reportsTo && out && (!stoppedBy || liveRun)
      ? await pushed(
          path.resolve(ctx.flags.out as string),
          reportsTo,
          project,
          ctx.err,
          ctx.config.report?.afterPush === 'delete' ? 'delete' : 'keep',
          liveRun ? { run: liveRun, manifest: out.current } : undefined,
        )
      : undefined;
  emit({
    type: 'run-end',
    at: now(),
    passed: count('passed'),
    failed: count('failed'),
    unsupported,
    ms: state.status().elapsedMs,
    ...(uploaded?.url ? { report: uploaded.url } : {}),
    ...(stoppedBy ? { stopped: stoppedBy } : {}),
  });
  await staleJsCheck;
  const nativeReads = mergeNativeValues(reports.map((r) => r.nativeValues));
  const notes = [
    ...(fatal
      ? [`✖ the run could not go on after ${reports.length} of ${cases.length} cases: ${fatal}`]
      : stoppedBy
        ? [
            `⏹ stopped (${stoppedBy}) after ${reports.length} of ${cases.length} cases; no step starts after it, any host it started is stopped and its ports are let go`,
          ]
        : []),
    // Its full path: a relative --out resolves against where the CLI was started, which over MCP is the app's folder.
    ...(out ? [`run kept in ${path.resolve(ctx.flags.out as string)}`] : []),
    // A push may have deleted the folder (report.afterPush: delete).
    ...(localReport && 'file' in localReport && fs.existsSync(localReport.file) ? [`report: ${localReport.file} (open it in a browser, offline)`] : []),
    ...(rebundled ? [rebundled] : []),
    ...(staleJs ? [staleJs] : []),
    ...(out
      ? missingEvidence(reports, {
          video: !!ctx.flags.video,
          screenshots: !!ctx.flags.screenshots,
          sdks: analyticsSdksOf(ctx.root),
          ownHost: typeof ctx.flags['host-command'] === 'string' || !!ctx.flags.host,
        })
      : []),
    ...onceUnlessVerbose(
      `native values the ${as.target ? `${as.target} ` : ''}host did not answer`,
      describeNativeValues(nativeReads, {
        entry: headlessEntryOf(ctx.root, ctx.config),
        nativeMocks: ctx.config.cases?.nativeMocks,
        specs: readNativeSpecs(ctx.root, new Set(nativeReads.filter((r) => r.readAs === 'function' && !r.called).map((r) => r.module))),
      }),
      verbose,
    ),
    ...(ledger ? ledger.flaky(reports.map((r) => r.id)) : []),
    ...(uploaded ? [uploaded.text] : []),
  ];
  const summary = [
    ...reports.map(
      (r) =>
        `${{ passed: '✅', failed: '❌', unsupported: '🚫' }[r.result]} ${r.id}${r.retried && r.result === 'passed' ? '  ⚠ passed on retry' : ''}` +
        // In a session or over MCP the caller reads this answer and nothing else: a case that did not pass brings its steps.
        (ctx.attached && r.result !== 'passed'
          ? `\n${describe(r, { verbose, headline: false })}`
          : r.warnings?.length
            ? `\n${r.warnings.map((w) => `  ⚠ ${w}`).join('\n')}`
            : '') +
        (dry ? `\n${expandSteps(cases.find((c) => c.id === r.id)!, config).join('\n')}` : ''),
    ),
    `${count('passed')}/${reports.length} passed${unsupported ? `, ${unsupported} cannot run on this host` : ''}`,
    ...notes,
  ].join('\n');
  ledger?.save();
  // A case this host cannot run is not a failure of the app; only a failed case fails the run.
  const code = fatal ? 1 : stoppedBy ? 130 : count('failed') === 0 ? 0 : 1;
  // stdout holds the events alone: the summary goes where the run's lines went.
  if (jsonProgress) {
    ctx.err(summary);
    return { code, reports, notes };
  }
  return { text: summary, json: reports, code, reports, notes };
};

/** The folders fastsim-bundle made under the project's .lynkeus (each holds host.args), the last bundled first. */
export const fastsimBundles = (root: string): string[] => {
  const dir = path.join(root, '.lynkeus');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const built = (bundle: string) => fs.statSync(path.join(bundle, 'app.hbc'), { throwIfNoEntry: false })?.mtimeMs ?? 0;
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => path.join(dir, e.name))
    .filter((bundle) => fs.existsSync(path.join(bundle, 'host.args')))
    .sort((a, b) => built(b) - built(a));
};

/** The platform a bundle fastsim-bundle made draws, from its host.args; undefined when it has none. */
export const bundlePlatform = (bundle: string): string | undefined => {
  try {
    return /--platform (\w+)/.exec(fs.readFileSync(path.join(bundle, 'host.args'), 'utf8'))?.[1] ?? 'ios';
  } catch {
    return undefined;
  }
};

/**
 * The host command of a FastSim target: the one `ci.hosts.command` gives when it starts fastsim-run (on a bundle of
 * `platform`, when one is asked for), else the installed kit's fastsim-run on `bundle` or the last bundle under
 * .lynkeus (of `platform`). Why there is none, when there is none.
 */
export const fastsimHostCommand = (
  root: string,
  o: { bundle?: string; configured?: string; kits?: string; platform?: 'ios' | 'android' } = {},
): { command: string } | { unavailable: string } => {
  const configuredBundle = o.configured ? fastsimBundleDir(o.configured, root) : undefined;
  if (!o.bundle && o.configured && configuredBundle && (!o.platform || bundlePlatform(configuredBundle) === o.platform)) return { command: o.configured };
  const anyKit = o.platform ? installedKit(o.platform, o.kits) : (installedKit('ios', o.kits) ?? installedKit('android', o.kits));
  if (installedFastsim(o.kits).length === 0 || !anyKit)
    return { unavailable: `not installed: \`lynkeus fastsim install --platform ${o.platform ?? 'ios|android'}\` (Team plan)` };
  // A bundle given for the other platform is that target's: this one takes its own platform's last bundle.
  const given = o.bundle ? path.resolve(root, o.bundle) : undefined;
  const bundle =
    given && (!o.platform || bundlePlatform(given) === o.platform) ? given : fastsimBundles(root).find((b) => !o.platform || bundlePlatform(b) === o.platform);
  if (!bundle) {
    const p = o.platform ?? 'ios';
    return {
      unavailable: `no ${o.platform ? `${o.platform} ` : ''}bundle under .lynkeus: make one with ${path.join(anyKit, 'bin', 'fastsim-bundle')} ${root} ${path.join(root, '.lynkeus', `fastsim-${p}`)} ${p}${o.platform ? '' : ' (or android)'}, or pass --bundle`,
    };
  }
  const platform = bundlePlatform(bundle);
  if (!platform) return { unavailable: `${bundle} has no host.args: is it a folder fastsim-bundle made?` };
  const kit = installedKit(platform, o.kits);
  if (!kit)
    return { unavailable: `the bundle draws ${platform}, and no Lynkeus FastSim for it is installed: \`lynkeus fastsim install --platform ${platform}\`` };
  return { command: `${JSON.stringify(path.join(kit, 'bin', 'fastsim-run'))} ${JSON.stringify(bundle)} {port}` };
};

/**
 * Each case's declared targets (`--on targets`), in the order of `cases`; a sentence when a case declares none and
 * the project neither, or one names something that is not a target.
 */
export const casesDeclared = (cases: Case[], project: readonly string[] | undefined): { id: string; targets: TargetName[] }[] | string => {
  const out: { id: string; targets: TargetName[] }[] = [];
  const bare: string[] = [];
  for (const c of cases) {
    const targets = declaredTargets(c.meta, project, path.basename(c.file));
    if (typeof targets === 'string') return targets;
    if (!targets) bare.push(c.id);
    else out.push({ id: c.id, targets });
  }
  if (bare.length > 0)
    return `--on targets: the project declares no targets (cases.targets in lynkeus.config.json)${out.length ? ` and ${bare.length} case(s) none of their own (${bare.slice(0, 3).join(', ')}${bare.length > 3 ? ', …' : ''})` : ''}. Ask the person where cases must pass (\`lynkeus status\` proposes a value from this machine), then set it, e.g. "cases": { "targets": ["headless", "ios"] }`;
  return out;
};

// The flags that pick one place to run: `--on` picks each target's itself.
const ONE_PLACE = ['host', 'host-command', 'keep-hosts', 'ports'];

/** `case run --on`: each target that can run here gets the cases, side by side; see cases/onTargets.ts. */
const casesOnTargets = async (ctx: Ctx): Promise<Result> => {
  const on = parseTargets(String(ctx.flags.on));
  if (typeof on === 'string' && on !== 'declared') return { text: on, code: 2 };
  const clash = ONE_PLACE.filter((f) => ctx.flags[f] !== undefined && ctx.flags[f] !== false);
  if (clash.length > 0) return { text: `--on starts each target's hosts itself: leave out ${clash.map((f) => `--${f}`).join(', ')}`, code: 2 };
  const config = ctx.config.cases ?? {};
  const files = caseFiles(ctx.args, config.base ?? ctx.root, config.dir);
  if (typeof files === 'string') return { text: files, code: 1 };
  const cases = files.flatMap(readCases);
  const declared = on === 'declared' ? casesDeclared(cases, config.targets) : undefined;
  if (typeof declared === 'string') return { text: declared, code: 2 };
  const targets = declared ? TARGETS.filter((t) => declared.some((c) => c.targets.includes(t))) : (on as TargetName[]);
  const port = portFromEnv(ctx.config) ?? DEFAULT_PORT;
  const jobs = Math.max(1, Number(ctx.flags.jobs ?? 1));
  const hostTargets: TargetName[] = targets.filter((t) => !DEVICE_TARGETS.includes(t));
  // Picked together, so two targets starting side by side cannot pick the same free port.
  const hostPorts = hostTargets.length > 0 ? await freePorts(jobs * hostTargets.length, port) : [];
  const portsOf = (t: TargetName) => hostPorts.slice(hostTargets.indexOf(t) * jobs, (hostTargets.indexOf(t) + 1) * jobs);
  const out = typeof ctx.flags.out === 'string' ? ctx.flags.out : undefined;
  const ledger = typeof ctx.flags.flakes === 'string' ? ctx.flags.flakes : path.join('.lynkeus', 'flakes.json');
  const own = (t: TargetName): FlagValues => ({
    ...Object.fromEntries(ONE_PLACE.map((f) => [f, undefined])),
    ...(out ? { out: path.join(out, targetSlug(t)) } : {}),
    ...(typeof ctx.flags.events === 'string' ? { events: path.join(ctx.flags.events, targetSlug(t)) } : {}),
    // A case may pass on one target and fail on another without being flaky, and runs side by side must not write one
    // file: the hosts keep their own ledger; the attached app keeps the one a plain run on it keeps.
    ...(t === 'simulator' ? {} : { flakes: ledger.replace(/(\.json)?$/, `.${targetSlug(t)}.json`) }),
  });
  const onHosts = async (t: TargetName, command: string): Promise<TargetPlan> => {
    const ports = portsOf(t);
    if (ports.length < jobs) return { unavailable: `no ${jobs} free driver port(s) past ${port}` };
    return { flags: { ...own(t), 'host-command': command, 'keep-hosts': true, ports: ports.join(','), jobs }, jobs };
  };
  // `ios` and `android` each attach their own platform's app on the same port, side by side (the driver hands each app
  // to the connection that takes its platform); `simulator` takes whichever app is attached.
  const onDevice = async (t: TargetName): Promise<TargetPlan> => {
    const platform = t === 'ios' || t === 'android' ? t : undefined;
    const probe = await phoneProbe(ctx, platform);
    if (probe) return { unavailable: probe };
    const where = platform === 'ios' ? 'the iOS Simulator' : platform === 'android' ? 'the Android emulator or phone' : 'a booted Simulator or emulator';
    const scoped = platform ? ctx.forApp?.((hello) => hello.platform === platform && onPhone({ hello }), platform) : undefined;
    if (platform && !scoped)
      return { unavailable: `cannot attach the ${platform} app on a connection of its own here: run --on ${platform} from the CLI or the MCP server` };
    const base = scoped?.base ?? ctx;
    const unavailable = async (why: string): Promise<TargetPlan> => {
      await scoped?.stop().catch(() => undefined);
      return { unavailable: why };
    };
    const asking = base.device().catch((error: unknown) => (error as Error).message.split('\n')[0] ?? 'no app');
    // Something is running, but a development build already open dials in within a second or two: waiting the
    // whole attach timeout is for an app being launched.
    const patient =
      ctx.flags.launch ||
      ctx.flags['attach-timeout'] !== undefined ||
      process.env.LYNKEUS_ATTACH_TIMEOUT_MS !== undefined ||
      ctx.config.attachTimeout !== undefined;
    const device = patient
      ? await asking
      : await Promise.race([
          asking,
          new Promise<string>((resolve) => setTimeout(() => resolve(`none within ${QUICK_ATTACH_MS / 1000} s`), QUICK_ATTACH_MS).unref()),
        ]);
    if (typeof device === 'string') return unavailable(`no app attached from ${where} on port ${port} (${device}): open the development build there`);
    const hello = device.server.connected ? device.server.hello : await device.server.waitForApp(3000).catch(() => null);
    if (!hello) return unavailable(`the app on port ${port} is gone: open the development build on ${where} again`);
    if (!onPhone({ hello }))
      return unavailable(
        `the app on port ${port} runs on ${hello.app?.runtime === 'headless' ? 'the headless host' : 'a host (FastSim)'}, not on a Simulator or emulator`,
      );
    return {
      flags: { ...own(t), jobs: 1 },
      jobs: 1,
      label: platform ?? (hello.platform === 'android' ? 'emulator' : 'simulator'),
      ...(scoped ? { base: scoped.base, stop: scoped.stop } : {}),
    };
  };
  const plan = async (t: TargetName): Promise<TargetPlan> => {
    if (DEVICE_TARGETS.includes(t)) return onDevice(t);
    if (t === 'headless') {
      const check = (await runtimeAt(ctx.root)).headlessCheck(ctx.root, headlessEntryOf(ctx.root, ctx.config));
      if (!check.ok) return { unavailable: `not set up${check.fix ? `: ${check.fix}` : ''}` };
      return onHosts(t, `LYNKEUS_PORT={port} ${JSON.stringify(process.execPath)} ${JSON.stringify(process.argv[1] ?? 'lynkeus')} headless start`);
    }
    const found = fastsimHostCommand(ctx.root, {
      bundle: typeof ctx.flags.bundle === 'string' ? ctx.flags.bundle : undefined,
      configured: ctx.config.ci?.hosts?.command,
      ...(t === 'fastsim:ios' ? { platform: 'ios' as const } : t === 'fastsim:android' ? { platform: 'android' as const } : {}),
    });
    if ('unavailable' in found) return found;
    // Asked before the run, so a missing sign-in or seat is a target this machine cannot use, not a failed run.
    const granted = await hostGrantEnv(ctx, found.command);
    if ('failed' in granted) return { unavailable: (granted.failed.text ?? 'no grant').split('\n')[0] ?? 'no grant' };
    return onHosts(t, found.command);
  };
  return runOnTargets(ctx, {
    targets,
    cases: cases.map((c, i) => ({ id: c.id, file: c.file, ...(c.title ? { title: c.title } : {}), ...(declared ? { targets: declared[i]!.targets } : {}) })),
    ...(declared ? { declared: true } : {}),
    plan,
    run: (sub, target) => runSuite(sub, { target }),
    detail: (report) => describe(report, { verbose: true, headline: false }),
    verbose: !!ctx.flags.verbose,
    brief: !!ctx.flags.brief && !ctx.flags.verbose,
    progressFile: out ? path.join(path.resolve(out), PROGRESS_FILE) : path.join(ctx.root, '.lynkeus', `last-run.${PROGRESS_FILE}`),
    jsonProgress: ctx.flags.progress === 'json' && !ctx.attached,
  });
};

export const caseCommands = [
  define({
    name: 'case run',
    group: 'runs',
    summary: 'Run cases: setup through fixtures, steps against the app, the evidence when one fails',
    details:
      "A case is a markdown file with `setup`, `steps` and `expected` (`lynkeus case init` writes an example and the reference). Without files, every case in `cases.dir`. A failed case runs once more before it counts as failed, unless `--once`. `--host` hosts the app in Node for the run. `--on targets` runs each case on the targets the project declared (`cases.targets` in lynkeus.config.json, or the case's own `targets:`) at once and answers one line per case per target: that is how a case is checked done, and a declared target this machine lacks leaves the check incomplete (named with why, and the run fails). `--on all` runs them on every target this machine has (the app on the iOS Simulator, the app on the Android emulator, FastSim for each platform, headless); a target it lacks is named with why and fails nothing. The iOS and Android apps both dial the driver's port and each is driven on its own connection, so both run side by side without a rebuild; `simulator` is whichever device's app is attached.",
    positionals: [{ name: 'files', help: 'case files (default: every .md under cases.dir)', rest: true }],
    flags: {
      on: {
        type: 'string',
        help: "run the cases on several targets at once: targets (each case's declared ones, cases.targets; a missing one makes the check incomplete), all (every one this machine has; a missing one is said, not failed), or names, comma-separated: headless, fastsim:ios, fastsim:android, ios (the app on the iOS Simulator or an iPhone), android (the app on the Android emulator or a phone), fastsim (the last bundle), simulator (whichever device app is attached; emulator and device are the same)",
        value: 'targets',
      },
      bundle: {
        type: 'string',
        help: "with --on and a FastSim target: the folder fastsim-bundle made (default: the last one under .lynkeus of the target's platform)",
        value: 'dir',
      },
      host: { type: 'boolean', help: 'start `headless start` for the run (one per job with --jobs), each on a free driver port of its own, and stop it after' },
      'host-heap': {
        type: 'number',
        help: 'with --host or --keep-hosts: start a host again before a case when its heap is past this percent of its limit',
        value: 'percent',
        default: 60,
      },
      seed: {
        type: 'string',
        help: 'make the random values of the cases repeatable, and tell a host the run starts (default: launch.seed, LYNKEUS_SEED)',
        value: 'text',
      },
      locale: {
        type: 'string',
        help: 'the language tag a host the run starts launches with, as in es-AR (default: launch.locale, LYNKEUS_LOCALE)',
        value: 'tag',
      },
      'time-zone': {
        type: 'string',
        help: 'the IANA time zone a host the run starts launches with, as in Europe/Madrid (default: launch.timeZone, LYNKEUS_TIME_ZONE)',
        value: 'zone',
      },
      epoch: {
        type: 'string',
        help: 'the instant the app’s clock starts at on a host the run starts, ISO 8601 or milliseconds (default: launch.epoch, LYNKEUS_EPOCH)',
        value: 'iso',
      },
      once: { type: 'boolean', help: 'no second chance for a case that fails' },
      continue: { type: 'boolean', help: "keep running a case's steps after one fails (a failed setup still stops it)" },
      seen: {
        type: 'string',
        help: 'where to write <case id>.json with the screens each passing case went through, step by step, for `case coverage` and `case new` (default .lynkeus/seen)',
        value: 'dir',
      },
      report: { type: 'string', help: 'append one JSON line per case', value: 'file' },
      events: { type: 'string', help: 'keep what the app told its analytics, per case, as <dir>/<case id>/events.jsonl', value: 'dir' },
      out: { type: 'string', help: 'write the run as a directory a report can read: run.json and cases.jsonl, a line per attempt', value: 'dir' },
      'no-app-events': {
        type: 'boolean',
        help: "with --out: leave the app's own event list unread. Reading it can turn on the app's tracking debug, which may draw on the screen; frames two runs compare should not have it",
      },
      screenshots: { type: 'boolean', help: 'with --out: a frame of the screen after every step of the app' },
      settle: {
        type: 'number',
        help: 'with --screenshots: how long the screen must stay still before a frame, in ms; 700 for frames two runs can be compared by',
        default: 150,
        value: 'ms',
      },
      'frames-on-change': {
        type: 'boolean',
        help: 'with --screenshots: a step that only looks (app.see, app.wait) on an unchanged screen shares the last frame',
      },
      still: {
        type: 'number',
        help: 'with --screenshots, on a simulator or emulator: take each frame again until two in a row match, this many ms apart (a native transition the agent cannot see)',
        value: 'ms',
      },
      frames: {
        type: 'string',
        help: "with --screenshots: avif, the default and a few percent of the bytes (a simulator's or emulator's PNG is encoded again), or png, exact, only for frames two runs are compared by pixel for pixel",
        default: 'avif',
        value: 'avif|png',
      },
      video: {
        type: 'boolean',
        help: 'with --out: film each case: a host that films, a Simulator (simctl) or an emulator (screenrecord); each step says at what second it began',
      },
      traces: {
        type: 'boolean',
        help: 'listen for the backend’s OpenTelemetry traces (OTLP over HTTP) and keep, under each step, what the backend did for it; point the backend’s OTEL_EXPORTER_OTLP_ENDPOINT at http://localhost:<traces-port>',
      },
      'traces-port': { type: 'number', help: 'where --traces listens', default: 4318, value: 'port' },
      push: {
        type: 'boolean',
        help: 'with --out: upload the run to the reports service and print the report’s address; the report is made when the run starts and fills case by case',
      },
      project: { type: 'string', help: 'with --push: the project the run is filed under (default: the app’s folder name)', value: 'name' },
      'video-fps': { type: 'number', help: 'frames per second of the film', default: 30, value: 'n' },
      'video-scale': { type: 'number', help: 'pixels per point of the film, where the host takes one (FastSim: 1 to 3, 2 unless told)', value: 'n' },
      flakes: { type: 'string', help: 'the ledger of how each case did across runs (default .lynkeus/flakes.json)', value: 'file' },
      prepared: { type: 'string', help: 'where `case prepare` leaves setups made ahead; a case found there skips its setup', value: 'dir' },
      jobs: { type: 'number', help: 'cases at once, each on its own host', value: 'n', default: 1 },
      ports: { type: 'string', help: 'the driver port of each job, comma-separated: where its host dials in (default: free ones)', value: 'list' },
      'host-command': {
        type: 'string',
        help: 'starts a fresh host for every case and stops it after; {port} is where the host dials, {job} the job',
        value: 'command',
      },
      'keep-hosts': {
        type: 'boolean',
        help: 'with --host-command: start each job’s host once and keep it for the job’s cases, starting it again when it exits, its app stops answering or its heap passes --host-heap percent',
      },
      'host-timeout': { type: 'number', help: 'with --keep-hosts: how long a host may take to attach (it builds the app first)', default: 600000, value: 'ms' },
      'in-order': { type: 'boolean', help: 'with --jobs: take the cases in the order given, not the longest first' },
      ahead: { type: 'number', help: 'make up to this many setups ahead of their cases while others run (0: none)', value: 'n', default: 0 },
      idle: { type: 'number', help: 'with --ahead: start a setup only while this share of the CPU is idle', value: 'share', default: 0.25 },
      'dry-run': { type: 'boolean', help: 'parse and list the steps without running them' },
      brief: {
        type: 'boolean',
        help: "with --on: only the cases that did not pass, each target's count and notes cut to a line (a suite on several targets)",
      },
      verbose: {
        type: 'boolean',
        help: 'a failed case with its whole screen, every request and its full error; without it the screen is cut to what a check can name, and a notice the last run gave is not repeated',
      },
      progress: {
        type: 'string',
        help: `how the run says where it is, besides <out>/${PROGRESS_FILE} (\`case status\` reads it): json, one event per line on stdout (the summary then goes to stderr); none, no live status line in a terminal`,
        value: 'json|none',
      },
    },
    needs: 'nothing',
    session: false,
    mcp: 'core',
    mcpOmit: [
      'progress',
      'seen',
      'report',
      'events',
      'frames-on-change',
      'traces-port',
      'video-fps',
      'video-scale',
      'flakes',
      'prepared',
      'ahead',
      'idle',
      'continue',
      'project',
    ],
    mcpDetails:
      "Runs case files (default: all in cases.dir) against the attached app, or with `host` in Node. A case that fails comes back with its screen and reason. `on: targets` runs each case on the project's declared targets (cases.targets, or the case's own `targets:`) at once and answers one line per case per target (`brief`: only the cases that did not pass, and each target's count); a declared target not available here leaves the check incomplete and fails the run. `on: all` runs them on every target this machine has, and one not available is named and fails nothing; or name them: headless, fastsim:ios, fastsim:android, ios, android (`bundle`: the FastSim bundle, default the last under .lynkeus). `out` + `screenshots` + `push` uploads the run and prints its address; the report fills case by case from the first. For frames two runs are compared by pixel for pixel, add `frames: \"png\"`, `settle: 700` and, on a simulator or emulator, `still: 300`. `jobs` runs cases side by side, each on its own host (`ports`; `host` starts one headless host per job, `host_command` one per case); a case with `exclusive: true` in its frontmatter runs alone. With `host`, a host that dies or passes `host_heap` percent of its heap is started again before the next case. A headless host that serves several cases (`host`, or `keep_hosts` with a headless `host_command`) is reset before each case after its first (mocked storage, network rules, clock, a new tree); what the app keeps at module scope survives, and such an app wants `host_command` without `keep_hosts`, a host per case. `seed`, `locale`, `time_zone` and `epoch` pin the launch facts on a host the run starts (`host` or `host_command`); an attached simulator or emulator keeps its own, listed under `launch.unsupported` in run.json (guide determinism launch-facts). On FastSim and headless the answer lists the native values the app read that the host does not know, each with a `nativeMocks` snippet to fill from the library's native code (guide troubleshooting native-values).",
    run: async (ctx) => {
      if (typeof ctx.flags.on === 'string' && !ctx.flags['dry-run']) return casesOnTargets(ctx);
      const { reports: _reports, notes: _notes, ...result } = await runSuite(ctx);
      return result;
    },
  }),
  define({
    name: 'case status',
    group: 'runs',
    summary: 'Where a run of cases is: how many are done, what each job is running and in which section, and the time left',
    details: `Reads ${PROGRESS_FILE}, which \`case run\` writes as it goes: in the run directory given (its --out), or the last run of this project. It works while the run goes on, from another terminal or an MCP client, and after it: a run whose process is gone without finishing says so. The time left comes from how long each case took when it last passed, else from the run's own cases. --json gives the same as an object.`,
    positionals: [{ name: 'dir', help: `the run directory (case run --out), or its ${PROGRESS_FILE}; default: the last run here` }],
    needs: 'nothing',
    session: false,
    mcp: 'core',
    mcpDetails: `Where a case run stands: cases done, what each job runs and in which section, failures so far and the time left. Give the run's out directory, or nothing for the project's last run. Call it while case_run runs (from here or from a terminal) to follow a long suite.`,
    run: async (ctx) => {
      const given = ctx.args[0];
      let file: string | undefined;
      if (given) {
        const full = path.resolve(given);
        file = fs.existsSync(full) && fs.statSync(full).isDirectory() ? path.join(full, PROGRESS_FILE) : full;
      } else {
        try {
          file = (JSON.parse(fs.readFileSync(lastRunFile(ctx.root), 'utf8')) as { progress?: string }).progress;
        } catch {
          file = undefined;
        }
      }
      if (!file || !fs.existsSync(file))
        return {
          text: given
            ? `no ${PROGRESS_FILE} at ${given}: is it a directory \`case run --out\` wrote?`
            : 'no run here yet: `case run` keeps where it is as it goes',
          code: 1,
        };
      const status = statusOf(file);
      const text = describeStatus(status, file);
      return { text: status.state === 'running' ? `${text}\nto stop it: \`lynkeus case stop\` (case_stop over MCP)` : text, json: status };
    },
  }),
  define({
    name: 'case stop',
    group: 'runs',
    summary: 'Stop a case run that is going: no step starts after the current one, the hosts it started stop and its ports are let go',
    details: `Without a directory: every run of this Lynkeus (an MCP server or a session) at once, else the last run of this project, from any process. A run in another process stops when it next looks (within a second); this waits for it to say so. A run stopped this way ends with what it ran, and \`case status\` says it was stopped.`,
    positionals: [
      { name: 'dir', help: `the run directory (case run --out), or its ${PROGRESS_FILE}; default: the runs of this Lynkeus, else the last run here` },
    ],
    needs: 'nothing',
    session: false,
    mcp: 'core',
    mcpDetails:
      "Stops a case_run that is still going (one a client moved to the background, or another from a terminal): no step starts after the current one, the hosts it started stop and its port is let go. Give the run's out directory, or nothing for the runs of this server, else the project's last run.",
    run: async (ctx) => {
      const given = ctx.args[0];
      const progressOf = (dir: string) => {
        const full = path.resolve(dir);
        return fs.existsSync(full) && fs.statSync(full).isDirectory() ? path.join(full, PROGRESS_FILE) : full;
      };
      const wanted = given ? progressOf(given) : undefined;
      const here = [...active].filter((r) => !wanted || r.progress === wanted);
      if (here.length > 0) {
        for (const r of here) r.stop('stopped with case stop');
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([Promise.all(here.map((r) => r.done)), new Promise((resolve) => (timer = setTimeout(resolve, 10_000)))]);
        clearTimeout(timer);
        return here.map((r) => `stopped: ${r.label}`).join('\n');
      }
      let file = wanted;
      let stopFile: string | undefined;
      if (!file) {
        try {
          const last = JSON.parse(fs.readFileSync(lastRunFile(ctx.root), 'utf8')) as { progress?: string; stop?: string };
          file = last.progress;
          stopFile = last.stop;
        } catch {
          file = undefined;
        }
      }
      if (!file || !fs.existsSync(file))
        return { text: given ? `no ${PROGRESS_FILE} at ${given}: is it a directory \`case run --out\` wrote?` : 'no run here to stop', code: 1 };
      const before = statusOf(file);
      if (before.state !== 'running') return { text: `nothing to stop: the last run is ${describeStatus(before).split('\n')[0]}` };
      fs.writeFileSync(stopFile ?? `${file}.stop`, '');
      const until = Date.now() + 10_000;
      while (Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, STOP_POLL_MS));
        const now = statusOf(file);
        if (now.state !== 'running') return describeStatus(now, file);
      }
      return {
        text: `asked the run (pid ${before.pid ?? '?'}) to stop, and it has not said it did: a Lynkeus before case stop does not look for it; end that process instead`,
        code: 1,
      };
    },
  }),
  define({
    name: 'case prepare',
    group: 'runs',
    summary: 'Run the setup of cases ahead of them, so each starts at its first step',
    details:
      'For a suite that starts `case run --prepared <dir>` once per case: start this first, with the same cases in the order they will run, and leave it running. It runs every setup made only of the project fixtures and leaves what each produced in <dir>; a case that starts before its setup is ready runs its own, and this skips it. It asks the fixtures server for a lower priority (`lynkeus.ahead`), so it takes what the running cases leave of the machine.',
    positionals: [{ name: 'files', help: 'case files, in the order they will run (default: every .md under cases.dir)', rest: true }],
    flags: {
      prepared: { type: 'string', help: 'where to leave the setups (emptied first)', value: 'dir', default: '.lynkeus/prepared' },
      jobs: { type: 'number', help: 'setups made at once', value: 'n', default: 1 },
      ahead: { type: 'number', help: 'setups kept ready and not yet taken, at most', value: 'n', default: 4 },
      idle: { type: 'number', help: 'start a setup only while at least this share of the CPU is idle (0 to 1)', value: 'share', default: 0.25 },
    },
    needs: 'nothing',
    session: false,
    mcp: false,
    run: async (ctx) => {
      const config = ctx.config.cases ?? {};
      if (!config.fixtures) return { text: 'the project declares no fixtures (cases.fixtures in lynkeus.config.json): nothing to prepare', code: 1 };
      const declared = config.fixtures;
      const home = config.base ?? ctx.root;
      const files = caseFiles(ctx.args, home, config.dir);
      if (typeof files === 'string') return { text: files, code: 1 };
      const cases = files.flatMap(readCases).filter((c) => preparable(c, config));
      const probe = new Fixtures(declared, home);
      const described = await probe.describe().finally(() => probe.close());
      if (described?.down) return { text: `the fixtures server cannot serve: ${described.down}`, code: 1 };
      const store = new Ahead(path.resolve(ctx.root, String(ctx.flags.prepared ?? '.lynkeus/prepared')));
      store.clear();
      const { made, skipped } = await prepareAhead(cases, {
        base: ctx,
        config,
        store,
        open: () => new Fixtures(declared, home),
        limit: Math.max(1, Number(ctx.flags.ahead ?? 4)),
        idle: Number(ctx.flags.idle ?? 0.25),
        jobs: Number(ctx.flags.jobs ?? 1),
      });
      return { text: `${made} setups made ahead, ${skipped} cases had started first`, json: { made, skipped } };
    },
  }),
  define({
    name: 'case init',
    group: 'runs',
    summary: 'Write an example case, the reference of the format and a fixtures server to start from',
    flags: { force: { type: 'boolean', help: 'overwrite what is there' } },
    needs: 'nothing',
    session: false,
    mcp: 'core',
    run: async (ctx) => {
      const dir = path.resolve(ctx.root, ctx.config.cases?.dir ?? 'cases');
      fs.mkdirSync(dir, { recursive: true });
      const notes: string[] = [];
      const write = (file: string, content: string) => {
        if (fs.existsSync(file) && !ctx.flags.force) return notes.push(`kept ${path.relative(ctx.root, file)}`);
        fs.writeFileSync(file, content);
        notes.push(`wrote ${path.relative(ctx.root, file)}`);
      };
      write(path.join(dir, 'example.md'), EXAMPLE_CASE);
      write(path.join(dir, 'README.md'), FORMAT);
      write(path.join(dir, 'fixtures.mjs'), FIXTURES);
      const file = configFile(ctx.root);
      // `lynkeus init` may have written `cases.targets` alone: that is not a cases setup to keep.
      const setUp = Object.keys(ctx.config.cases ?? {}).some((k) => k !== 'targets' && k !== 'base');
      if (setUp && !ctx.flags.force) notes.push('kept cases in lynkeus.config.json');
      else {
        const current = fs.existsSync(file) ? readJson<Record<string, unknown>>(file) : {};
        const targets = (current.cases as { targets?: unknown } | undefined)?.targets;
        writeJson(file, { ...current, cases: { ...CONFIG, dir: path.relative(ctx.root, dir), ...(targets !== undefined ? { targets } : {}) } });
        notes.push('added cases to lynkeus.config.json');
      }
      notes.push('next: `lynkeus case run cases/example.md --dry-run`, then make fixtures.mjs talk to your backend');
      return { text: notes.join('\n'), json: { dir } };
    },
  }),
];

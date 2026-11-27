/**
 * `setup`: from a fresh app to an app attached on each platform asked for, in one call. It does what connecting took
 * an agent dozens of shell calls: init, the device, Metro, the development build, the launch, the wait for the app
 * to dial in, then status. Each step that is already done is said and skipped, so it is safe to run again. The answer
 * is a few lines; the build and Metro logs, init's and status's whole answers stay in files under .lynkeus/runs/setup.
 */
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { HelloEvent } from 'lynkeus-protocol';

import { declaredTargets } from '../cases/onTargets.js';
import { DEFAULT_PORT, portFromEnv, runsDir } from '../config.js';
import { appIdsOf } from '../device/devMenu.js';
import { type DeviceInfo, parseAdbDevices } from '../device/devices.js';
import { iosLaunchArgv } from '../device/launchArgs.js';
import { type Ctx, define } from '../registry.js';
import { execute, onPhone } from '../runtime.js';
import { type BuildDevice, runtimeAt } from '../runtimes/index.js';
import { appPlatforms, type Platform } from './runTargets.js';

export type Ran = { code: number; stdout: string };

/** What setup does to the machine, behind one seam so a test can answer for it and check what it would have run. */
export type SetupDeps = {
  /** A short command, to its end; code 127 when the program is not there. */
  exec: (command: string, args: string[], o?: { cwd?: string; timeoutMs?: number }) => Promise<Ran>;
  /** A long command (a build), its output appended to `log`, each line told to `line`; its exit code. */
  stream: (command: string, args: string[], o: { cwd: string; log: string; line: (text: string) => void; signal?: AbortSignal }) => Promise<number>;
  /** A command that outlives setup (Metro, an emulator), its output to `log`; its pid. */
  detach: (command: string, args: string[], o: { cwd: string; log: string }) => number | undefined;
  /** Whether Metro answers on this port. */
  metroUp: (port: number) => Promise<boolean>;
  /** The app of this platform, once it dials the driver, within `timeoutMs`; undefined when none did. */
  attach: (platform: Platform, timeoutMs: number) => Promise<HelloEvent | undefined>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

export type StepLine = { step: string; ok: boolean; text: string; tail?: string[]; log?: string };

// Build tools color their output even into a file.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g');
// The lines of a build log that say why it failed, in the words Xcode, Gradle, Expo and the React Native CLI use.
const RELEVANT = /error|failed|failure|fatal|exception|what went wrong|commanderror|cannot|could not|not found|✖|❌/i;
const TAIL = 15;

/** The last lines of a log that say why it failed (the last lines at all when none says so), at most 15. */
export const relevantTail = (text: string, max = TAIL): string[] => {
  const lines = text
    .replace(ANSI, '')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim());
  const said = lines.filter((l) => RELEVANT.test(l));
  return (said.length ? said : lines).slice(-max).map((l) => (l.length > 200 ? `${l.slice(0, 199)}…` : l));
};

const readTail = (file: string): string[] => {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return relevantTail(text.slice(-200_000));
  } catch {
    return [];
  }
};

/**
 * The platforms setup builds for when none is asked: the device platforms `cases.targets` names, else the app's
 * platforms; iOS only on a Mac. What the app does not build for is left out either way.
 */
export const platformsFor = (o: { asked?: string[]; declared?: readonly string[]; app: readonly Platform[]; mac: boolean }): Platform[] | string => {
  if (o.asked?.length) {
    const wrong = o.asked.filter((p) => p !== 'ios' && p !== 'android');
    if (wrong.length) return `platform is ios or android, not ${wrong.join(', ')}`;
    if (!o.mac && o.asked.includes('ios')) return 'an iOS development build needs a Mac with Xcode';
    return [...new Set(o.asked as Platform[])];
  }
  const fromTargets = (o.declared ?? []).flatMap((t): Platform[] => (t === 'ios' || t === 'android' ? [t] : t === 'simulator' ? [...o.app] : []));
  const wanted = o.declared ? fromTargets : [...o.app];
  return [...new Set(wanted)].filter((p) => o.app.includes(p) && (p === 'android' || o.mac));
};

type Simulator = { id: string; name: string; booted: boolean };

const parseSimulators = (stdout: string): Simulator[] => {
  try {
    const parsed = JSON.parse(stdout) as { devices: Record<string, { udid: string; name: string; state: string; isAvailable?: boolean }[]> };
    return Object.values(parsed.devices)
      .flat()
      .filter((d) => d.isAvailable !== false)
      .map((d) => ({ id: d.udid, name: d.name, booted: d.state === 'Booted' }));
  } catch {
    return [];
  }
};

/** The Android emulator's binary: the SDK's, where ANDROID_HOME or the default SDK folder has it, else the PATH's. */
export const emulatorBinary = (env: NodeJS.ProcessEnv = process.env, exists: (file: string) => boolean = fs.existsSync): string => {
  const sdks = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, path.join(os.homedir(), 'Library', 'Android', 'sdk'), path.join(os.homedir(), 'Android', 'Sdk')];
  for (const sdk of sdks) if (sdk && exists(path.join(sdk, 'emulator', 'emulator'))) return path.join(sdk, 'emulator', 'emulator');
  return 'emulator';
};

type Picked = { device: BuildDevice; booted?: string } | { failed: string };

/**
 * The iOS Simulator to build for: the one asked for (flag or the config's `device`), booted, else the first booted one.
 * One that is asked for and not booted is booted, and said; none is booted that nobody named.
 */
export const pickSimulator = async (deps: SetupDeps, wanted: string | undefined): Promise<Picked> => {
  const listed = await deps.exec('xcrun', ['simctl', 'list', 'devices', 'available', '-j']);
  if (listed.code !== 0) return { failed: 'xcrun simctl answered nothing: an iOS build needs Xcode and its command line tools' };
  const all = parseSimulators(listed.stdout);
  const matches = (s: Simulator) => !!wanted && (s.id === wanted || s.name === wanted);
  const booted = all.filter((s) => s.booted);
  const asked = all.filter(matches);
  const pick = (s: Simulator): BuildDevice => ({ platform: 'ios', id: s.id, name: s.name, type: 'simulator', only: booted.length <= 1 });
  if (wanted && asked.length === 0)
    return {
      failed: `no iOS Simulator named ${wanted} (lynkeus.config.json "device" or the device argument); \`xcrun simctl list devices available\` lists them`,
    };
  const already = asked.find((s) => s.booted) ?? (wanted ? undefined : booted[0]);
  if (already) return { device: pick(already) };
  if (!wanted)
    return {
      failed:
        'no iOS Simulator is booted, and the project names none to boot: boot one, or set "device" in lynkeus.config.json to a Simulator\'s name or udid (setup boots that one)',
    };
  const target = asked[0]!;
  const boot = await deps.exec('xcrun', ['simctl', 'boot', target.id]);
  if (boot.code !== 0) return { failed: `xcrun simctl boot ${target.id} failed: ${boot.stdout.trim().split('\n').at(-1) ?? ''}` };
  await deps.exec('open', ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', target.id]);
  return { device: { ...pick(target), only: true }, booted: `xcrun simctl shutdown ${target.id}` };
};

const avdName = async (deps: SetupDeps, serial: string): Promise<string | undefined> => {
  if (!serial.startsWith('emulator-')) return undefined;
  const said = await deps.exec('adb', ['-s', serial, 'emu', 'avd', 'name'], { timeoutMs: 5000 });
  return said.code === 0 ? said.stdout.split('\n')[0]?.trim() || undefined : undefined;
};

/**
 * The Android device to build for: the one asked for (an adb serial or an emulator's AVD name) among those up, else
 * the first one up. With none up, the AVD the project names (`avd` in lynkeus.config.json, or the device argument) is
 * started, and said; none is started that nobody named, and none is ever wiped.
 */
export const pickAndroid = async (deps: SetupDeps, o: { wanted?: string; avd?: string; logDir: string; timeoutMs?: number }): Promise<Picked> => {
  const { wanted, avd, timeoutMs = 180_000 } = o;
  const listed = await deps.exec('adb', ['devices']);
  if (listed.code === 127) return { failed: 'no adb on the PATH: an Android build needs the Android SDK platform tools' };
  const up = parseAdbDevices(listed.stdout);
  const named = await Promise.all(up.map(async (d) => ({ ...d, avd: await avdName(deps, d.id) })));
  const toDevice = (d: DeviceInfo & { avd?: string }, only: boolean): BuildDevice => ({
    platform: 'android',
    id: d.id,
    name: d.avd ?? d.name,
    type: d.type === 'physical' ? 'physical' : 'emulator',
    ...(d.avd ? { avd: d.avd } : {}),
    only,
  });
  const ask = wanted ?? avd;
  const asked = ask ? named.find((d) => d.id === ask || d.avd === ask) : undefined;
  if (asked) return { device: toDevice(asked, named.length === 1) };
  if (named.length > 0 && !wanted) return { device: toDevice(named[0]!, named.length === 1) };
  const start = wanted ?? avd;
  const avds = await deps.exec(emulatorBinary(), ['-list-avds']);
  const known =
    avds.code === 0
      ? avds.stdout
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('INFO'))
      : [];
  if (!start)
    return {
      failed: `no Android emulator or phone is up, and the project names no AVD to start: start one, or set "avd" in lynkeus.config.json (setup starts that one)${known.length ? `; AVDs here: ${known.join(', ')}` : ''}`,
    };
  if (!known.includes(start)) return { failed: `no device or AVD named ${start} is up or known here${known.length ? `; AVDs here: ${known.join(', ')}` : ''}` };
  const log = path.join(o.logDir, `emulator-${start}.log`);
  deps.detach(emulatorBinary(), ['-avd', start], { cwd: os.homedir(), log });
  const until = deps.now() + timeoutMs;
  while (deps.now() < until) {
    await deps.sleep(2000);
    const now = parseAdbDevices((await deps.exec('adb', ['devices'])).stdout).filter((d) => d.type === 'emulator' && !up.some((u) => u.id === d.id));
    for (const d of now) {
      if ((await avdName(deps, d.id)) !== start) continue;
      const boot = await deps.exec('adb', ['-s', d.id, 'shell', 'getprop', 'sys.boot_completed'], { timeoutMs: 5000 });
      if (boot.stdout.trim() === '1') return { device: toDevice({ ...d, avd: start }, up.length === 0), booted: `adb -s ${d.id} emu kill` };
    }
  }
  return { failed: `started AVD ${start}, and it did not finish booting within ${Math.round(timeoutMs / 1000)} s (log ${log})` };
};

export const setupDir = (root: string) => path.join(runsDir(root), 'setup');

/** What a development build depends on: a build made from the same is not made again. */
export const buildKey = (root: string, device: BuildDevice): string => {
  const read = (file: string) => {
    try {
      return fs.readFileSync(path.join(root, file), 'utf8');
    } catch {
      return '';
    }
  };
  const manifest = (() => {
    try {
      const m = JSON.parse(read('package.json')) as { dependencies?: unknown; devDependencies?: unknown };
      return JSON.stringify([m.dependencies ?? {}, m.devDependencies ?? {}]);
    } catch {
      return '';
    }
  })();
  return createHash('sha256')
    .update([device.platform, device.id, manifest, read('app.json'), read('.env.local')].join('\0'))
    .digest('hex')
    .slice(0, 16);
};

const installed = async (deps: SetupDeps, device: BuildDevice, appId: string | undefined): Promise<boolean> => {
  if (!appId) return false;
  const said =
    device.platform === 'ios'
      ? await deps.exec('xcrun', ['simctl', 'get_app_container', device.id, appId])
      : await deps.exec('adb', ['-s', device.id, 'shell', 'pm', 'path', appId]);
  return said.code === 0 && (device.platform === 'ios' || said.stdout.includes('package:'));
};

const launch = async (deps: SetupDeps, device: BuildDevice, appId: string, metroPort: number): Promise<Ran> => {
  if (device.platform === 'ios') return deps.exec('xcrun', iosLaunchArgv(device.id, appId, true));
  // The app reaches Metro and the driver at its own localhost on a phone; an emulator reaches them either way.
  await deps.exec('adb', ['-s', device.id, 'reverse', `tcp:${metroPort}`, `tcp:${metroPort}`]);
  await deps.exec('adb', ['-s', device.id, 'shell', 'am', 'force-stop', appId]);
  return deps.exec('adb', ['-s', device.id, 'shell', 'monkey', '-p', appId, '-c', 'android.intent.category.LAUNCHER', '1']);
};

const seconds = (ms: number) =>
  ms >= 90_000 ? `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s` : `${Math.round(ms / 1000)} s`;
const rel = (root: string, file: string) => path.relative(root, file) || file;

export type SetupOptions = {
  platforms?: string[];
  device?: string;
  rebuild?: boolean;
  /** How long a fresh build's app may take to dial in (its first bundle). */
  attachMs?: number;
};

/** The whole job: the lines it answers with, and whether every step went through. */
export const runSetup = async (ctx: Ctx, o: SetupOptions, deps: SetupDeps): Promise<{ lines: StepLine[]; ok: boolean; booted: string[] }> => {
  const dir = setupDir(ctx.root);
  fs.mkdirSync(dir, { recursive: true });
  const lines: StepLine[] = [];
  const booted: string[] = [];
  const say = (text: string) => (ctx.notify ? ctx.notify(text) : ctx.err(text));
  const done = (step: string, text: string) => {
    lines.push({ step, ok: true, text });
    say(`✓ ${step}: ${text}`);
  };
  const fail = (step: string, text: string, log?: string) => {
    const tail = log ? readTail(log) : undefined;
    lines.push({ step, ok: false, text, ...(tail?.length ? { tail } : {}), ...(log ? { log: rel(ctx.root, log) } : {}) });
    say(`✗ ${step}: ${text}`);
    return { lines, ok: false, booted };
  };

  const runtime = await runtimeAt(ctx.root);
  const before = runtime.setupChecks(ctx.root);
  let changed = false;
  if (before.every((c) => c.ok)) done('init', 'already set up');
  else {
    say('init: installing lynkeus-agent and mounting it');
    const r = await execute(['init'], ctx);
    const said = r.error ?? r.text ?? '';
    const file = path.join(dir, 'init.txt');
    fs.writeFileSync(file, said);
    const still = runtime.setupChecks(ctx.root).filter((c) => !c.ok);
    if (r.error || still.length)
      return fail('init', `${still.map((c) => `${c.what}${c.fix ? ` (${c.fix})` : ''}`).join('; ') || r.error} — init said: ${rel(ctx.root, file)}`);
    changed = true;
    done(
      'init',
      `set up ${before
        .filter((c) => !c.ok)
        .map((c) => c.what)
        .join(', ')} (${rel(ctx.root, file)})`,
    );
  }

  const declared = declaredTargets({}, ctx.config.cases?.targets);
  const platforms = platformsFor({
    asked: o.platforms,
    declared: Array.isArray(declared) ? declared : undefined,
    app: appPlatforms(ctx.root),
    mac: process.platform === 'darwin',
  });
  if (typeof platforms === 'string') return fail('platforms', platforms);
  if (o.device && platforms.length > 1) return fail('platforms', `device names one device: pass one platform with it (${platforms.join(' or ')})`);
  if (platforms.length === 0) {
    done('platforms', 'none to build: cases.targets names no ios or android (pass platform to build one)');
    return { lines, ok: true, booted };
  }
  if (!runtime.devBuild || !runtime.bundler) return fail('build', `setup cannot build a ${runtime.id} app yet: build and open it yourself, then call status`);

  const appIds = appIdsOf(ctx.root, ctx.config.app);
  const metroPort = Number(process.env.RCT_METRO_PORT ?? 8081);
  const driverPort = portFromEnv(ctx.config) ?? DEFAULT_PORT;
  let metroChecked = false;
  const ensureMetro = async (): Promise<boolean> => {
    if (metroChecked) return true;
    metroChecked = true;
    const pidFile = path.join(dir, 'metro.pid');
    if (await deps.metroUp(metroPort)) {
      if (!changed) {
        done('metro', `already running on port ${metroPort}`);
        return true;
      }
      // Metro reads .env files and the babel config once, at its start: one started before init never hands the app its token.
      const ours = Number(fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8') : NaN);
      if (!ours) {
        fail(
          'metro',
          `Metro was already running on port ${metroPort} before init changed the app: stop it, then call setup again (it starts Metro with a clean cache)`,
        );
        return false;
      }
      try {
        process.kill(-ours);
      } catch {
        // already gone
      }
      await deps.sleep(1000);
    }
    const log = path.join(dir, 'metro.log');
    const argv = runtime.bundler!(ctx.root, { port: metroPort, resetCache: changed });
    say(`metro: ${argv.join(' ')}`);
    const pid = deps.detach(argv[0]!, argv.slice(1), { cwd: ctx.root, log });
    if (pid) fs.writeFileSync(pidFile, String(pid));
    const until = deps.now() + 90_000;
    while (deps.now() < until) {
      if (await deps.metroUp(metroPort)) {
        done('metro', `started (${argv.join(' ')}; log ${rel(ctx.root, log)})`);
        return true;
      }
      await deps.sleep(1000);
    }
    fail('metro', `\`${argv.join(' ')}\` did not answer on port ${metroPort} within 90 s`, log);
    return false;
  };

  for (const platform of platforms) {
    // The config's `device` may name the emulator a run drives (an adb serial): that one is no Simulator to look for.
    const configured = ctx.config.device && !/^emulator-\d+$/.test(ctx.config.device) ? ctx.config.device : undefined;
    const wanted = o.device ?? (platform === 'ios' ? configured : undefined);
    say(`${platform} device: looking`);
    const picked = platform === 'ios' ? await pickSimulator(deps, wanted) : await pickAndroid(deps, { wanted: o.device, avd: ctx.config.avd, logDir: dir });
    if ('failed' in picked) return fail(`${platform} device`, picked.failed);
    const device = picked.device;
    if (picked.booted) {
      booted.push(picked.booted);
      done(`${platform} device`, `${device.name} (${device.id}), booted by setup: shut it down when done (${picked.booted})`);
    } else done(`${platform} device`, `${device.name} (${device.id}), already up`);

    const appId = appIds[platform];
    const attached = async (ms: number) => {
      say(`${platform}: waiting for the app to attach on port ${driverPort}`);
      return deps.attach(platform, ms);
    };
    const said = (hello: HelloEvent) =>
      `${String(hello.app?.name ?? hello.appId ?? platform)}${hello.agentVersion ? ` (agent ${hello.agentVersion})` : ''} on port ${driverPort}`;

    // An app of this platform already dialing in has a build with the agent: nothing to build or launch.
    const already = changed || o.rebuild ? undefined : await deps.attach(platform, 3000);
    if (already) {
      done(`${platform} app`, `already attached: ${said(already)}`);
      continue;
    }
    if (!(await ensureMetro())) return { lines, ok: false, booted };

    const key = buildKey(ctx.root, device);
    const stampFile = path.join(dir, `build-${platform}.json`);
    const stamp = (() => {
      try {
        return (JSON.parse(fs.readFileSync(stampFile, 'utf8')) as { key?: string }).key;
      } catch {
        return undefined;
      }
    })();
    if (!o.rebuild && !changed && stamp === key && appId && (await installed(deps, device, appId))) {
      say(`${platform}: the build setup made is installed; launching it`);
      await launch(deps, device, appId, metroPort);
      const hello = await attached(60_000);
      if (hello) {
        done(`${platform} app`, `build already installed, launched, attached: ${said(hello)}`);
        continue;
      }
      say(`${platform}: the installed build did not attach; building again`);
    }

    const argv = runtime.devBuild(ctx.root, device);
    const log = path.join(dir, `build-${platform}.log`);
    fs.writeFileSync(log, '');
    say(`${platform} build: ${argv.join(' ')} (log ${rel(ctx.root, log)})`);
    const started = deps.now();
    let lastSaid = 0;
    const code = await deps.stream(argv[0]!, argv.slice(1), {
      cwd: ctx.root,
      log,
      signal: ctx.signal,
      line: (text) => {
        const clean = text.replace(ANSI, '').trim();
        if (!clean || deps.now() - lastSaid < 5000) return;
        lastSaid = deps.now();
        say(`${platform} build ${seconds(deps.now() - started)}: ${clean.slice(0, 160)}`);
      },
    });
    if (code !== 0) return fail(`${platform} build`, `\`${argv.join(' ')}\` exited ${code} after ${seconds(deps.now() - started)}`, log);
    fs.writeFileSync(stampFile, JSON.stringify({ key, at: new Date().toISOString(), device: device.id, command: argv }));
    done(`${platform} build`, `${argv.join(' ')}, ${seconds(deps.now() - started)} (log ${rel(ctx.root, log)})`);

    // The build opens the app; its first bundle can take a while. One that does not dial in is launched once more.
    let hello = await attached(o.attachMs ?? 120_000);
    if (!hello && appId) {
      say(`${platform}: no app attached after the build; launching it once more`);
      await launch(deps, device, appId, metroPort);
      hello = await attached(60_000);
    }
    if (!hello)
      return fail(
        `${platform} app`,
        `no ${platform} app attached on port ${driverPort} after the build${appId ? ' and a relaunch' : ''}: Metro's log says whether the bundle loaded`,
        path.join(dir, 'metro.log'),
      );
    done(`${platform} app`, `attached: ${said(hello)}`);
  }
  return { lines, ok: true, booted };
};

/** The answer: a line per step, a failure's last log lines and log path, status's gaps and its advice. */
export const setupText = (o: { lines: StepLine[]; status?: string; statusFile?: string }): string => {
  const out: string[] = [];
  for (const l of o.lines) {
    out.push(`${l.ok ? '✓' : '✗'} ${l.step}: ${l.text}`);
    if (l.tail?.length) out.push(...l.tail.map((t) => `    ${t}`));
    if (l.log && !l.ok) out.push(`    whole log: ${l.log}`);
  }
  if (o.status) {
    const status = o.status.split('\n');
    const gaps = status.filter((l) => l.startsWith('✗'));
    out.push(...gaps.slice(0, 4), ...(gaps.length > 4 ? [`  … ${gaps.length - 4} more`] : []));
    const advice = status.find((l) => l.startsWith('→'));
    if (advice) out.push(advice);
    if (o.statusFile) out.push(`status in full: ${o.statusFile}`);
  }
  return out.join('\n');
};

const execDefault: SetupDeps['exec'] = (command, args, o = {}) =>
  new Promise((resolve) => {
    execFile(command, args, { cwd: o.cwd, timeout: o.timeoutMs ?? 60_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? ((error as NodeJS.ErrnoException).code === 'ENOENT' ? 127 : typeof error.code === 'number' ? error.code : 1) : 0;
      resolve({ code, stdout: `${stdout}${code ? stderr : ''}` });
    });
  });

const streamDefault: SetupDeps['stream'] = (command, args, o) =>
  new Promise((resolve) => {
    const out = fs.openSync(o.log, 'a');
    // Its own process group, so a cancelled call stops the build tool and what it started (xcodebuild, gradle).
    const child = spawn(command, args, { cwd: o.cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: { ...process.env, CI: '1' } });
    let rest = '';
    const hear = (chunk: Buffer) => {
      fs.writeSync(out, chunk);
      rest += chunk.toString();
      const parts = rest.split('\n');
      rest = parts.pop() ?? '';
      for (const p of parts) o.line(p);
    };
    child.stdout.on('data', hear);
    child.stderr.on('data', hear);
    const stop = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGTERM');
      } catch {
        // gone
      }
    };
    o.signal?.addEventListener('abort', stop, { once: true });
    child.on('error', () => {
      fs.closeSync(out);
      resolve(127);
    });
    child.on('close', (code) => {
      o.signal?.removeEventListener('abort', stop);
      fs.closeSync(out);
      resolve(code ?? 1);
    });
  });

const detachDefault: SetupDeps['detach'] = (command, args, o) => {
  const out = fs.openSync(o.log, 'a');
  const child = spawn(command, args, { cwd: o.cwd, stdio: ['ignore', out, out], detached: true });
  child.on('error', () => undefined);
  child.unref();
  fs.closeSync(out);
  return child.pid;
};

const metroUpDefault = async (port: number): Promise<boolean> => {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(1500) });
    return (await r.text()).includes('packager-status:running');
  } catch {
    return false;
  }
};

/** The app of `platform` on a connection of its own, as `case run --on ios` takes it, asked until `timeoutMs`. */
const attachOn =
  (ctx: Ctx): SetupDeps['attach'] =>
  async (platform, timeoutMs) => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      // Each try waits as long as any attach does (attachTimeout, 15 s unless set), so a short wait still takes one.
      const scoped = ctx.forApp?.((hello) => hello.platform === platform && onPhone({ hello }), platform);
      const base = scoped?.base ?? ctx;
      try {
        const d = await base.device().catch(() => undefined);
        const hello = d ? (d.server.connected ? d.server.hello : await d.server.waitForApp(3000).catch(() => null)) : null;
        if (hello?.platform === platform) return hello;
      } finally {
        await scoped?.stop().catch(() => undefined);
      }
      if (ctx.signal?.aborted) return undefined;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return undefined;
  };

export const setupCommands = [
  define({
    name: 'setup',
    group: 'drive',
    summary: 'From a fresh app to an attached one, in one call: init, the device, Metro, the development build, launch, attach, status',
    details:
      "Does what connecting an app takes: `init` when the agent is not set up; for each platform (`--platform`, else the ios and android in cases.targets, else the app's), the device (a booted Simulator, a running emulator or phone; one the project names, `device` for a Simulator or `avd` for an emulator in lynkeus.config.json, is booted when none is up, and said); Metro, started with its own log when it is not running; the project's own build (`npx expo run:ios --no-bundler`, `npx react-native run-android --no-packager`), unless the build it made last is installed and attaches; the launch, and the wait for the app to attach; then `status`. Safe to run again: a step already done is said and skipped. The answer is a line per step; logs, init's and status's whole answers are in .lynkeus/runs/setup. A failed step answers with its last log lines and the log's path. It never wipes a device, and boots only one the project or `--device` names.",
    flags: {
      platform: { type: 'list', help: "ios, android or both (default: those in cases.targets, else the app's)", value: 'name' },
      device: { type: 'string', help: 'with one platform: Simulator name or udid, AVD name, or adb serial; one not up is booted', value: 'name' },
      rebuild: { type: 'boolean', help: 'build even when the last build is installed' },
    },
    needs: 'nothing',
    session: false,
    mcp: 'core',
    mcpDetails:
      "One call to connect the app: init if needed; per platform (default: cases.targets' ios/android) the device (a booted one, or the config's `device`/`avd`, booted and said), Metro, the dev build, launch, attach; then status. Re-runnable. Answers a line per step; logs in .lynkeus/runs/setup; a failure gives its last log lines.",
    run: async (ctx) => {
      const platforms = Array.isArray(ctx.flags.platform)
        ? (ctx.flags.platform as string[])
            .flatMap((p) => p.split(','))
            .map((p) => p.trim())
            .filter(Boolean)
        : undefined;
      const deps: SetupDeps = {
        exec: execDefault,
        stream: streamDefault,
        detach: detachDefault,
        metroUp: metroUpDefault,
        attach: attachOn(ctx),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        now: Date.now,
      };
      const result = await runSetup(
        ctx,
        { platforms, device: typeof ctx.flags.device === 'string' ? ctx.flags.device : undefined, rebuild: !!ctx.flags.rebuild },
        deps,
      );
      const dir = setupDir(ctx.root);
      let status: string | undefined;
      let statusFile: string | undefined;
      if (result.ok) {
        const r = await execute(['status'], ctx);
        status = r.text ?? r.error ?? '';
        statusFile = path.join(dir, 'status.txt');
        fs.writeFileSync(statusFile, status);
        statusFile = rel(ctx.root, statusFile);
      }
      fs.writeFileSync(path.join(dir, 'summary.json'), `${JSON.stringify({ at: new Date().toISOString(), ...result }, null, 2)}\n`);
      return { text: setupText({ lines: result.lines, status, statusFile }), json: result, code: result.ok ? 0 : 1 };
    },
  }),
];

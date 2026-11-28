import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { HelloEvent } from 'lynkeus-protocol';

import type { CaseReport } from '../cases/runner.js';
import { FRAME_MOVING, FRAME_NOT_APP } from '../cases/runner.js';
import { caseResults, suspectFrames } from '../commands/evidence.js';
import { emulatorBinary, pickAndroid, pickSimulator, platformsFor, relevantTail, runSetup, type SetupDeps, setupText } from '../commands/setup.js';
import { jobNotifier } from '../mcp/server.js';
import type { Ctx } from '../registry.js';
import { reactNative } from '../runtimes/react-native/index.js';

const tmp = (prefix: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

const write = (root: string, files: Record<string, string>) => {
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
};

const UDID = 'E92CC20A-0000-4000-8000-000000000001';
const simulators = (booted: boolean) =>
  JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [
        { udid: UDID, name: 'iPhone 17 Pro', state: booted ? 'Booted' : 'Shutdown', isAvailable: true },
        { udid: 'OTHER', name: 'iPhone 17', state: 'Shutdown', isAvailable: true },
      ],
    },
  });

type Fake = SetupDeps & { calls: string[]; streamed: string[][]; detached: string[][] };

/** A machine that answers as told and keeps every command setup would have run. */
const fakeDeps = (o: {
  answer?: (argv: string[]) => { code: number; stdout: string } | undefined;
  metro?: () => boolean;
  build?: (log: string) => number;
  attach?: (platform: string, ms: number) => HelloEvent | undefined;
}): Fake => {
  const calls: string[] = [];
  const streamed: string[][] = [];
  const detached: string[][] = [];
  let clock = 0;
  return {
    // These tests drive a Mac's Simulator, also when CI runs them on Linux.
    mac: true,
    calls,
    streamed,
    detached,
    exec: async (command, args) => {
      const argv = [command, ...args];
      calls.push(argv.join(' '));
      return o.answer?.(argv) ?? { code: 0, stdout: '' };
    },
    stream: async (command, args, s) => {
      streamed.push([command, ...args]);
      s.line('› Compiling app');
      return o.build ? o.build(s.log) : 0;
    },
    detach: (command, args) => {
      detached.push([command, ...args]);
      return 4242;
    },
    metroUp: async () => o.metro?.() ?? false,
    attach: async (platform, ms) => o.attach?.(platform, ms),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
};

test("setup builds for the device platforms cases.targets names, else the app's; iOS only on a Mac", () => {
  assert.deepEqual(platformsFor({ declared: ['headless', 'ios'], app: ['ios', 'android'], mac: true }), ['ios']);
  assert.deepEqual(platformsFor({ declared: ['headless'], app: ['ios', 'android'], mac: true }), []);
  assert.deepEqual(platformsFor({ app: ['ios', 'android'], mac: false }), ['android']);
  assert.deepEqual(platformsFor({ declared: ['simulator'], app: ['android'], mac: true }), ['android']);
  assert.deepEqual(platformsFor({ asked: ['android', 'android'], app: ['ios'], mac: true }), ['android']);
  assert.match(String(platformsFor({ asked: ['web'], app: ['ios'], mac: true })), /ios or android, not web/);
  assert.match(String(platformsFor({ asked: ['ios'], app: ['ios'], mac: false })), /needs a Mac/);
});

test('the project builds with its own commands: Expo with --no-bundler and the AVD name, React Native with --no-packager and the serial', () => {
  const expo = tmp('lynkeus-expo-');
  write(expo, { 'package.json': JSON.stringify({ dependencies: { expo: '55.0.5', 'react-native': '0.83.2' } }) });
  const bare = tmp('lynkeus-bare-');
  write(bare, { 'package.json': JSON.stringify({ dependencies: { 'react-native': '0.83.2' } }) });
  const sim = { platform: 'ios' as const, id: UDID, name: 'iPhone 17 Pro', type: 'simulator' as const, only: true };
  const emu = { platform: 'android' as const, id: 'emulator-5554', name: 'trial', avd: 'trial', type: 'emulator' as const, only: false };
  const phone = { platform: 'android' as const, id: 'R58M', name: 'R58M', type: 'physical' as const, only: true };
  assert.deepEqual(reactNative.devBuild!(expo, sim), ['npx', 'expo', 'run:ios', '--device', UDID, '--no-bundler']);
  // Expo looks an emulator up by its AVD name: the serial fails with "Could not find device with name".
  assert.deepEqual(reactNative.devBuild!(expo, emu), ['npx', 'expo', 'run:android', '--device', 'trial', '--no-bundler']);
  assert.deepEqual(reactNative.devBuild!(expo, phone), ['npx', 'expo', 'run:android', '--no-bundler']);
  assert.deepEqual(reactNative.devBuild!(bare, sim), ['npx', 'react-native', 'run-ios', '--udid', UDID, '--no-packager']);
  assert.deepEqual(reactNative.devBuild!(bare, emu), ['npx', 'react-native', 'run-android', '--deviceId', 'emulator-5554', '--no-packager']);
  assert.deepEqual(reactNative.bundler!(expo, { port: 8081, resetCache: true }), ['npx', 'expo', 'start', '--dev-client', '--port', '8081', '--clear']);
  assert.deepEqual(reactNative.bundler!(bare, { port: 8081, resetCache: false }), ['npx', 'react-native', 'start', '--port', '8081']);
});

test('a booted Simulator is taken as it is; one the project names is booted and said; none is booted that nobody named', async () => {
  const booted = fakeDeps({ answer: (a) => (a.includes('list') ? { code: 0, stdout: simulators(true) } : undefined) });
  const picked = await pickSimulator(booted, undefined);
  assert.ok('device' in picked && picked.device.id === UDID && !picked.booted);
  assert.ok(!booted.calls.some((c) => c.includes(' boot ')));

  const named = fakeDeps({ answer: (a) => (a.includes('list') ? { code: 0, stdout: simulators(false) } : undefined) });
  const boot = await pickSimulator(named, 'iPhone 17 Pro');
  assert.ok('device' in boot);
  assert.equal(boot.booted, `xcrun simctl shutdown ${UDID}`);
  assert.ok(named.calls.includes(`xcrun simctl boot ${UDID}`));

  const none = fakeDeps({ answer: (a) => (a.includes('list') ? { code: 0, stdout: simulators(false) } : undefined) });
  const refused = await pickSimulator(none, undefined);
  assert.ok('failed' in refused && /no iOS Simulator is booted, and the project names none/.test(refused.failed));
  assert.ok(!none.calls.some((c) => c.includes(' boot ')));
});

test('an emulator up is used; with none, only the AVD the project names is started, never wiped; with none named, the AVDs are listed', async () => {
  const logDir = tmp('lynkeus-setup-');
  const up = fakeDeps({
    answer: (a) =>
      a[1] === 'devices'
        ? { code: 0, stdout: 'List of devices attached\nemulator-5554\tdevice\n' }
        : a.includes('avd')
          ? { code: 0, stdout: 'trial\nOK\n' }
          : undefined,
  });
  const picked = await pickAndroid(up, { logDir });
  assert.ok('device' in picked && picked.device.avd === 'trial' && picked.device.id === 'emulator-5554' && !picked.booted);

  let started = false;
  const named = fakeDeps({
    answer: (a) => {
      if (a[0] === 'adb' && a[1] === 'devices') return { code: 0, stdout: `List of devices attached\n${started ? 'emulator-5556\tdevice\n' : ''}` };
      if (a.includes('-list-avds')) return { code: 0, stdout: 'trial\nother\n' };
      if (a.includes('avd')) return { code: 0, stdout: 'trial\nOK\n' };
      if (a.includes('sys.boot_completed')) return { code: 0, stdout: '1\n' };
      return undefined;
    },
  });
  const detach = named.detach;
  named.detach = (command, args, o) => {
    started = true;
    return detach(command, args, o);
  };
  const booted = await pickAndroid(named, { avd: 'trial', logDir });
  assert.ok('device' in booted, JSON.stringify(booted));
  assert.equal(booted.booted, 'adb -s emulator-5556 emu kill');
  assert.deepEqual(named.detached[0]!.slice(1), ['-avd', 'trial']);
  assert.ok(!named.detached.flat().some((a) => a.includes('wipe')));

  const nobody = fakeDeps({
    answer: (a) =>
      a[1] === 'devices' ? { code: 0, stdout: 'List of devices attached\n' } : a.includes('-list-avds') ? { code: 0, stdout: 'trial\nother\n' } : undefined,
  });
  const refused = await pickAndroid(nobody, { logDir });
  assert.ok('failed' in refused && /names no AVD to start.*AVDs here: trial, other/.test(refused.failed));
  assert.equal(nobody.detached.length, 0);
});

test("the emulator binary is the SDK's when ANDROID_HOME has it, else the PATH's", () => {
  assert.equal(
    emulatorBinary({ ANDROID_HOME: '/sdk' }, (f) => f === '/sdk/emulator/emulator'),
    '/sdk/emulator/emulator',
  );
  assert.equal(
    emulatorBinary({}, () => false),
    'emulator',
  );
});

/** An Expo app that init already set up, whose cases.targets name headless and iOS. */
const readyApp = () => {
  const root = tmp('lynkeus-ready-');
  write(root, {
    'package.json': JSON.stringify({ name: 'shop', dependencies: { expo: '55.0.5', 'react-native': '0.83.2', 'lynkeus-agent': '0.7.7' } }),
    'node_modules/lynkeus-agent/package.json': JSON.stringify({ name: 'lynkeus-agent', version: '0.7.7' }),
    'index.js': "import { auto } from 'lynkeus-agent/auto'\nauto({ token: process.env.EXPO_PUBLIC_LYNKEUS_TOKEN })\n",
    '.lynkeus/token': 'secret',
    '.env.local': 'EXPO_PUBLIC_LYNKEUS_TOKEN=secret\n',
    'app.json': JSON.stringify({ expo: { ios: { bundleIdentifier: 'com.shop' }, android: { package: 'com.shop' } } }),
  });
  return root;
};

const ctxFor = (root: string, said: string[]): Ctx => ({
  root,
  config: { cases: { targets: ['headless', 'ios'] } },
  attached: true,
  err: (line) => said.push(line),
  notify: (line) => said.push(line),
  graph: () => {
    throw new Error('no graph');
  },
  device: async () => {
    throw new Error('no app');
  },
  args: [],
  flags: {},
  passthrough: [],
});

const hello: HelloEvent = { event: 'hello', protocolVersion: 1, platform: 'ios', native: true, commands: [], agentVersion: '0.7.7', app: { name: 'Shop' } };

test("setup on a set-up app takes the booted Simulator, starts Metro, builds with the project's command and waits for the app", async () => {
  const root = readyApp();
  const said: string[] = [];
  let metro = false;
  let built = false;
  const deps = fakeDeps({
    answer: (a) => (a.includes('list') ? { code: 0, stdout: simulators(true) } : a.includes('get_app_container') ? { code: 1, stdout: '' } : undefined),
    metro: () => metro,
    attach: () => (built ? hello : undefined),
    build: () => {
      built = true;
      return 0;
    },
  });
  const detach = deps.detach;
  deps.detach = (c, a, o) => {
    metro = true;
    return detach(c, a, o);
  };
  const result = await runSetup(ctxFor(root, said), {}, deps);
  assert.equal(result.ok, true, JSON.stringify(result.lines));
  assert.deepEqual(
    result.lines.map((l) => l.step),
    ['init', 'ios device', 'metro', 'ios build', 'ios app'],
  );
  assert.equal(result.lines[0]!.text, 'already set up');
  assert.deepEqual(deps.detached[0], ['npx', 'expo', 'start', '--dev-client', '--port', '8081']);
  assert.deepEqual(deps.streamed, [['npx', 'expo', 'run:ios', '--device', UDID, '--no-bundler']]);
  assert.match(result.lines[4]!.text, /attached: Shop \(agent 0\.7\.7\) on port 8123/);
  // Progress went to the caller while it ran.
  assert.ok(said.some((l) => l.startsWith('ios build: npx expo run:ios')));
  assert.ok(fs.existsSync(path.join(root, '.lynkeus', 'runs', 'setup', 'build-ios.json')));

  // Again: the app dials in already, so nothing is built or started.
  const again = fakeDeps({ answer: (a) => (a.includes('list') ? { code: 0, stdout: simulators(true) } : undefined), metro: () => true, attach: () => hello });
  const second = await runSetup(ctxFor(root, []), {}, again);
  assert.equal(second.ok, true);
  assert.deepEqual(again.streamed, []);
  assert.deepEqual(again.detached, []);
  assert.match(second.lines.at(-1)!.text, /^already attached/);
});

test("a new Expo development build's dev-menu onboarding sheet is marked seen after it attaches, and the app launched once more without it", async () => {
  const root = readyApp();
  let built = false;
  const marked: string[] = [];
  const deps = fakeDeps({
    answer: (a) => (a.includes('list') ? { code: 0, stdout: simulators(true) } : a.includes('get_app_container') ? { code: 1, stdout: '' } : undefined),
    metro: () => true,
    attach: () => (built ? hello : undefined),
    build: () => {
      built = true;
      return 0;
    },
  });
  deps.devMenu = async (device) => {
    marked.push(device.id);
    return 'done';
  };
  const result = await runSetup(ctxFor(root, []), {}, deps);
  assert.equal(result.ok, true, JSON.stringify(result.lines));
  assert.deepEqual(marked, [UDID]);
  assert.equal(deps.calls.filter((c) => c.startsWith('xcrun simctl launch')).length, 1, deps.calls.join('\n'));
  assert.match(result.lines.at(-1)!.text, /dev-menu onboarding sheet marked seen and the app launched again without it/);
  // Already seen: no second launch.
  built = false;
  const seen = fakeDeps({
    answer: (a) => (a.includes('list') ? { code: 0, stdout: simulators(true) } : a.includes('get_app_container') ? { code: 1, stdout: '' } : undefined),
    metro: () => true,
    attach: () => (built ? hello : undefined),
    build: () => {
      built = true;
      return 0;
    },
  });
  seen.devMenu = async () => 'already';
  const again = await runSetup(ctxFor(root, []), { rebuild: true }, seen);
  assert.equal(again.ok, true);
  assert.equal(seen.calls.filter((c) => c.startsWith('xcrun simctl launch')).length, 0);
});

test('a failed build answers with its step, the log lines that say why and the log path', async () => {
  const root = readyApp();
  const deps = fakeDeps({
    answer: (a) => (a.includes('list') ? { code: 0, stdout: simulators(true) } : undefined),
    metro: () => true,
    build: (log) => {
      fs.appendFileSync(
        log,
        "Compiling Foo\n\u001b[31m❌ error: no such module 'ExpoModulesCore'\u001b[0m\n** BUILD FAILED **\nThe following build commands failed:\n",
      );
      return 65;
    },
  });
  const result = await runSetup(ctxFor(root, []), {}, deps);
  assert.equal(result.ok, false);
  const last = result.lines.at(-1)!;
  assert.equal(last.step, 'ios build');
  assert.match(last.text, /exited 65/);
  assert.deepEqual(last.tail, ["❌ error: no such module 'ExpoModulesCore'", '** BUILD FAILED **', 'The following build commands failed:']);
  assert.equal(last.log, path.join('.lynkeus', 'runs', 'setup', 'build-ios.log'));
  const text = setupText({ lines: result.lines });
  assert.match(text, /✗ ios build: .*exited 65/);
  assert.match(text, /whole log: \.lynkeus\/runs\/setup\/build-ios\.log/);
  assert.ok(text.split('\n').length <= 15, text);
});

test('a log with no line that says why gives its last lines; status in the answer is its gaps and advice', () => {
  assert.deepEqual(relevantTail('a\nb\nc\n', 2), ['b', 'c']);
  const text = setupText({
    lines: [{ step: 'init', ok: true, text: 'already set up' }],
    status: '✓ agent\n✗ cases to run — `lynkeus case init`\n\nWhere cases can run:\n○ FastSim\n→ write cases on headless',
    statusFile: '.lynkeus/runs/setup/status.txt',
  });
  assert.equal(text, '✓ init: already set up\n✗ cases to run — `lynkeus case init`\n→ write cases on headless\nstatus in full: .lynkeus/runs/setup/status.txt');
});

test('a job tells an MCP client each line as progress that only grows', () => {
  const sent: { progress: number; message: string }[] = [];
  const notify = jobNotifier((p) => sent.push(p));
  notify('metro: starting');
  notify('ios build 12 s: › Compiling');
  assert.deepEqual(sent, [
    { progress: 1, message: 'metro: starting' },
    { progress: 2, message: 'ios build 12 s: › Compiling' },
  ]);
});

const report = (id: string, steps: CaseReport['steps'], extra: Partial<CaseReport> = {}): CaseReport => ({
  id,
  file: `${id}.md`,
  result: steps.some((s) => s.status === 'failed') ? 'failed' : 'passed',
  ms: 1,
  steps,
  ...extra,
});

test("evidence names an action whose frame equals the step before's, and frames taken with a system view in front", () => {
  const frames: Record<string, string> = { '/f/1.avif': 'a', '/f/2.avif': 'a', '/f/3.avif': 'b', '/f/4.avif': 'b' };
  const runs = [
    {
      label: 'ios',
      dir: '/f',
      reports: [
        report(
          'drawer',
          [
            { step: 'app.see "Home"', status: 'passed', ms: 1, screenshot: '/f/1.avif' },
            { step: 'app.press 390,450', status: 'passed', ms: 1, screenshot: '/f/2.avif' },
            { step: 'app.press #menu', status: 'passed', ms: 1, screenshot: '/f/3.avif' },
            { step: 'app.see "Menu"', status: 'passed', ms: 1, screenshot: '/f/4.avif' },
          ],
          {
            warnings: [
              `${FRAME_NOT_APP} at step 3 (app.press #menu): the app was inactive, so a system view or another app is in front`,
              `${FRAME_MOVING} at step 4 (app.see "Menu"): the host's screen still moved 1.5 s after the step, so the frame is of a moment`,
            ],
          },
        ),
      ],
    },
  ];
  const suspects = suspectFrames(runs, (f) => frames[f]);
  assert.equal(suspects.length, 3, suspects.join('\n'));
  assert.match(suspects[0]!, /^ios drawer step 2 \(app\.press 390,450\): same frame as the step before/);
  assert.match(suspects[1]!, /^ios drawer: frame not of the app at step 3/);
  assert.match(suspects[2]!, /^ios drawer: frame of a moving screen at step 4/);
});

test('evidence answers a line per case with its result on each target and where a failure was', () => {
  const ok = report('login', [{ step: 'app.press #go', status: 'passed', ms: 1 }]);
  const broke = report('login', [
    { step: 'app.press #go', status: 'passed', ms: 1 },
    { step: 'app.see "Welcome"', status: 'failed', ms: 1, error: 'not on screen: Welcome\nmore' },
  ]);
  assert.deepEqual(
    caseResults([
      { label: 'ios', dir: '', reports: [ok] },
      { label: 'android', dir: '', reports: [broke] },
    ]),
    ['login: ios ✅ · android ❌ — android step 2: not on screen: Welcome'],
  );
});

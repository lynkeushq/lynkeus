/**
 * More of what a React Native project meets, read off the CLI as probe.ts reads the rest: which simulator, emulator
 * or phone a run picks and the OS commands it sends them (against stand-in `xcrun` and `adb` on PATH), the run folder
 * a scripted `case run --out` writes for a report to read (run.json, cases.jsonl, the step files), and how
 * lynkeus.config.json resolves. Same rules as probe.ts: only what main exports, and a fresh machine.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { AgentServer } from 'lynkeus-client';

import type { Device } from '../../device/driver.js';
import type { Base } from '../../registry.js';
import { FakeApp, VirtualClock } from './fakeApp.js';
import { hermetic } from './hermetic.js';
import { type Entries, loadCli } from './probe.js';

const HOME = hermetic();
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const mod = <T>(relative: string): Promise<T> => import(pathToFileURL(path.join(SRC, relative)).href) as Promise<T>;
const tempDir = (prefix: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const named = (text: string, names: Record<string, string>) =>
  Object.entries({ ...names, '<home>': HOME }).reduce((t, [name, value]) => t.split(value).join(name), text);
const clean = (value: unknown, names: Record<string, string>): unknown => JSON.parse(named(JSON.stringify(value) ?? 'null', names));
/** As `clean`, with the instants the run read off the real clock (`new Date()`) named for what they are. */
const cleanRun = (value: unknown, names: Record<string, string>): unknown =>
  JSON.parse(named(JSON.stringify(value) ?? 'null', names).replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, '<iso>'));
const errorOf = (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) });

// ---- devices ----------------------------------------------------------------------------------------------------

type DeviceInfo = { id: string; name: string; platform: string; type: string; connected: boolean };
type Devices = {
  pickAgentDevice: (wanted?: string) => Promise<DeviceInfo>;
  pickAndroidDevice: (wanted?: string) => Promise<DeviceInfo>;
  // Main's name for it, which reversed phones only; now every adb device and emulator.
  reversePhones?: (port: number) => Promise<void>;
  reverseAndroid?: (port: number) => Promise<unknown>;
};
type Lifecycle = {
  lifecycleFor: (platform: 'ios' | 'android') => {
    launchApp(deviceId: string, appId: string, fresh: boolean): Promise<void>;
    screenshot(deviceId: string, destination: string): Promise<void>;
    freezeChrome(deviceId: string): Promise<void>;
  };
};

const SIMULATORS = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [
      { udid: 'AAAA-1111', name: 'iPhone 17 Pro', state: 'Booted' },
      { udid: 'BBBB-2222', name: 'iPhone 16e', state: 'Shutdown' },
    ],
    'com.apple.CoreSimulator.SimRuntime.iOS-18-6': [{ udid: 'CCCC-3333', name: 'iPhone 16', state: 'Booted' }],
  },
});
const ADB_DEVICES = 'List of devices attached\nemulator-5554\tdevice\nR58M123ABC\tdevice\n0123456789\toffline\nZX1G22\tunauthorized\n\n';

// Each tool writes its argv to the log and answers from a file; a tool left out is not on PATH (ENOENT).
const XCRUN = `#!/bin/sh\necho "xcrun $*" >> "$FAKE_TOOLS_LOG"\nif [ "$1 $2" = "simctl list" ]; then\n  if [ -f "$FAKE_TOOLS_DIR/simctl-fails" ]; then echo "simctl: CoreSimulatorService connection became invalid" >&2; exit 1; fi\n  cat "$FAKE_TOOLS_DIR/simctl.json"\nfi\n`;
const ADB = `#!/bin/sh\necho "adb $*" >> "$FAKE_TOOLS_LOG"\ncase "$*" in\n  devices) cat "$FAKE_TOOLS_DIR/adb-devices.txt" ;;\n  *"exec-out screencap"*) printf 'screencap-bytes' ;;\nesac\n`;

type Machine = { xcrun?: string | 'fails'; adb?: string; env?: string };

/** Runs `fn` on a machine whose only tools are the stand-ins `machine` names; what they were asked and what it gave. */
const onMachine = async (machine: Machine, fn: () => Promise<unknown>): Promise<unknown> => {
  const dir = tempDir('lynkeus-goldens-tools-');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(dir, 'log');
  fs.writeFileSync(log, '');
  // Nothing else on PATH: macOS keeps a real xcrun in /usr/bin, and a Linux machine may have adb there.
  fs.symlinkSync(fs.existsSync('/bin/cat') ? '/bin/cat' : '/usr/bin/cat', path.join(bin, 'cat'));
  if (machine.xcrun !== undefined) {
    fs.writeFileSync(path.join(bin, 'xcrun'), XCRUN, { mode: 0o755 });
    if (machine.xcrun === 'fails') fs.writeFileSync(path.join(dir, 'simctl-fails'), '');
    else fs.writeFileSync(path.join(dir, 'simctl.json'), machine.xcrun);
  }
  if (machine.adb !== undefined) {
    fs.writeFileSync(path.join(bin, 'adb'), ADB, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'adb-devices.txt'), machine.adb);
  }
  const saved = { PATH: process.env.PATH, LYNKEUS_DEVICE: process.env.LYNKEUS_DEVICE };
  process.env.PATH = bin;
  Object.assign(process.env, { FAKE_TOOLS_LOG: log, FAKE_TOOLS_DIR: dir });
  if (machine.env) process.env.LYNKEUS_DEVICE = machine.env;
  else delete process.env.LYNKEUS_DEVICE;
  try {
    let result: unknown;
    try {
      result = await fn();
    } catch (error) {
      result = errorOf(error);
    }
    const asked = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
    return clean({ result, asked }, { '<tools>': dir });
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.LYNKEUS_DEVICE === undefined) delete process.env.LYNKEUS_DEVICE;
    else process.env.LYNKEUS_DEVICE = saved.LYNKEUS_DEVICE;
    delete process.env.FAKE_TOOLS_LOG;
    delete process.env.FAKE_TOOLS_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

const NO_SIMULATORS = JSON.stringify({ devices: {} });

export const probeDevices = async (): Promise<Entries> => {
  const d = await mod<Devices>('device/devices.js');
  const { lifecycleFor } = await mod<Lifecycle>('device/platform.js');
  const out: Entries = {};
  const agent: [string, Machine, string?][] = [
    ['no xcrun, no adb', {}],
    ['no xcrun, an adb serial asked for', { adb: ADB_DEVICES }, 'emulator-5554'],
    ['no xcrun, an unknown device asked for', { adb: ADB_DEVICES }, 'nope'],
    ['no simulator booted', { xcrun: NO_SIMULATORS, adb: ADB_DEVICES }],
    ['no simulator booted, one asked for', { xcrun: NO_SIMULATORS }, 'iPhone 17 Pro'],
    ['booted simulators', { xcrun: SIMULATORS, adb: ADB_DEVICES }],
    ['a simulator by udid', { xcrun: SIMULATORS }, 'CCCC-3333'],
    ['a simulator by part of its name', { xcrun: SIMULATORS }, '17 Pro'],
    ['a shut-down simulator', { xcrun: SIMULATORS }, 'BBBB-2222'],
    ['a phone by its adb serial, simulators booted', { xcrun: SIMULATORS, adb: ADB_DEVICES }, 'R58M123ABC'],
    ['an offline phone', { xcrun: SIMULATORS, adb: ADB_DEVICES }, '0123456789'],
    ['LYNKEUS_DEVICE', { xcrun: SIMULATORS, env: 'iPhone 16' }],
    ['simctl fails', { xcrun: 'fails', adb: ADB_DEVICES }],
  ];
  for (const [name, machine, wanted] of agent) out[`agent/${name}`] = await onMachine(machine, () => d.pickAgentDevice(wanted));
  const android: [string, Machine, string?][] = [
    ['no adb', {}],
    ['no device up', { adb: 'List of devices attached\n\n' }],
    ['the first that is up', { adb: ADB_DEVICES }],
    ['a phone asked for', { adb: ADB_DEVICES }, 'R58M123ABC'],
    ['an unknown device asked for', { adb: ADB_DEVICES }, 'nope'],
    ['an unauthorized phone asked for', { adb: ADB_DEVICES }, 'ZX1G22'],
    ['LYNKEUS_DEVICE', { adb: ADB_DEVICES, env: 'R58M123ABC' }],
  ];
  for (const [name, machine, wanted] of android) out[`android/${name}`] = await onMachine(machine, () => d.pickAndroidDevice(wanted));
  const reverse = (port: number) => (d.reverseAndroid ?? d.reversePhones)!(port);
  out['reverse/phones only'] = await onMachine({ adb: ADB_DEVICES }, () => reverse(8123));
  out['reverse/no adb'] = await onMachine({}, () => reverse(8123));
  for (const platform of ['ios', 'android'] as const) {
    const id = platform === 'ios' ? 'AAAA-1111' : 'emulator-5554';
    const tools = { xcrun: SIMULATORS, adb: ADB_DEVICES };
    const life = lifecycleFor(platform);
    out[`${platform}/launch fresh`] = await onMachine(tools, () => life.launchApp(id, 'com.example.shop', true));
    out[`${platform}/launch`] = await onMachine(tools, () => life.launchApp(id, 'com.example.shop', false));
    out[`${platform}/freeze chrome`] = await onMachine(tools, () => life.freezeChrome(id));
    out[`${platform}/screenshot`] = await onMachine(tools, async () => {
      const file = path.join(process.env.FAKE_TOOLS_DIR!, 'shot.png');
      await life.screenshot(id, file);
      return { wrote: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null };
    });
  }
  return out;
};

// ---- the run folder a report reads ------------------------------------------------------------------------------

type Execute = { execute: (argv: string[], base: Base) => Promise<{ code: number; error?: string; text?: string; json?: unknown }> };

const CASES: Record<string, string> = {
  'count.md': `---
id: count
title: Counts to two
tags: [smoke]
---
steps:
  - app.call: { command: reset }
  - app.press: "#increment"
  - app.press: "#increment"
  - app.see: { text: "Count: 2" }
  - app.type: { target: "#name", text: "Ana" }
  - app.press: "#send"
  - app.wait: { request: "POST /api/code" }
`,
  'list.md': `---
id: list
---
setup:
  - app.call: { command: reset }
steps:
  # 1 Open the list
  - app.press: "#open-list"
  - app.see: { text: "Items" }
  # 2 Pick a row
  - app.wait: { target: "Item 40", scroll: true }
  - app.press: "Item 40"
  - app.see: { text: "Picked Item 40" }
`,
  'missing.md': `---
id: missing
---
steps:
  - app.press: "#increment"
  - app.press: { target: "#missing", timeoutMs: 400 }
  - app.see: { text: "Welcome" }
`,
};

/** A scripted `case run --out --screenshots` on a React Native project: what it answers and every data file it writes. */
export const probeReport = async (): Promise<Entries> => {
  await loadCli();
  const { execute } = await mod<Execute>('runtime.js');
  const { Device: DeviceClass } = await mod<{ Device: new (info: unknown, options: unknown) => Device }>('device/driver.js');
  const root = tempDir('lynkeus-goldens-report-');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'shop', dependencies: { 'react-native': '0.81.0' } }));
  fs.mkdirSync(path.join(root, 'cases'));
  for (const [file, text] of Object.entries(CASES)) fs.writeFileSync(path.join(root, 'cases', file), text);
  const runDir = path.join(root, 'run');
  const clock = new VirtualClock();
  const fake = new FakeApp(clock, { hello: { native: true, commands: ['reset', 'events', 'screenshot', 'still'] } });
  const device = new DeviceClass({ id: 'fake', name: 'Fake', platform: 'ios', type: 'simulator', connected: true }, { server: fake as unknown as AgentServer });
  const base: Base = {
    root,
    config: {},
    attached: true,
    err: () => undefined,
    graph: () => {
      throw new Error('no graph');
    },
    device: async () => device,
  };
  const cwd = process.cwd();
  process.chdir(root);
  clock.install();
  let answer: Awaited<ReturnType<Execute['execute']>>;
  try {
    answer = await execute(['case', 'run', '--out', runDir, '--screenshots', '--frames', 'png', '--seed', 'goldens'], base);
  } finally {
    clock.restore();
    process.chdir(cwd);
  }
  const names = { '<run>': runDir, '<root>': root };
  const out: Entries = { answer: cleanRun({ code: answer.code, error: answer.error, text: answer.text, json: answer.json }, names) };
  const files = fs.readdirSync(runDir, { recursive: true }).map(String).sort();
  out.files = files;
  for (const file of files) {
    const full = path.join(runDir, file);
    if (fs.statSync(full).isDirectory()) continue;
    const text = fs.readFileSync(full, 'utf8');
    if (file.endsWith('.json')) out[`file/${file}`] = cleanRun(JSON.parse(text), names);
    else if (file.endsWith('.jsonl') || file.endsWith('.ndjson'))
      out[`file/${file}`] = text
        .split('\n')
        .filter(Boolean)
        .map((line) => cleanRun(JSON.parse(line), names) as Record<string, unknown>)
        // The process id, and the run's length, which runs from a real instant to the fake clock's.
        .map((line) => ({ ...line, ...('pid' in line ? { pid: '<pid>' } : {}), ...(line.type === 'run-end' ? { ms: '<ms>' } : {}) }));
  }
  fs.rmSync(root, { recursive: true, force: true });
  return out;
};

// ---- lynkeus.config.json ----------------------------------------------------------------------------------------

type Config = {
  loadConfig: (root?: string) => Record<string, unknown>;
  portFromEnv: (config?: Record<string, unknown>) => number | undefined;
  anyOf: (patterns: string[] | undefined) => RegExp | undefined;
};
type Launch = {
  resolveLaunch: (flags: Record<string, unknown>, config: Record<string, unknown>, env?: NodeJS.ProcessEnv) => unknown;
  launchEnv: (launch: unknown) => Record<string, string>;
};
type CaseFiles = { caseFiles: (args: string[], home: string, casesDir: string | undefined) => string[] | string };

const CONFIGS: Record<string, { own?: string; extra?: string; env?: Record<string, string>; flags?: Record<string, unknown>; cases?: string[] }> = {
  none: {},
  empty: { own: '{}' },
  'every key': {
    own: JSON.stringify({
      cases: { dir: 'qa/cases', fixtures: 'node qa/fixtures.js', macros: { 'app.login': [{ 'app.call': { command: 'reset' } }] } },
      ci: { backend: { up: 'docker compose up -d', ready: 'http://127.0.0.1:3000/health' }, hosts: { count: 2 }, push: true, run: ['--once'] },
      entry: 'qa/headless.tsx',
      apiEnv: 'API_URL',
      apiUrl: 'http://127.0.0.1:3000',
      port: 8200,
      device: 'iPhone 17 Pro',
      app: 'com.example.shop',
      report: { afterPush: 'delete' },
      language: 'es',
      locale: { languageTag: 'es-AR', country: 'AR' },
      launch: { seed: 7, locale: 'es-ar', timeZone: 'America/Argentina/Buenos_Aires', epoch: '2026-03-01T09:00:00Z' },
      attachTimeout: 30000,
      errorCopy: ['something went wrong', 'try again'],
      live: ['^clock$'],
      strictMode: true,
      crawl: { never: ['delete'], close: ['close'], back: ['back'] },
    }),
    cases: [],
  },
  'cases in the default folder': { own: '{}', cases: ['cases/a.md', 'cases/nested/b.md', 'cases/README.md'] },
  'cases in a folder of their own': { own: JSON.stringify({ cases: { dir: 'qa' } }), cases: ['qa/a.md', 'cases/ignored.md'] },
  'LYNKEUS_CONFIG over the project': {
    own: JSON.stringify({ port: 8200, device: 'iPhone 16', cases: { dir: 'cases' } }),
    extra: JSON.stringify({ port: 8300, cases: { dir: 'shared' } }),
    cases: ['../shared/shared/c.md'],
  },
  'LYNKEUS_PORT over the config': { own: JSON.stringify({ port: 8200 }), env: { LYNKEUS_PORT: '8400' } },
  'launch from the environment': {
    own: '{}',
    env: { LYNKEUS_SEED: 'abc', LYNKEUS_LOCALE: 'de-de', LYNKEUS_TIME_ZONE: 'Europe/Madrid', LYNKEUS_EPOCH: '1767225600000' },
  },
  'launch flags over the config': {
    own: JSON.stringify({ launch: { seed: 'config', locale: 'en-US' } }),
    flags: { seed: 42, locale: 'pt-br', 'time-zone': 'UTC', epoch: '2026-01-01T00:00:00Z' },
  },
  'a locale that is not one': { own: JSON.stringify({ launch: { locale: 'not a locale!' } }) },
  'a time zone that is not one': { own: JSON.stringify({ launch: { timeZone: 'Mars/Olympus' } }) },
  'an epoch that is not one': { own: JSON.stringify({ launch: { epoch: 'yesterday' } }) },
  'not JSON': { own: '{ "port": 8200, }' },
};

/** Each lynkeus.config.json shape as the CLI resolves it: the config, the port, the launch facts and the case files. */
export const probeConfig = async (): Promise<Entries> => {
  const { loadConfig, portFromEnv, anyOf } = await mod<Config>('config.js');
  const { resolveLaunch, launchEnv } = await mod<Launch>('cases/launch.js');
  const { caseFiles } = await mod<CaseFiles>('commands/cases.js');
  const out: Entries = {};
  for (const [name, shape] of Object.entries(CONFIGS)) {
    const top = tempDir('lynkeus-goldens-config-');
    const root = path.join(top, 'app');
    fs.mkdirSync(root);
    if (shape.own !== undefined) fs.writeFileSync(path.join(root, 'lynkeus.config.json'), shape.own);
    if (shape.extra !== undefined) {
      fs.mkdirSync(path.join(top, 'shared'));
      fs.writeFileSync(path.join(top, 'shared', 'lynkeus.config.json'), shape.extra);
    }
    for (const file of shape.cases ?? []) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), '---\nid: x\n---\nsteps:\n  - app.see: Home\n');
    }
    const env = { ...shape.env, ...(shape.extra !== undefined ? { LYNKEUS_CONFIG: path.join(top, 'shared', 'lynkeus.config.json') } : {}) };
    Object.assign(process.env, env);
    const cwd = process.cwd();
    process.chdir(root);
    try {
      let config: Record<string, unknown>;
      try {
        config = loadConfig(root);
      } catch (error) {
        // The parser's own words change with Node's version; which file failed, and that it failed, are the CLI's.
        out[name] = clean({ error: (error as Error).message.replace(/: [^:]*JSON[^:]*$/, ': <not JSON>') }, { '<top>': top });
        continue;
      }
      const launch = resolveLaunch(shape.flags ?? {}, config, process.env);
      const cases = config.cases as { base?: string; dir?: string } | undefined;
      const files = caseFiles([], cases?.base ?? root, cases?.dir);
      out[name] = clean(
        {
          config,
          port: portFromEnv(config) ?? null,
          errorCopy: anyOf(config.errorCopy as string[] | undefined)?.source ?? null,
          launch,
          launchEnv: typeof launch === 'string' ? null : launchEnv(launch),
          caseFiles: typeof files === 'string' ? files : files.map((f) => path.relative(top, f)).sort(),
        },
        { '<top>': top },
      );
    } finally {
      process.chdir(cwd);
      for (const key of Object.keys(env)) delete process.env[key];
      fs.rmSync(top, { recursive: true, force: true });
    }
  }
  return out;
};

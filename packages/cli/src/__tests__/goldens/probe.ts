/**
 * What the React Native side of the CLI does, read off the CLI itself: how cases parse and resolve, what the runner
 * sends a React Native app, what the CLI and its MCP server say, and which runtime each kind of folder is taken for.
 * rnInvariance.test.ts compares it with goldens that scripts/goldens-rn.mjs makes by running this file against main.
 *
 * It must run on main's code too: it uses only what main exports, and nothing from runtimes/.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { AgentServer } from 'lynkeus-client';

import type { Device } from '../../device/driver.js';
import type { Base, Command } from '../../registry.js';
import { FakeApp, type FakeOptions, VirtualClock } from './fakeApp.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const GOLDENS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'rn');
export const CORPUS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'corpus');

export type Entries = Record<string, unknown>;

const mod = <T>(relative: string): Promise<T> => import(pathToFileURL(path.join(SRC, relative)).href) as Promise<T>;

type Registry = {
  commands: () => Command[];
  find: (name: string) => Command | undefined;
  helpFor: (c: Command) => string;
  usage: () => string;
};
type Runner = {
  runCase: (c: unknown, options: Record<string, unknown>) => Promise<Record<string, unknown>>;
  argvFor: (c: Command, value: unknown) => string[];
};
type Format = { readCases: (file: string) => Record<string, unknown>[]; parseCase: (text: string, file: string) => Record<string, unknown> };
type Execute = { execute: (argv: string[], base: Base) => Promise<Record<string, unknown>> };

/** Every command registered as the binary registers them: cli.ts, imported once with `help` as its argv. */
export const loadCli = async (): Promise<Registry> => {
  const argv = process.argv;
  const log = console.log;
  process.argv = [argv[0]!, 'lynkeus', 'help'];
  console.log = () => undefined;
  try {
    await mod('cli.js');
  } finally {
    process.argv = argv;
    console.log = log;
  }
  return mod<Registry>('registry.js');
};

const tempDir = (prefix: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

const write = (dir: string, files: Record<string, string>) => {
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
};

const RN_MANIFEST = JSON.stringify({ name: 'shop', dependencies: { react: '19.1.0', 'react-native': '0.81.0' } });
const FLUTTER_PUBSPEC = 'name: shop\ndependencies:\n  flutter:\n    sdk: flutter\n';

/** A temporary React Native project. */
const reactNativeProject = () => {
  const dir = tempDir('lynkeus-goldens-rn-');
  write(dir, { 'package.json': RN_MANIFEST });
  return dir;
};

/** Temporary folders named for what they are, so a golden does not change with them. */
const without = (text: string, root: string, evidence?: string) => {
  const named = text.split(root).join('<root>');
  return evidence ? named.split(evidence).join('<evidence>') : named;
};

// ---- (i) parsing and step resolution ----------------------------------------------------------------------------

/** Each case file of the corpus as it parses, and each app step as the argv the runner hands the command it names. */
export const probeParse = async (dirs: string[]): Promise<Entries> => {
  const { find } = await loadCli();
  const { readCases } = await mod<Format>('cases/format.js');
  const { argvFor } = await mod<Runner>('cases/runner.js');
  const out: Entries = {};
  const files = dirs.flatMap((dir) =>
    fs
      .readdirSync(dir, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith('.md') && !/(^|\/)(README|FORMAT|CATALOG)\.md$/.test(f))
      .map((f) => ({ key: `${path.basename(dir)}/${f}`, file: path.join(dir, f), dir })),
  );
  for (const { key, file, dir } of files.sort((a, b) => a.key.localeCompare(b.key))) {
    let cases: Record<string, unknown>[];
    try {
      cases = readCases(file);
    } catch (error) {
      out[key] = { error: without((error as Error).message, dir) };
      continue;
    }
    out[key] = cases.map((c) => {
      const { file: _file, ...rest } = c;
      const steps = [...((c.setup as { verb: string; value: unknown }[]) ?? []), ...((c.steps as { verb: string; value: unknown }[]) ?? [])];
      const argv = steps.flatMap((s) => {
        if (!s.verb.startsWith('app.')) return [];
        const name = s.verb.slice(4);
        const command = find(name) ?? find(`os ${name}`);
        if (!command || ['see', 'call', 'run', 'events', 'event', 'requests'].includes(name)) return [];
        try {
          return [`${s.verb} → ${JSON.stringify(argvFor(command, s.value))}`];
        } catch (error) {
          return [`${s.verb} → ✗ ${(error as Error).message}`];
        }
      });
      return { ...rest, argv };
    });
  }
  return out;
};

// ---- (ii) the runner's traffic --------------------------------------------------------------------------------

type Scenario = {
  name: string;
  steps: string;
  fake?: FakeOptions;
  config?: Record<string, unknown>;
  evidence?: 'screenshots' | 'compare';
  events?: boolean;
  dry?: boolean;
  continue?: boolean;
  teardown?: string;
};

const NATIVE = { native: true, commands: ['reset', 'events', 'screenshot', 'still'] };

export const SCENARIOS: Scenario[] = [
  {
    name: 'counter-name-and-countdown',
    steps: `
  - app.call: { command: reset }
  - app.see: { text: "Count: 0" }
  - app.press: "#increment"
  - app.press: "#increment"
  - app.see: { text: "Count: 2" }
  - app.type: { target: "#name", text: "Ana" }
  - app.press: "#send"
  - app.see: { text: "Code sent to Ana" }
  - app.see: { text: "Resend in 3" }
  - app.wait: { target: "Resend now", timeoutMs: 6000 }`,
  },
  {
    name: 'list-back-and-dialog',
    steps: `
  - app.press: "#open-list"
  - app.see: { text: "Items" }
  - app.wait: { target: "Item 40", scroll: true }
  - app.press: "Item 40"
  - app.see: { text: "Picked Item 40" }
  - app.press: "#open-list"
  - app.back
  - app.press: "#delete"
  - app.see: { layer: confirm-delete }
  - app.see: { testId: increment, absent: true }
  - app.press: "#confirm"
  - app.wait: { target: "Delete everything?", gone: true }
  - app.see: { text: "Everything was deleted" }`,
  },
  {
    name: 'every-wait',
    steps: `
  - app.press: "#open-list"
  - app.wait: List
  - app.back
  - app.wait: "route:Home"
  - app.wait: 250
  - app.wait: "#increment"
  - app.wait: { text: "Count: 0" }
  - app.wait: { text: Home }
  - app.wait: { what: '"Welcome"' }
  - app.wait: { anyOf: ["Goodbye", { testId: send }, { text: "Welcome", nth: 0 }] }
  - app.wait: { target: "#later", enabled: true }
  - app.press: "#send"
  - app.wait: { request: "POST /api/code" }
  - app.wait: { request: "POST /api/code/", status: 200 }`,
    fake: { laterAfter: 2 },
  },
  {
    name: 'native-window-scrolls',
    steps: `
  - app.press: "#footer"
  - app.press: "#open-list"
  - app.press: "Item 13"
  - app.press: "#open-list"
  - app.see: { text: "Item 30" }
  - app.press: { text: "Item 30" }`,
    fake: { hello: NATIVE },
  },
  {
    name: 'retries-until-enabled-and-listed',
    steps: `
  - app.press: "#later"
  - app.press: { testId: late, timeoutMs: 500 }
  - app.press: { target: "Nowhere", optional: true }
  - app.press: { target: "#increment", within: "#name", nth: 0 }
  - app.press: "1"`,
    fake: { laterAfter: 3, lateAfter: 2 },
  },
  {
    name: 'press-by-number',
    steps: `
  - app.press: 2
  - app.see: { text: "Count: 1" }`,
  },
  {
    name: 'interruptions',
    steps: `
  - app.press: "#increment"
  - app.press: "#increment"
  - app.see: { text: "Count: 2" }
  - app.wait: { target: "#send" }
  - app.type: { target: "#name", text: "Bo", clear: true, submit: true }`,
    fake: { consentAfter: 1 },
    config: { interruptions: [{ see: '#consent-sheet', do: [{ 'app.press': '#accept' }], unless: 'keypad' }] },
  },
  {
    name: 'screenshots-each-step',
    steps: `
  - app.press: "#increment"
  - app.see: { text: "Count: 1" }
  - app.see: { text: "Welcome" }
  - app.press: "#open-list"
  - app.back`,
    fake: { hello: NATIVE },
    evidence: 'screenshots',
  },
  {
    name: 'compare-run-frames',
    steps: `
  - app.press: "#increment"
  - app.see: { text: "Count: 1" }
  - app.see: { text: "Welcome" }
  - app.press: "#send"
  - app.wait: { target: "#resend", timeoutMs: 5000 }`,
    fake: { hello: { ...NATIVE, commands: [...NATIVE.commands, 'clock'] } },
    evidence: 'compare',
  },
  {
    name: 'macros-blocks-and-commands',
    steps: `
  - app.login: { wait: Home }
  - on: device
    do:
      - app.press: "#increment"
  - on: headless
    do:
      - app.press: "#send"
  - on: ios
    do:
      - app.see: { text: "Welcome" }
  - on: "has:reset"
    do:
      - app.call: { command: reset, expect: { ok: true }, as: answer }
  - app.swipe: { direction: up, target: "#footer" }
  - app.swipe: { from: "200,600", to: "200,200" }
  - app.requests: mark
  - app.deeplink: "myapp://home"
  - app.mock: { route: "GET /v3/accounts", status: 500 }
  - on: "!android"
    do:
      - app.nav: Settings
  - app.nav: { route: List, params: { from: "case" } }
  - app.see: { route: List }`,
    config: {
      macros: {
        'app.login': [{ 'app.call': { command: 'reset' } }, { when: 'wait', do: { 'app.wait': '{{param.wait}}' } }, { unless: 'wait', do: 'app.back' }],
      },
    },
  },
  {
    name: 'failure-evidence-and-continue',
    steps: `
  - app.press: "#increment"
  - app.see: { text: "Count: 5", timeoutMs: 500 }
  - app.wait: { target: "#never", timeoutMs: 300 }
  - app.see: { text: "Welcome" }`,
    continue: true,
  },
  {
    name: 'failure-stops-and-tears-down',
    steps: `
  - app.press: "#missing"
  - app.see: { text: "Welcome" }`,
    teardown: `
  - app.call: { command: reset }`,
  },
  {
    name: 'events',
    steps: `
  - app.events: clear
  - app.type: { target: "#name", text: "Cy" }
  - app.press: "#send"
  - app.event: { name: code_sent, props: { to: Cy } }`,
    events: true,
  },
  {
    name: 'unsupported-command',
    steps: `
  - app.call: { command: clock, params: { advance: 100 } }
  - app.see: { text: "Welcome" }`,
    fake: { missing: ['clock'] },
  },
  {
    name: 'dry-run',
    steps: `
  - app.press: "#increment"
  - app.nowhere: { at: all }
  - app.see: { text: "Count: 1" }`,
    dry: true,
  },
];

const caseText = (s: Scenario) => `---\nid: ${s.name}\n---\nsteps:${s.steps}\n${s.teardown ? `teardown:${s.teardown}\n` : ''}`;

/** One scenario against the fake app, on its virtual clock: the messages the CLI sent and the report it made. */
export const runScenario = async (s: Scenario, root: string, keep?: (fake: FakeApp) => void): Promise<{ messages: string[]; report: unknown }> => {
  const { parseCase } = await mod<Format>('cases/format.js');
  const { runCase } = await mod<Runner>('cases/runner.js');
  const { Device } = await mod<{ Device: new (info: unknown, options: unknown) => Device }>('device/driver.js');
  const clock = new VirtualClock();
  const fake = new FakeApp(clock, s.fake);
  keep?.(fake);
  const device = new Device({ id: 'fake', name: 'Fake', platform: 'ios', type: 'simulator', connected: true }, { server: fake as unknown as AgentServer });
  const evidenceDir = tempDir('lynkeus-goldens-evidence-');
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
  const evidence =
    s.evidence === 'screenshots'
      ? { dir: evidenceDir, screenshots: true, frames: 'png' }
      : s.evidence === 'compare'
        ? { dir: evidenceDir, screenshots: true, frames: 'png', onChange: true, stillMs: 300, settleMs: 700 }
        : undefined;
  clock.install();
  let report: Record<string, unknown>;
  try {
    report = await runCase(parseCase(caseText(s), `${s.name}.md`), {
      base,
      config: s.config ?? {},
      seed: 'goldens',
      ...(evidence ? { evidence } : {}),
      ...(s.events ? { events: true } : {}),
      ...(s.dry ? { dry: true } : {}),
      ...(s.continue ? { continue: true } : {}),
    });
  } finally {
    clock.restore();
  }
  fs.rmSync(evidenceDir, { recursive: true, force: true });
  const steps = (report.steps as Record<string, unknown>[]).map(({ ms: _ms, screenshot, looked, ...rest }) => ({
    ...rest,
    ...(typeof screenshot === 'string' ? { screenshot: path.basename(screenshot) } : {}),
    ...(looked ? { looked } : {}),
  }));
  const { ms: _ms, file: _file, ...summary } = report;
  const clean = (value: unknown) => JSON.parse(without(JSON.stringify(value), root, evidenceDir));
  return { messages: fake.log.map((line) => without(line, root, evidenceDir)), report: clean({ ...summary, steps }) };
};

export const probeWire = async (): Promise<Entries> => {
  await loadCli();
  const root = reactNativeProject();
  const out: Entries = {};
  for (const s of SCENARIOS) out[s.name] = await runScenario(s, root);
  fs.rmSync(root, { recursive: true, force: true });
  return out;
};

// ---- (iii) the CLI's surface ----------------------------------------------------------------------------------

type Rpc = { id?: number; result?: Record<string, unknown> };

/** The MCP server as a client meets it: what `initialize` answers and the tools it lists. */
const mcpSurface = (cwd: string, full: boolean): Promise<{ instructions: unknown; tools: unknown }> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), path.join(SRC, 'cli.ts'), 'mcp', ...(full ? ['--full'] : [])], {
      cwd,
      env: { ...process.env, LYNKEUS_CONFIG: '', LYNKEUS_TOKEN: 'goldens' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const answers = new Map<number, Record<string, unknown>>();
    let buffered = '';
    let stderr = '';
    const send = (message: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`the MCP server did not answer: ${stderr}`));
    }, 30_000);
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.stdout.on('data', (chunk: Buffer) => {
      buffered += chunk.toString();
      for (let at = buffered.indexOf('\n'); at >= 0; at = buffered.indexOf('\n')) {
        const line = buffered.slice(0, at);
        buffered = buffered.slice(at + 1);
        const message = JSON.parse(line) as Rpc;
        if (message.id === undefined || !message.result) continue;
        answers.set(message.id, message.result);
        if (message.id === 1) {
          send({ method: 'notifications/initialized' });
          send({ id: 2, method: 'tools/list', params: {} });
        } else if (message.id === 2) {
          clearTimeout(timer);
          child.stdin.end();
          child.kill();
          resolve({ instructions: answers.get(1)?.instructions, tools: answers.get(2)?.tools });
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'goldens', version: '0' } } });
  });

/** Commands that fail before they reach an app, a network or a device: their exit code and what they say. */
const FAILURES: { name: string; argv: string[]; token?: boolean }[] = [
  { name: 'unknown command', argv: ['frobnicate'] },
  { name: 'press without a target', argv: ['press'] },
  { name: 'press with an unknown flag', argv: ['press', '#x', '--bogus'] },
  { name: 'wait with nothing', argv: ['wait'] },
  { name: 'wait --gone with --anyOf', argv: ['wait', '--anyOf', 'a', '--anyOf', 'b', '--gone'] },
  { name: 'swipe sideways', argv: ['swipe', 'sideways'] },
  { name: 'swipe --from alone', argv: ['swipe', '--from', '1,2'] },
  { name: 'map build without tsconfig', argv: ['map', 'build'] },
  { name: 'headless start without a token', argv: ['headless', 'start'] },
  { name: 'headless start without jest', argv: ['headless', 'start'], token: true },
  { name: 'fastsim install for windows', argv: ['fastsim', 'install', '--platform', 'windows'] },
  { name: 'case run of a missing file', argv: ['case', 'run', 'missing.md'] },
  { name: 'status offline', argv: ['status', '--offline'] },
  { name: 'help for press', argv: ['press', '--help'] },
];

const quietBase = (root: string): Base => ({
  root,
  config: {},
  attached: true,
  err: () => undefined,
  graph: () => {
    throw new Error('no graph');
  },
  device: async () => {
    throw new Error('no app attached (goldens)');
  },
});

/** Runs an argv with the environment a fresh shell in that folder would give it. */
const outcomeOf = async (argv: string[], root: string, token = false): Promise<unknown> => {
  const { execute } = await mod<Execute>('runtime.js');
  const saved = { token: process.env.LYNKEUS_TOKEN, config: process.env.LYNKEUS_CONFIG, cwd: process.cwd() };
  if (token) process.env.LYNKEUS_TOKEN = 'goldens';
  else delete process.env.LYNKEUS_TOKEN;
  delete process.env.LYNKEUS_CONFIG;
  process.chdir(root);
  try {
    const { code, error, text, json } = await execute(argv, quietBase(root));
    return JSON.parse(without(JSON.stringify({ code, error, text, json }), root));
  } finally {
    if (saved.token === undefined) delete process.env.LYNKEUS_TOKEN;
    else process.env.LYNKEUS_TOKEN = saved.token;
    if (saved.config !== undefined) process.env.LYNKEUS_CONFIG = saved.config;
    process.chdir(saved.cwd);
  }
};

export const probeSurface = async (): Promise<Entries> => {
  const { commands, helpFor, usage } = await loadCli();
  const out: Entries = { usage: usage() };
  const all = commands().sort((a, b) => a.name.localeCompare(b.name));
  out.commands = all.map((c) => `${c.name}${c.aliases?.length ? ` (${c.aliases.join(', ')})` : ''}: ${c.group}, needs ${c.needs}`);
  for (const c of all) out[`help/${c.name}`] = helpFor(c);
  const root = reactNativeProject();
  const [mcp, full] = await Promise.all([mcpSurface(root, false), mcpSurface(root, true)]);
  out['mcp/instructions'] = mcp.instructions;
  for (const tool of mcp.tools as { name: string }[]) out[`mcp/tool/${tool.name}`] = tool;
  out['mcp/full'] = (full.tools as { name: string }[]).map((t) => t.name).sort();
  for (const f of FAILURES) out[`fails/${f.name}`] = await outcomeOf(f.argv, root, f.token);
  fs.rmSync(root, { recursive: true, force: true });
  return out;
};

// ---- (iv) detection -------------------------------------------------------------------------------------------

const TSCONFIG = JSON.stringify({ compilerOptions: { jsx: 'react-jsx', strict: true }, include: ['src'] });
const SHAPES: Record<string, Record<string, string>> = {
  empty: {},
  'react-native dependency': { 'package.json': RN_MANIFEST },
  'react-native dev dependency': { 'package.json': JSON.stringify({ devDependencies: { 'react-native': '0.81.0' } }) },
  'react-native peer dependency': { 'package.json': JSON.stringify({ peerDependencies: { 'react-native': '*' } }) },
  'expo app': { 'package.json': JSON.stringify({ dependencies: { expo: '54.0.0', 'react-native': '0.81.0' } }), 'app.json': '{"expo":{}}' },
  'react-native with tsconfig': { 'package.json': RN_MANIFEST, 'tsconfig.json': TSCONFIG },
  'react-native beside a flutter pubspec': { 'package.json': RN_MANIFEST, 'pubspec.yaml': FLUTTER_PUBSPEC },
  'react-native beside an inline flutter pubspec': { 'package.json': RN_MANIFEST, 'pubspec.yaml': 'name: shop\ndependencies:\n  flutter: { sdk: flutter }\n' },
  'node package, no react-native': { 'package.json': JSON.stringify({ dependencies: { react: '19.1.0' } }) },
  'dart package, not flutter': { 'pubspec.yaml': 'name: tool\ndependencies:\n  args: ^2.0.0\n' },
  'flutter only under dev_dependencies': { 'pubspec.yaml': 'name: tool\ndev_dependencies:\n  flutter_test:\n    sdk: flutter\n' },
  'flutter app': { 'pubspec.yaml': FLUTTER_PUBSPEC },
  'flutter app, inline sdk': { 'pubspec.yaml': 'name: shop\ndependencies:\n  flutter: { sdk: flutter }\n' },
  'flutter app beside a package.json without react-native': {
    'pubspec.yaml': FLUTTER_PUBSPEC,
    'package.json': JSON.stringify({ devDependencies: { prettier: '3' } }),
  },
  'flutter app with a tsconfig': { 'pubspec.yaml': FLUTTER_PUBSPEC, 'tsconfig.json': TSCONFIG },
  'flutter app beside a broken package.json': { 'pubspec.yaml': FLUTTER_PUBSPEC, 'package.json': '{ not json' },
};

/** The runtime the CLI takes each folder for, and what that changes in the commands that branch on it. */
export const probeDetect = async (): Promise<Entries> => {
  await loadCli();
  // main knows one runtime. A CLI that knows more says which one it takes a folder for; what a folder that is not
  // React Native then does is that runtime's business, and only its runtime is kept here.
  const detect = await mod<{ runtimeOf?: (root: string) => string }>('runtimes/index.js').catch(() => ({ runtimeOf: undefined }));
  const legacy = await mod<{ flutterProject?: (root: string) => unknown }>('commands/flutterHost.js').catch(() => ({ flutterProject: undefined }));
  const runtimeOf = (root: string) => detect.runtimeOf?.(root) ?? (legacy.flutterProject?.(root) ? 'flutter' : 'react-native');
  const out: Entries = {};
  for (const [shape, files] of Object.entries(SHAPES)) {
    const fresh = () => {
      const dir = tempDir('lynkeus-goldens-shape-');
      write(dir, files);
      return dir;
    };
    const root = fresh();
    out[`${shape}/runtime`] = runtimeOf(root);
    if (out[`${shape}/runtime`] !== 'react-native') {
      fs.rmSync(root, { recursive: true, force: true });
      continue;
    }
    out[`${shape}/status`] = await outcomeOf(['status', '--offline'], root);
    out[`${shape}/headless start`] = await outcomeOf(['headless', 'start'], root, true);
    if (!files['tsconfig.json']) out[`${shape}/map build`] = await outcomeOf(['map', 'build'], root);
    const initRoot = fresh();
    const init = (await outcomeOf(['init', '--no-install'], initRoot)) as { text?: string };
    out[`${shape}/init`] = { ...init, files: fs.readdirSync(initRoot, { recursive: true }).map(String).sort() };
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(initRoot, { recursive: true, force: true });
  }
  return out;
};

// ---- per-step overhead ----------------------------------------------------------------------------------------

/** A fixed amount of plain work, to express the runner's cost in units of this machine's speed. */
const calibrate = (): number => {
  const t0 = performance.now();
  let acc = 0;
  for (let i = 0; i < 20_000; i++) acc += JSON.stringify({ i, list: [i, i * 2, `x${i}`], nested: { a: i } }).length + JSON.parse(`[${i}]`)[0];
  if (acc < 0) throw new Error('unreachable');
  return performance.now() - t0;
};

/** The runner's own cost per step on a React Native project, against an app that answers at once. */
export const measureStepOverhead = async (): Promise<{ msPerStep: number; calibrationMs: number; units: number }> => {
  await loadCli();
  const { parseCase } = await mod<Format>('cases/format.js');
  const { runCase } = await mod<Runner>('cases/runner.js');
  const { Device } = await mod<{ Device: new (info: unknown, options: unknown) => Device }>('device/driver.js');
  const root = reactNativeProject();
  const lines = Array.from({ length: 1000 }, (_, i) => `  - app.press: "#increment"\n  - app.see: { text: "Count: ${i + 1}" }\n  - app.wait: "#send"`);
  const c = parseCase(`---\nid: budget\n---\nsteps:\n${lines.join('\n')}\n`, 'budget.md');
  const steps = lines.length * 3;
  const once = async () => {
    const clock = new VirtualClock();
    const fake = new FakeApp(clock);
    const device = new Device({ id: 'fake', name: 'Fake', platform: 'ios', type: 'simulator', connected: true }, { server: fake as unknown as AgentServer });
    const base = { ...quietBase(root), device: async () => device };
    clock.install();
    const t0 = performance.now();
    try {
      const report = await runCase(c, { base, config: {} });
      if (report.result !== 'passed' || fake.log.length < steps * 3) throw new Error(`the budget case did not run: ${JSON.stringify(report).slice(0, 400)}`);
    } finally {
      clock.restore();
    }
    return (performance.now() - t0) / steps;
  };
  await once();
  const runs: number[] = [];
  const calibrations: number[] = [];
  for (let i = 0; i < 7; i++) {
    calibrations.push(calibrate());
    runs.push(await once());
  }
  fs.rmSync(root, { recursive: true, force: true });
  // The fastest of each: a machine busy with other work only ever adds time, so the minimum is the cost itself.
  const msPerStep = Math.min(...runs);
  const calibrationMs = Math.min(...calibrations);
  return { msPerStep, calibrationMs, units: msPerStep / calibrationMs };
};

/** The per-step cost measured by bench.ts in a fresh process. */
export const benchStepOverhead = (): { msPerStep: number; calibrationMs: number; units: number } =>
  JSON.parse(
    execFileSync(process.execPath, ['--import', import.meta.resolve('tsx'), path.join(path.dirname(fileURLToPath(import.meta.url)), 'bench.ts')], {
      encoding: 'utf8',
    }),
  );

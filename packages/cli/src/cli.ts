#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import { AgentServer } from 'lynkeus-client';
import type { HelloEvent } from 'lynkeus-protocol';

import { GLOBAL_FLAGS } from './args.js';
import { caseCommands } from './commands/cases.js';
import { driveCommands } from './commands/drive.js';
import { headlessCommands } from './commands/headless.js';
import { mapCommands } from './commands/map.js';
import { osCommands } from './commands/os.js';
import { ciCommands } from './commands/ci.js';
import { coverageCommands } from './commands/coverage.js';
import { fixturesCommands } from './commands/fixtures.js';
import { reportCommands } from './commands/report.js';
import { fastsimCommands } from './commands/fastsim.js';
import { loginCommands } from './commands/login.js';
import { relayCommands } from './commands/relay.js';
import { runsCommands } from './commands/runs.js';
import { configReader, edgesFile, graphFile, loadGraph, portFromEnv, readToken } from './config.js';
import { agentMismatch, appSwitched, helloIdentity } from './device/agentVersion.js';
import { devMenuOnAttach } from './device/devMenu.js';
import { HEADLESS_HOST, pickAgentDevice, pickAndroidDevice, reverseAndroid } from './device/devices.js';
import { Device } from './device/driver.js';
import * as edges from './knowledge/edges.js';
import { walk } from './knowledge/walk.js';
import { type Base, commands, find, helpFor, inSession, referenceMarkdown, register, resolve, usage } from './registry.js';
import { execute } from './runtime.js';

register([
  ...driveCommands,
  ...osCommands,
  ...mapCommands,
  ...runsCommands,
  ...caseCommands,
  ...coverageCommands,
  ...ciCommands,
  ...fixturesCommands,
  ...reportCommands,
  ...relayCommands,
  ...fastsimCommands,
  ...loginCommands,
  ...headlessCommands,
]);

/** The global flags, read leniently from the whole argv before any command parses its own. */
const globals = (argv: string[]) => {
  const out: Record<string, string | boolean | undefined> = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!;
    if (t === '--') break;
    if (!t.startsWith('--')) continue;
    const name = t.slice(2).split('=')[0]!;
    const spec = GLOBAL_FLAGS[name];
    if (!spec) continue;
    if (spec.type === 'boolean') out[name] = true;
    else out[name] = t.includes('=') ? t.slice(t.indexOf('=') + 1) : argv[i + 1];
  }
  return out;
};

export type Session = { ctx: Base; stop: () => Promise<void> };

// Once per process: a suite reattaches for every case.
let mismatchTold = false;
let switchTold = false;
let lastApp: string | undefined;

// `ownHost`: the port belongs to a host this run started for a case; whatever dials in is the device.
const contextFor = (argv: string[], attached = false, port?: number, ownHost = false): Session => {
  const g = globals(argv);
  const root = path.resolve((g.root as string | undefined) ?? process.cwd());
  const currentConfig = configReader(root);
  currentConfig();
  const err = (line: string) => console.error(line);
  // Read again when the file changes: a long session outlives a graph rebuilt because the source changed.
  let graph: { read: ReturnType<typeof loadGraph>; mtimeMs: number } | undefined;
  let device: Promise<Device> | undefined;
  // Every press this connection makes and sees land somewhere new is one more edge for map plan and case new.
  const learning = (d: Device) => {
    d.learn(walk((edge) => edges.append(edgesFile(root), edge)));
    return d;
  };

  const connect = async (): Promise<Device> => {
    const appId = (g.app as string | undefined) ?? process.env.LYNKEUS_APP_ID ?? currentConfig().app;
    const started = performance.now();
    const attachedIn = (d: Device) => err(`attached in ${Math.round(performance.now() - started)}ms (${d.info.name})`);
    const server = new AgentServer({ token: readToken(root), port: port ?? portFromEnv(currentConfig()) });
    server.on('hello', (hello: HelloEvent) => {
      const identity = helloIdentity(hello);
      const switched = switchTold ? undefined : appSwitched(lastApp, identity, server.port);
      lastApp = identity;
      if (switched) {
        switchTold = true;
        err(switched);
      }
      const told = mismatchTold ? undefined : agentMismatch(hello);
      if (!told) return;
      mismatchTold = true;
      err(told);
    });
    // A host started for the case is the device: looking for the configured simulator would only replace a
    // late app's error with one about a simulator nobody asked for.
    const wantedDevice = (g.device as string | undefined) ?? process.env.LYNKEUS_DEVICE ?? currentConfig().device;
    const picking = ownHost ? Promise.resolve(HEADLESS_HOST) : pickAgentDevice(wantedDevice);
    if (g.launch && appId) {
      const d = learning(new Device(await picking, { appId, server }));
      await d.launchApp(appId, { fresh: true });
      attachedIn(d);
      return d;
    }
    // Asking the OS which simulators are up takes longer than the app takes to dial in, so listen first.
    picking.catch(() => undefined);
    await server.listen();
    if (!ownHost) void reverseAndroid(server.port);
    const hello = await server
      .waitForApp(Number(g['attach-timeout'] ?? process.env.LYNKEUS_ATTACH_TIMEOUT_MS ?? currentConfig().attachTimeout ?? 15000))
      .catch(async (error) => {
        await server.close();
        await picking;
        throw error;
      });
    const headless = hello.app?.runtime === 'headless';
    const info = {
      ...HEADLESS_HOST,
      name: headless ? HEADLESS_HOST.name : String(hello.app?.name ?? hello.platform),
      platform: hello.platform === 'android' ? ('android' as const) : ('ios' as const),
    };
    // The app says which platform it runs on; only then is it known whether simctl or adb names its device.
    const resolving = headless || ownHost ? undefined : info.platform === 'android' ? pickAndroidDevice(wantedDevice) : picking;
    const d = learning(new Device(info, { appId: appId ?? null, server, resolving }));
    attachedIn(d);
    if (resolving) void resolving.then((on) => devMenuOnAttach(root, appId, on, err)).catch(() => undefined);
    return d;
  };

  const ctx: Base = {
    root,
    // A getter: a server that outlives the agent's edits to lynkeus.config.json sees the file as it is now.
    get config() {
      return currentConfig();
    },
    attached,
    err,
    graph: () => {
      const mtimeMs = fs.statSync(graphFile(root), { throwIfNoEntry: false })?.mtimeMs ?? 0;
      if (graph?.mtimeMs !== mtimeMs) graph = { read: loadGraph(root), mtimeMs };
      if (!graph.read) throw new Error(`No graph at ${graphFile(root)}: run \`lynkeus map build\` in the app's folder first.`);
      return graph.read;
    },
    device: () => {
      // A connection that failed (no app yet) is tried again on the next command: a session outlives an app that was late.
      device ??= connect().catch((error: unknown) => {
        device = undefined;
        throw error;
      });
      return device;
    },
    forPort: (other) => {
      const scoped = contextFor(argv, attached, other, true);
      return { base: scoped.ctx, stop: scoped.stop };
    },
  };
  return {
    ctx,
    stop: async () => {
      if (!device) return;
      await device.then((d) => d.stop()).catch(() => undefined);
      edges.fold(edgesFile(root));
    },
  };
};

/** Each stdin line is a JSON array of arguments (`["press", "#x"]`); each answer is one JSON line. */
const session = async (argv: string[]) => {
  const { ctx, stop } = contextFor(argv, true);
  const device = await ctx.device();
  console.log(JSON.stringify({ ok: true, out: `attached (${device.info.name})` }));
  for await (const line of readline.createInterface({ input: process.stdin })) {
    if (!line.trim()) continue;
    let av: string[];
    try {
      av = JSON.parse(line) as string[];
    } catch {
      console.log(JSON.stringify({ ok: false, error: 'each line must be a JSON array of arguments' }));
      continue;
    }
    if (av[0] === 'exit') break;
    const found = resolve(av)?.command;
    if (found && !inSession(found)) {
      console.log(JSON.stringify({ ok: false, error: `${found.name} is not available in a session` }));
      continue;
    }
    const r = await execute(av, ctx);
    console.log(
      JSON.stringify(
        r.error
          ? { ok: false, error: r.error, ...(r.why ? { why: r.why } : {}) }
          : { ok: r.code === 0, out: r.text ?? '', ...(r.json !== undefined ? { json: r.json } : {}) },
      ),
    );
  }
  await stop();
};

const help = (argv: string[]) => {
  if (argv.includes('--markdown')) return referenceMarkdown();
  const topic = argv
    .slice(1)
    .filter((a) => !a.startsWith('--'))
    .join(' ');
  if (!topic) return usage();
  const c = find(topic);
  return c ? helpFor(c) : `no command "${topic}"\n\n${usage()}`;
};

const main = async () => {
  const argv = process.argv.slice(2);
  const [first] = argv;
  if (!first || first === 'help' || first === '--help') return console.log(help(argv));
  if (first === 'commands')
    return console.log(
      commands()
        .map((c) => c.name)
        .join('\n'),
    );
  if (first === 'mcp') {
    const { serve } = await import('./mcp/server.js');
    return serve(contextFor(argv, true), { full: argv.includes('--full') });
  }
  if (first === 'session') {
    await session(argv);
    return process.exit(0);
  }
  const { ctx, stop } = contextFor(argv);
  const outcome = await execute(argv, ctx);
  if (outcome.error) {
    console.error(`✗ ${outcome.error}`);
    if (outcome.why) console.error(`why:\n${outcome.why}`);
  } else if (globals(argv).json && outcome.json !== undefined) console.log(JSON.stringify(outcome.json, null, 2));
  else if (outcome.text) console.log(outcome.text);
  await stop();
  process.exit(outcome.code);
};

void main();

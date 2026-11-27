/**
 * Runs one command from an argv: resolve, parse, run, and on failure read the
 * evidence. The terminal, session lines, a recording's stdin, cases and the
 * MCP server all come through here.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { AgentServer } from 'lynkeus-client';

import { UsageError } from './args.js';
import { graphFile, saveGraph } from './config.js';
import { readJson } from './files.js';
import type { ScreenGraph } from './knowledge/types.js';
import { describeWhy, explain } from './knowledge/why.js';
import { type Base, helpFor, parseFor, resolve } from './registry.js';
import { runtimeAt } from './runtimes/index.js';
import { type Expected, expectedOf } from './targets.js';

export type Outcome = { text?: string; json?: unknown; code: number; error?: string; why?: string };

/**
 * Why the app cannot answer now, worded to stand alone: gone, or a phone's app behind another one (suspended, its
 * socket open and silent); undefined when it can. A host keeps answering in the background, so only a phone counts.
 */
export const unreachable = (server: Partial<Pick<AgentServer, 'gone' | 'appState' | 'hello'>> | undefined): string | undefined => {
  if (server?.gone) return 'the app is gone (crashed or closed)';
  if (server?.appState === 'background' && onPhone(server)) return 'the app went to the background (another app is in front)';
  return undefined;
};

/** A simulator, an emulator or a phone, where the OS puts other apps in front; a host stands in for the OS and never does. */
export const onPhone = (server: Partial<Pick<AgentServer, 'hello'>> | undefined): boolean =>
  server?.hello?.native === true && !server.hello.commands?.includes('clock');

/**
 * What is in front of the app when the OS put something there, said to stand alone; undefined while the app is.
 * `opened` is a URL the app handed the OS, which names what came up.
 */
export const awayNote = (server: Partial<Pick<AgentServer, 'appState' | 'hello'>> | undefined, opened?: string): string | undefined => {
  if (!onPhone(server)) return undefined;
  const state = server?.appState;
  if (state !== 'background' && state !== 'inactive') return undefined;
  const back = 'what it lists is not what is on screen; bring it back with os appstate active, or relaunch it';
  if (opened)
    return `the app went to the background: it opened ${opened}, and ${/^https?:/i.test(opened) ? 'the browser' : 'another app'} is in front; ${back}`;
  if (state === 'inactive') return `the app is inactive: a system screen is in front of it (a permission prompt, Control Center); ${back}`;
  return `the app went to the background: another app or a system screen is in front; ${back}`;
};

/**
 * What `why` reads about on a port: the last case or command that ran there, so a failure from before it (a probe the
 * app did not know, a step of an earlier case) is not given as its cause. `since` is the app's trace sequence at its
 * start, where known; `failed` the step or command that failed, with its own error.
 */
export type WhyScope = { at: number; since?: number; case?: string; failed?: string };
const scopes = new Map<number | undefined, WhyScope>();
export const scopeWhy = (port: number | undefined, scope: WhyScope): void => {
  scopes.set(port, scope);
};
export const whyScope = (port: number | undefined): WhyScope | undefined => scopes.get(port);

type Printed = { at: number; level: string; text: string };
// A run that keeps the console takes it from the app after each step: the lines it took are kept here a while, so
// `why` still reads what the app logged during the step before (where a fetch whose body it could not use failed).
const printed = new Map<number | undefined, Printed[]>();
const PRINTED_KEPT = 200;
export const notePrinted = (port: number | undefined, lines: Printed[]): void => {
  if (lines.length) printed.set(port, [...(printed.get(port) ?? []), ...lines].slice(-PRINTED_KEPT));
};

// What the app logged from `startedAt` on: lines a run already took, and those the app still holds (read, not taken).
const printedSince = async (device: Awaited<ReturnType<Base['device']>>, startedAt: number | undefined): Promise<Printed[]> => {
  const held = device.server.hello?.commands?.includes('logs')
    ? await device.command('logs').then(
        (raw) =>
          (Array.isArray(raw) ? (raw as Partial<Printed>[]) : []).flatMap((l) =>
            typeof l?.text === 'string' && typeof l.at === 'number' ? [{ at: l.at, level: String(l.level ?? 'info'), text: l.text }] : [],
          ),
        () => [],
      )
    : [];
  const all = [...(printed.get(device.server.port) ?? []), ...held];
  const unique = all.filter((l, i) => all.findIndex((o) => o.at === l.at && o.text === l.text) === i);
  return fromStart(unique, startedAt, (l) => l.at);
};

/**
 * The screen, requests and trace after a failure, read as rules; empty when there is nothing to read. Only what
 * happened from `startedAt` on (from trace sequence `since` on, where given) counts.
 */
export const whyFor = async (base: Base, expected?: Expected, startedAt?: number, since?: number): Promise<string> => {
  try {
    const device = await base.device();
    // Each read would wait out its whole timeout.
    const away = unreachable(device.server);
    if (away) return `  • ${away}: nothing on its screen can be read`;
    const [screen, requests, trace] = await Promise.all([device.screen(), device.requests(), device.trace(since)]);
    const sourceDiff = expected?.text ? uncommittedDiff(base.root) : undefined;
    const during = duringCommand(requests.requests, startedAt);
    const logs = await printedSince(device, startedAt).catch(() => []);
    const events = since === undefined ? fromStart(trace.events, startedAt, (e) => e.t) : trace.events;
    return describeWhy(
      explain({
        screen,
        requests: during.slice(-40),
        inFlight: requests.inFlight,
        pending: requests.requests.filter((r) => r.status === undefined && !r.error),
        now: Date.now(),
        trace: events.slice(-40),
        target: expected,
        fetchedBefore: during.length < requests.requests.length,
        ...(sourceDiff ? { sourceDiff } : {}),
        ...(logs.length ? { logs: logs.slice(-40) } : {}),
      }),
    );
  } catch {
    return '';
  }
};

/** The app folder's uncommitted changes, staged or not, with no context lines; undefined outside a git checkout or when git is slow. */
const uncommittedDiff = (root: string): string | undefined => {
  try {
    return execFileSync('git', ['diff', '-U0', '--no-color', '--no-ext-diff', '--relative', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 3000,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined;
  }
};

/**
 * The requests made while the failed command ran, and a little before: a 403 from minutes ago is not why a wait
 * failed now. Only when the app's clock reads like this machine's (a simulator, an emulator); a host on a clock of
 * its own keeps them all.
 */
export const duringCommand = <R extends { startedAt: number }>(requests: R[], startedAt: number | undefined, now = Date.now()): R[] =>
  fromStart(requests, startedAt, (r) => r.startedAt, now);

const fromStart = <T>(items: T[], startedAt: number | undefined, at: (item: T) => number, now = Date.now()): T[] => {
  if (startedAt === undefined || items.length === 0) return items;
  const latest = Math.max(...items.map(at));
  if (Math.abs(latest - now) > 10 * 60_000) return items;
  return items.filter((item) => at(item) >= startedAt - 3000);
};

const TARGET_ARG: Record<string, number> = { press: 0, see: 0, wait: 0, swipe: 1, nav: 0, type: 1 };

const portOf = async (base: Base): Promise<number | undefined> => (await base.device().catch(() => undefined))?.server?.port;

/**
 * Whether a source file the graph was read from changed after it, or a folder holding one gained or lost a file (a
 * new screen in an Expo Router app is a new file, with no edit anywhere else). Stats only, no parse.
 */
export const graphStale = (root: string, graph: Pick<ScreenGraph, 'files'>, builtMs: number): boolean => {
  const folders = new Set<string>();
  for (const file of Object.keys(graph.files)) {
    const at = path.join(root, file);
    folders.add(path.dirname(at));
    const stat = fs.statSync(at, { throwIfNoEntry: false });
    if (!stat || stat.mtimeMs > builtMs) return true;
  }
  for (const folder of folders) if ((fs.statSync(folder, { throwIfNoEntry: false })?.mtimeMs ?? 0) > builtMs) return true;
  return false;
};

/**
 * A command that reads the route graph builds it when there is none and again when the source changed since, instead
 * of failing or answering from an old map: no agent or person has to remember `map build`, and `case new` after an
 * edit to the app already knows its new screen. Any runtime whose routes can be read here gets one.
 */
const graphFirst = async (root: string, required: boolean): Promise<void> => {
  const file = graphFile(root);
  const builtMs = fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs;
  const had = builtMs === undefined ? undefined : readJson<ScreenGraph>(file);
  // A graph with no screen is read again: the navigators may have been added since, or found by a newer Lynkeus.
  if (had && builtMs !== undefined && Object.keys(had.screens ?? {}).length > 0 && !graphStale(root, had, builtMs)) return;
  const runtime = await runtimeAt(root);
  if (runtime.graphMissing(root)) return;
  const graph = await runtime.buildGraph(root);
  saveGraph(root, graph);
  // A command about screens on an empty map would answer as if the app had none: say why instead.
  if (required && Object.keys(graph.screens).length === 0)
    throw new Error(`the route map is empty: ${graph.warnings[0] ?? 'no screen was found in the source'}`);
};

export const execute = async (argv: string[], base: Base): Promise<Outcome> => {
  const found = resolve(argv);
  if (!found) return { code: 2, error: `unknown command "${argv.slice(0, 2).join(' ')}"; \`lynkeus help\` lists them` };
  const { command, rest } = found;
  let parsed: ReturnType<typeof parseFor>;
  try {
    parsed = parseFor(command, rest);
  } catch (error) {
    if (error instanceof UsageError) return { code: 2, error: `${error.message}\n\n${helpFor(command)}` };
    throw error;
  }
  if (parsed.flags.help) return { code: 0, text: helpFor(command) };
  const startedAt = Date.now();
  try {
    if (command.needs === 'graph' || command.readsGraph) await graphFirst(base.root, command.needs === 'graph');
    const result = await command.run({ ...base, ...parsed });
    if (TARGET_ARG[command.name] !== undefined) scopeWhy(await portOf(base), { at: startedAt });
    if (result === undefined) return { code: 0 };
    if (typeof result === 'string') return { code: 0, text: result };
    return { code: result.code ?? 0, text: result.text ?? (result.json === undefined ? undefined : JSON.stringify(result.json)), json: result.json };
  } catch (error) {
    const out: Outcome = { code: 1, error: error instanceof Error ? error.message : String(error) };
    const at = TARGET_ARG[command.name];
    if (at !== undefined) {
      scopeWhy(await portOf(base), { at: startedAt, failed: `${argv.join(' ')}: ${out.error}` });
      const why = await whyFor(base, expectedOf(parsed.args[at]), startedAt);
      if (why) out.why = why;
    }
    return out;
  }
};

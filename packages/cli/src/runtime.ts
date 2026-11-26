/**
 * Runs one command from an argv: resolve, parse, run, and on failure read the
 * evidence. The terminal, session lines, a recording's stdin, cases and the
 * MCP server all come through here.
 */
import fs from 'node:fs';

import { UsageError } from './args.js';
import { graphFile } from './config.js';
import { readJson, writeJson } from './files.js';
import type { ScreenGraph } from './knowledge/types.js';
import { describeWhy, explain } from './knowledge/why.js';
import { type Base, helpFor, parseFor, resolve } from './registry.js';
import { runtimeAt } from './runtimes/index.js';
import { type Expected, expectedOf } from './targets.js';

export type Outcome = { text?: string; json?: unknown; code: number; error?: string; why?: string };

/** The screen, requests and trace after a failure, read as rules; empty when there is nothing to read. */
export const whyFor = async (base: Base, expected?: Expected, startedAt?: number): Promise<string> => {
  try {
    const device = await base.device();
    const [screen, requests, trace] = await Promise.all([device.screen(), device.requests(), device.trace()]);
    const during = duringCommand(requests.requests, startedAt);
    return describeWhy(
      explain({
        screen,
        requests: during.slice(-40),
        inFlight: requests.inFlight,
        pending: requests.requests.filter((r) => r.status === undefined && !r.error),
        now: Date.now(),
        trace: trace.events.slice(-40),
        target: expected,
        fetchedBefore: during.length < requests.requests.length,
      }),
    );
  } catch {
    return '';
  }
};

/**
 * The requests made while the failed command ran, and a little before: a 403 from minutes ago is not why a wait
 * failed now. Only when the app's clock reads like this machine's (a simulator, an emulator); a host on a clock of
 * its own keeps them all.
 */
export const duringCommand = <R extends { startedAt: number }>(requests: R[], startedAt: number | undefined, now = Date.now()): R[] => {
  if (startedAt === undefined || requests.length === 0) return requests;
  const latest = Math.max(...requests.map((r) => r.startedAt));
  if (Math.abs(latest - now) > 10 * 60_000) return requests;
  return requests.filter((r) => r.startedAt >= startedAt - 3000);
};

const TARGET_ARG: Record<string, number> = { press: 0, see: 0, wait: 0, swipe: 1, nav: 0, type: 1 };

/**
 * A command that reads the route graph builds it the first time instead of failing: the first run of `case new` or
 * `smoke` in a new project needs no `map build` before it. Any runtime whose routes can be read here gets one.
 */
const graphFirst = async (root: string, required: boolean): Promise<void> => {
  const file = graphFile(root);
  // A graph with no screen is read again: the navigators may have been added since, or found by a newer Lynkeus.
  if (fs.existsSync(file) && Object.keys(readJson<ScreenGraph>(file).screens ?? {}).length > 0) return;
  const runtime = await runtimeAt(root);
  if (runtime.graphMissing(root)) return;
  const graph = await runtime.buildGraph(root);
  writeJson(file, graph);
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
    if (result === undefined) return { code: 0 };
    if (typeof result === 'string') return { code: 0, text: result };
    return { code: result.code ?? 0, text: result.text ?? (result.json === undefined ? undefined : JSON.stringify(result.json)), json: result.json };
  } catch (error) {
    const out: Outcome = { code: 1, error: error instanceof Error ? error.message : String(error) };
    const at = TARGET_ARG[command.name];
    if (at !== undefined) {
      const why = await whyFor(base, expectedOf(parsed.args[at]), startedAt);
      if (why) out.why = why;
    }
    return out;
  }
};

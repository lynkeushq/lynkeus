import { createRequire } from 'node:module';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import type { FlagSpec } from '../args.js';
import { type ProgressEvent, RunState, statusLine } from '../cases/progress.js';
import type { Session } from '../cli.js';
import { type Command, commands, overMcp } from '../registry.js';
import { execute } from '../runtime.js';
import { TARGET_HELP } from '../targets.js';

const text = (body: string) => ({ content: [{ type: 'text' as const, text: body }] });

type Property = { type: string; items?: { type: string }; enum?: string[]; description: string };

const propertyFor = (f: FlagSpec, mcpDefault?: number | string | boolean): Property => {
  const fallback = mcpDefault ?? f.default;
  return {
    type: f.type === 'list' ? 'array' : f.type,
    ...(f.type === 'list' ? { items: { type: 'string' } } : {}),
    description: f.help + (fallback !== undefined ? ` (default ${fallback})` : ''),
  };
};

const describe = (c: Command) => {
  const details = c.mcpDetails ?? c.details;
  return details ? `${c.summary}\n\n${details}` : c.summary;
};

const identifier = (name: string) => name.replace(/[^a-z0-9]+/gi, '_');

type Progress = { progress: number; total?: number; message?: string };

/**
 * A run's events as MCP progress notifications, for a client that asked with a progress token: the cases done,
 * plus how far the running ones are through their steps, out of the cases in the run, with the live line as the
 * message. The value only ever grows, as MCP asks; a step that would not move it sends nothing. `beat` says the line
 * again with the value a hair higher, so a step that runs long still shows the run is alive (false before the run
 * started).
 */
export const progressNotifier = (send: (params: Progress) => void) => {
  const state = new RunState();
  let last = -1;
  let started = false;
  const notify = (event: ProgressEvent) => {
    state.apply(event);
    if (event.type === 'run-start') started = true;
    const s = state.status();
    const partial = s.running.reduce((sum, r) => sum + (r.step ? (r.step.index + 1) / Math.max(1, r.steps) : 0), 0);
    const progress = Math.round((s.done + Math.min(partial, s.running.length * 0.99)) * 100) / 100;
    if (progress <= last) return;
    last = progress;
    send({ progress, ...(s.total ? { total: s.total } : {}), message: statusLine(s) });
  };
  const beat = (): boolean => {
    if (!started) return false;
    const s = state.status();
    last = Math.round((Math.max(last, 0) + 0.001) * 1000) / 1000;
    send({ progress: last, ...(s.total ? { total: s.total } : {}), message: statusLine(s) });
    return true;
  };
  return Object.assign(notify, { beat });
};

/**
 * A job's lines as MCP progress notifications: no total to count against, so the value counts the lines, and only
 * grows. `beat` repeats the last line with how long the job has run.
 */
export const jobNotifier = (send: (params: { progress: number; message: string }) => void, startedAt = Date.now()) => {
  let n = 0;
  let said: string | undefined;
  const notify = (message: string) => {
    said = message;
    send({ progress: ++n, message });
  };
  const beat = (name: string) => send({ progress: ++n, message: `${said ?? name}: still running, ${Math.round((Date.now() - startedAt) / 1000)} s in` });
  return Object.assign(notify, { beat });
};

/** MCP wants each notification of a call to carry a larger value than the one before, whoever sends it. */
export const growing = (send: (params: Progress) => void) => {
  let last = -Infinity;
  return (params: Progress) => {
    const progress = params.progress > last ? params.progress : Math.round((last + 0.001) * 1000) / 1000;
    last = progress;
    send({ ...params, progress });
  };
};

// Clients give up on a call that says nothing for a while (Claude Code after about 30 minutes in trial 7, with a
// step stuck for 31 of them): a long command says it is alive at least this often.
export const HEARTBEAT_MS = 20_000;

// Written by hand: a schema library adds fields to every tool that a model pays for on every turn.
export const schemaFor = (c: Command) => {
  const properties: Record<string, Property> = {};
  const required: string[] = [];
  for (const p of c.positionals ?? []) {
    const key = identifier(p.name);
    properties[key] = p.rest
      ? { type: 'array', items: { type: 'string' }, description: p.help }
      : { type: 'string', ...(p.choices ? { enum: p.choices } : {}), description: p.help };
    if (p.required) required.push(key);
  }
  for (const [name, f] of Object.entries(c.flags ?? {})) if (!c.mcpOmit?.includes(name)) properties[identifier(name)] = propertyFor(f, c.mcpDefaults?.[name]);
  return { type: 'object' as const, properties, ...(required.length ? { required } : {}) };
};

/** Back to an argv, so the same runtime serves both surfaces. */
export const argvFor = (c: Command, given: Record<string, unknown>): string[] => {
  const defaults = Object.entries(c.mcpDefaults ?? {}).map(([name, value]) => [identifier(name), value]);
  const input: Record<string, unknown> = { ...Object.fromEntries(defaults), ...given };
  const av = c.name.split(' ');
  for (const p of c.positionals ?? []) {
    const v = input[identifier(p.name)];
    if (v === undefined) continue;
    if (Array.isArray(v)) av.push(...v.map(String));
    else av.push(String(v));
  }
  for (const [name, f] of Object.entries(c.flags ?? {})) {
    const v = input[identifier(name)];
    if (v === undefined) continue;
    if (f.type === 'boolean') {
      if (v) av.push(`--${name}`);
    } else if (f.type === 'list') for (const item of v as string[]) av.push(`--${name}`, item);
    else av.push(`--${name}`, String(v));
  }
  return av;
};

// What a model is told once, when it connects: the order things are done in, so "set Lynkeus up" and "write me
// a test for this" need nothing more from the person asking.
const INSTRUCTIONS = `Lynkeus drives a React Native app (bare or Expo) by what is on its screen, through lynkeus-agent inside it, and runs cases: markdown files of readable steps.

Prefer the one-call jobs to driving builds, Metro and devices through your shell: setup connects an app from scratch (init, the device, Metro, the development build, launch, attach, status; safe to re-run), case_run with on: targets and brief runs a suite on the project's targets, evidence runs it with frames, film and report.html. Each answers a few lines and keeps its logs in files: open one only when the answer points at it. If your client can run a task in a separate context, give it the one-call jobs and keep only their summaries. In a project you do not know, call status first. With no device: headless_init, headless_doctor, then case_run with host (the backend must be local: apiUrl in lynkeus.config.json).

To write cases, spend tokens in this order and stop as soon as you know enough:
1. case_coverage: the app's screens and which no case reaches yet.
2. case_new with the screen: a draft with the way there (an existing case's steps when one reaches it), the backend setup to pick from and the checks left to write. Keep the way it offers; steps several cases open with belong in a macro (case_coverage names it). On the screen already, case_here drafts from what is shown; map_plan answers the way between two screens.
3. No known way to the screen: crawl from the nearest one.
4. Only then drive the app (press, type, wait; press with settle: true answers with the settled screen) and call screen to fill what the draft could not know. Prefer testIDs (#id) over texts. Read the app's source only for what the screen cannot tell.
5. Write the case as a markdown file in the cases folder (case_init writes it once, with a README.md of the format) and run it with case_run. A failed step comes back with its error and screen; why explains it. Fix the case or report the app's bug, never weaken the check.
6. A case is done when one case_run with on: targets passes it on the project's targets (cases.targets in lynkeus.config.json; a case's own targets: frontmatter overrides them). Run nowhere else. If the project declares none, ask the person which targets matter (status proposes a value). Write it where it is cheapest among them.

After changing the app's code, or to review a branch: case_impact with base lists the cases the changes reach; run those and fix what broke.

Lynkeus boots only a device the project names (setup says when it does) and never closes one: when you are done, shut down the Simulators and emulators you or setup booted (xcrun simctl shutdown <udid>, adb -s <serial> emu kill), never one that was already running.

A native module or value the app reads that nobody provides is answered empty (headless) or guessed (FastSim), and each run lists it: tell the person; when that changes what the app shows, giving it a real answer in cases.nativeMocks is their decision.

Lynkeus FastSim is optional and paid (Team plan): use it when the person asks or their organization has it. When the service refuses (no plan, no seat, no key), tell the person what it said and carry on with headless or a device; never retry with other credentials.

Everything else is in the guide tool: a topic lists its sections, topic and section answer one. Read a section when the task reaches it, not up front. Topics: cases (format, text matching, steps, app commands, macros, on: blocks, interruptions, mocks, app.relaunch), targets (cases.targets, on: targets, headless, FastSim, jobs), evidence (out, film, report.html, sharing, reading a failure), ci, determinism, troubleshooting. Clients that load Agent Skills have the same text as the Lynkeus skill.`;

export const serve = async (session: Session, options: { full?: boolean } = {}) => {
  const { version } = createRequire(import.meta.url)('../../package.json') as { version: string };
  const server = new Server({ name: 'lynkeus', version }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  const served = commands().filter((c) => overMcp(c, !!options.full));
  const byName = new Map(served.map((c) => [identifier(c.name), c]));
  // So a model reading the app's screens knows their language before it starts guessing.
  const { config } = session.ctx;
  const locale = config.language || config.locale ? JSON.stringify({ language: config.language, ...config.locale }, null, 2) : undefined;

  // The grammar of a target is spelled where a model meets it first; after that it is a word.
  let spelled = false;
  const once = (help: string) => {
    if (!help.includes(TARGET_HELP)) return help;
    const out = spelled ? help.replace(TARGET_HELP, 'target') : help;
    spelled = true;
    return out;
  };
  const tools = served.map((c) => {
    const schema = schemaFor(c);
    for (const property of Object.values(schema.properties)) property.description = once(property.description);
    return { name: identifier(c.name), description: describe(c), inputSchema: schema };
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...(locale
        ? [
            {
              name: 'app_locale',
              description: 'The language and region this app is built for, as its own configuration declares them.',
              inputSchema: { type: 'object' as const, properties: {} },
            },
          ]
        : []),
      ...tools,
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (request.params.name === 'app_locale' && locale) return text(locale);
    const c = byName.get(request.params.name);
    if (!c) return { ...text(`✗ no tool ${request.params.name}`), isError: true };
    const input = (request.params.arguments ?? {}) as Record<string, unknown>;
    // An argument the tool does not take is dropped by argvFor; a run would then go on without it (every case
    // instead of the one named), so it is refused, with what the tool does take.
    const known = Object.keys(schemaFor(c).properties);
    const unknown = Object.keys(input).filter((key) => !known.includes(key));
    if (unknown.length)
      return { ...text(`✗ ${request.params.name} takes no ${unknown.join(', ')}; it takes ${known.join(', ') || 'no arguments'}`), isError: true };
    // A client that passed a progress token hears how a long command (a case run) goes while it runs.
    const token = request.params._meta?.progressToken;
    // A client that cancels the call (notifications/cancelled) stops a long command with it: a case run ends its
    // case, stops its hosts and lets go of its port instead of running on unseen.
    const send = growing((params) => {
      void extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token!, ...params } }).catch(() => undefined);
    });
    const progress = token === undefined ? undefined : progressNotifier(send);
    const notify = token === undefined ? undefined : jobNotifier(send);
    const ctx = { ...session.ctx, signal: extra.signal, ...(progress && notify ? { progress, notify } : {}) };
    // Between a run's events (a step that waits a long time) and a job's lines (a build), the call still says it is alive.
    const heartbeat = progress && notify ? setInterval(() => progress.beat() || notify.beat(c.name), HEARTBEAT_MS) : undefined;
    heartbeat?.unref();
    const r = await execute(argvFor(c, input), ctx).finally(() => clearInterval(heartbeat));
    if (r.error) return { ...text(`✗ ${r.error}${r.why ? `\n\nwhy:\n${r.why}` : ''}`), isError: true };
    const body = text(r.text || (r.json !== undefined ? JSON.stringify(r.json, null, 2) : 'ok'));
    // A command that ended with a non-zero code (a failed case, a server that does not keep the contract) is
    // reported as such, with everything it said, so a model does not read it as success.
    return r.code === 0 ? body : { ...body, isError: true };
  });
  // The client going away ends the server: the session holds the driver's port open, and a server left behind
  // keeps the next one (or a case run) from binding it.
  const transport = new StdioServerTransport();
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void session
      .stop()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };
  process.stdin.once('end', stop);
  process.stdin.once('close', stop);
  transport.onclose = stop;
  await server.connect(transport);
};

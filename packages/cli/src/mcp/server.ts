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

type Property = { type: string; items?: { type: string }; description: string };

const propertyFor = (f: FlagSpec): Property => ({
  type: f.type === 'list' ? 'array' : f.type,
  ...(f.type === 'list' ? { items: { type: 'string' } } : {}),
  description: f.help + (f.default !== undefined ? ` (default ${f.default})` : ''),
});

const describe = (c: Command) => {
  const details = c.mcpDetails ?? c.details;
  return details ? `${c.summary}\n\n${details}` : c.summary;
};

const identifier = (name: string) => name.replace(/[^a-z0-9]+/gi, '_');

/**
 * A run's events as MCP progress notifications, for a client that asked with a progress token: the cases done,
 * plus how far the running ones are through their steps, out of the cases in the run, with the live line as the
 * message. The value only ever grows, as MCP asks; a step that would not move it sends nothing.
 */
export const progressNotifier = (send: (params: { progress: number; total?: number; message?: string }) => void) => {
  const state = new RunState();
  let last = -1;
  return (event: ProgressEvent) => {
    state.apply(event);
    const s = state.status();
    const partial = s.running.reduce((sum, r) => sum + (r.step ? (r.step.index + 1) / Math.max(1, r.steps) : 0), 0);
    const progress = Math.round((s.done + Math.min(partial, s.running.length * 0.99)) * 100) / 100;
    if (progress <= last) return;
    last = progress;
    send({ progress, ...(s.total ? { total: s.total } : {}), message: statusLine(s) });
  };
};

// Written by hand: a schema library adds fields to every tool that a model pays for on every turn.
export const schemaFor = (c: Command) => {
  const properties: Record<string, Property> = {};
  const required: string[] = [];
  for (const p of c.positionals ?? []) {
    const key = identifier(p.name);
    properties[key] = p.rest ? { type: 'array', items: { type: 'string' }, description: p.help } : { type: 'string', description: p.help };
    if (p.required) required.push(key);
  }
  for (const [name, f] of Object.entries(c.flags ?? {})) if (!c.mcpOmit?.includes(name)) properties[identifier(name)] = propertyFor(f);
  return { type: 'object' as const, properties, ...(required.length ? { required } : {}) };
};

/** Back to an argv, so the same runtime serves both surfaces. */
const argvFor = (c: Command, input: Record<string, unknown>): string[] => {
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
const INSTRUCTIONS = `Lynkeus drives a React Native app (bare or Expo) or a Flutter app by what is on its screen, and runs cases written as readable steps.

In a project you do not know, call status first: it lists what is set up and, for what is not, the one thing that fixes it.

To set Lynkeus up: call init (it installs lynkeus-agent, mounts it from the app's entry and makes the project's token; nobody sets a variable). The agent has native code, so the app must then be built again (npx react-native run-ios or run-android; npx expo run:ios or run:android, never Expo Go) with Metro restarted with --reset-cache. Do that with your shell if you have one, or ask the person to. Then status until an app is attached.

A Flutter project has a pubspec.yaml whose dependencies include flutter (sdk: flutter). There init adds lynkeus_agent to pubspec.yaml and starts it in lib/main.dart, and the app is built and run with flutter run --dart-define=LYNKEUS_TOKEN=$(cat .lynkeus/token) on a simulator or emulator (no Metro). status checks a Flutter project's setup too (the agent in pubspec.yaml and its start in lib/main.dart, the token, lynkeus_plugins when the lockfile needs it). To test without a simulator, add lynkeus_headless to dev_dependencies and use case_run with host (headless_init and headless_doctor are for React Native); it needs FLUTTER_ROOT or flutter on PATH. map, case impact, smoke and crawl read the routes from the Dart source (go_router, a Navigator's named routes, onGenerateRoute, and a router of the app's own that registers paths with builders); smoke and crawl open routes by name through the agent's routes (LynkeusAgent.navigatorObserver, or LynkeusRoutes for a router). Lynkeus FastSim does run Flutter apps, through a separate host installed with lynkeus fastsim install --runtime flutter.

To write a test: call case_init once if the project has no cases, and read the README.md it writes for the format. Go to the screen with press, type and wait, calling screen to see what is there (press with settle: true answers with the screen once the app has settled; a screen read right after a press can still be the one it left); prefer testIDs (#id) over text. Write the case as a markdown file in the cases folder, then call case_run with that file. A failed step comes back with the screen it failed on: fix the case or report the app's bug, do not weaken the check.

To test without a simulator: call headless_init (it installs what the Node host needs and writes its entry; an Expo Router app works too), then headless_doctor for the native modules still to mock, then case_run with host. The backend the app talks to must be local: set apiUrl in lynkeus.config.json.

To test on Lynkeus FastSim (a simulator that runs the app on a Mac or Linux without Xcode or an emulator, much faster; optional and paid, part of the Team plan, plans at https://lynkeus.io/pricing; use it when the person asks for it or their organization already has it, otherwise the headless host and the Simulator or emulator are free and cover the same cases): fastsim_install with platform ios or android (the sign-in a member with a seat saved by running "lynkeus login" in a terminal, which you cannot do for them: when there is none, tell the person to run it; or, in CI, LYNKEUS_CLOUD_KEY in this server's environment: a key an owner made with "May download Lynkeus FastSim"), then read the README.md in the folder it answers: bin/fastsim-bundle makes the app's bundle, and case_run with host_command set to that folder's bin/fastsim-run <bundle folder> {port} runs each case on its own FastSim host. iOS matches the simulator only on a Mac. When the service refuses (no FastSim in the organization's plan, no seat, a key without "May download Lynkeus FastSim"), tell the person what the refusal says and where to get it (an owner subscribes at https://lynkeus.io/pricing, or gives them a seat under Members), then carry on with headless or the Simulator; never retry with other credentials or look for a way around it.

To share a run: case_run with out, screenshots and push uploads it and prints the report's address. That needs LYNKEUS_REPORTS_KEY in this server's environment.

For a run with everything (frames, film, requests, analytics, backend): case_run with out, screenshots, video (film needs FastSim), traces and push. When the run ends it warns about evidence it could not keep: pass that on.

A case that changes something outside the app (a face enrolled on a shared Simulator) puts it back in \`teardown:\`, a list of steps with the same syntax as \`steps\`: it runs after them whether they passed, failed or were skipped, a failing teardown step is only a warning, and a run cut by a timeout never reaches it.
A long case opens each part of its steps with a numbered comment (# 1 Sign in, # 2 A wrong PIN), numbered like its expected list: reports and the live status group the steps by them.

For a long suite: case_run with jobs, ports and host_command runs cases side by side, each on its own host; a case that changes what every case sees (a global flag) declares exclusive: true and runs alone. While a run goes on, case_status says where it is (cases done, what each job runs and in which section, the time left); a client that passes a progress token also hears it as progress notifications.

For a run to repeat exactly (comparing two runs, a time-dependent screen): case_run with seed, locale, time_zone and epoch on a host the run starts (host or host_command). A simulator or emulator that is only attached keeps its own clock and zone; run.json says which facts it could not apply.

A request a case mocked (app.mock) reads (mocked) in requests, trace and a failed case's evidence: it is the case's doing, never the backend's.

To look at a loading state, a case holds the request and releases it later: app.mock with route and hold: true, the steps that look at the screen, then app.mock with release: true. A held request is not waited for (idle and screenshots go on without it) and is reported apart as held, not in inFlight.`;

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
    const ctx =
      token === undefined
        ? session.ctx
        : {
            ...session.ctx,
            progress: progressNotifier((params) => {
              void extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, ...params } }).catch(() => undefined);
            }),
          };
    const r = await execute(argvFor(c, input), ctx);
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

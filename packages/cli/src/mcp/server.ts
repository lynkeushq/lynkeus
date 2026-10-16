import { createRequire } from 'node:module';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import type { FlagSpec } from '../args.js';
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

// Written by hand: a schema library adds fields to every tool that a model pays for on every turn.
const schemaFor = (c: Command) => {
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

// What a model is told once, when it connects: the order things are done in, so "set lynkeus up" and "write me
// a test for this" need nothing more from the person asking.
const INSTRUCTIONS = `lynkeus drives a React Native app (bare or Expo) by what is on its screen, and runs cases written as readable steps.

In a project you do not know, call status first: it lists what is set up and, for what is not, the one thing that fixes it.

To set lynkeus up: call init (it installs lynkeus-agent, mounts it from the app's entry and makes the project's token; nobody sets a variable). The agent has native code, so the app must then be built again (npx react-native run-ios or run-android; npx expo run:ios or run:android, never Expo Go) with Metro restarted with --reset-cache. Do that with your shell if you have one, or ask the person to. Then status until an app is attached.

To write a test: call case_init once if the project has no cases, and read the README.md it writes for the format. Go to the screen with press, type and wait, calling screen to see what is there; prefer testIDs (#id) over text. Write the case as a markdown file in the cases folder, then call case_run with that file. A failed step comes back with the screen it failed on: fix the case or report the app's bug, do not weaken the check.

To test without a simulator: call headless_init (it installs what the Node host needs and writes its entry; an Expo Router app works too), then headless_doctor for the native modules still to mock, then case_run with host. The backend the app talks to must be local: set apiUrl in lynkeus.config.json.

To share a run: case_run with out, screenshots and push uploads it and prints the report's address. That needs LYNKEUS_REPORTS_KEY in this server's environment.

For a run with everything (frames, film, requests, analytics, backend): case_run with out, screenshots, video (film needs fastsim), traces and push. When the run ends it warns about evidence it could not keep: pass that on.`;

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
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
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
    const r = await execute(argvFor(c, input), session.ctx);
    if (r.error) return { ...text(`✗ ${r.error}${r.why ? `\n\nwhy:\n${r.why}` : ''}`), isError: true };
    return text(r.text || (r.json !== undefined ? JSON.stringify(r.json, null, 2) : 'ok'));
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

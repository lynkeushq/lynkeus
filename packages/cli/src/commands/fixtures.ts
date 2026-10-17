import { FIXTURES_PROTOCOL, type FixtureCommand } from 'lynkeus-protocol';

import { DESCRIBE, type Description, Fixtures, lastDescription, readDescription } from '../cases/fixtures.js';
import { define } from '../registry.js';

const paramsOf = (c: FixtureCommand) =>
  Object.entries(c.params ?? {})
    .map(([k, p]) => `${k}${p.required ? '' : '?'}${p.values ? `=${p.values.join('|')}` : p.type ? `:${p.type}` : ''}`)
    .join(' ');

/** What a server keeps of the contract and what it leaves out, as lines a person can act on. */
export const checkDescription = (d: Description | undefined): { ok: boolean; lines: string[] } => {
  if (!d) return { ok: false, lines: ['✗ `lynkeus.describe` got no list of commands: answer {"commands": [...]} (docs/FIXTURES.md)'] };
  const lines: string[] = [];
  let ok = true;
  if (d.down) {
    ok = false;
    lines.push(`✗ the server runs but cannot serve: ${d.down}`);
  }
  if (d.protocol !== undefined && d.protocol > FIXTURES_PROTOCOL) {
    ok = false;
    lines.push(`✗ it speaks fixtures protocol ${d.protocol}; this lynkeus knows ${FIXTURES_PROTOCOL}`);
  }
  const names = new Set<string>();
  for (const c of d.details) {
    if (names.has(c.name)) {
      ok = false;
      lines.push(`✗ ${c.name} is listed twice`);
    }
    names.add(c.name);
  }
  const bare = d.details.filter((c) => !c.summary);
  lines.push(`✓ ${d.commands.length} command${d.commands.length === 1 ? '' : 's'}`);
  if (bare.length)
    lines.push(
      `· ${bare.length} without a summary (${bare
        .slice(0, 6)
        .map((c) => c.name)
        .join(', ')}${bare.length > 6 ? ', …' : ''}): a summary and params let authors and models pick a setup`,
    );
  return { ok, lines };
};

export const fixturesCommands = [
  define({
    name: 'fixtures describe',
    group: 'runs',
    summary: 'List what the project’s fixtures server can do: each command, what it makes or reads, its parameters',
    details:
      'Starts the command `cases.fixtures` names, asks `lynkeus.describe`, and prints each command with its summary and parameters, for whoever writes a case. A server that answers names only shows names. What it answered last (here or before a run) is kept in .lynkeus and shown for a day without starting it; --fresh asks again.',
    flags: { fresh: { type: 'boolean', help: 'ask the server even when it described itself in the last day' } },
    needs: 'nothing',
    session: false,
    mcp: 'core',
    run: async (ctx) => {
      const config = ctx.config.cases ?? {};
      if (!config.fixtures) return { text: 'the project declares no fixtures (cases.fixtures in lynkeus.config.json)', code: 1 };
      const root = config.base ?? ctx.root;
      const kept = ctx.flags.fresh ? undefined : lastDescription(root, config.fixtures.command);
      const recent = kept && Date.now() - kept.at < 24 * 3600_000 ? kept : undefined;
      let d = recent?.description;
      if (!d) {
        const server = new Fixtures(config.fixtures, root);
        d = await server.describe().finally(() => server.close());
      }
      if (!d) return { text: 'the fixtures server did not describe itself (it answers `lynkeus.describe` with {"commands": [...]})', code: 1 };
      const text = d.details.map((c) => `${c.name}${c.params ? ` ${paramsOf(c)}` : ''}${c.summary ? `\n    ${c.summary}` : ''}`).join('\n');
      const age = recent ? `\n(as the server described itself ${Math.round((Date.now() - recent.at) / 60_000)} min ago; --fresh asks it again)` : '';
      return { text: d.down ? `${text}\n(the server cannot serve now: ${d.down})` : `${text}${age}`, json: d };
    },
  }),
  define({
    name: 'fixtures check',
    group: 'runs',
    summary: 'Tell whether the project’s fixtures server keeps the fixtures protocol',
    details:
      'Starts the server, asks `lynkeus.describe`, and checks the answer against the contract in docs/FIXTURES.md: a list of commands, no name twice, a protocol version this lynkeus knows, and whether it is up. It changes nothing in the backend.',
    needs: 'nothing',
    session: false,
    mcp: 'core',
    run: async (ctx) => {
      const config = ctx.config.cases ?? {};
      if (!config.fixtures) return { text: 'the project declares no fixtures (cases.fixtures in lynkeus.config.json)', code: 1 };
      const server = new Fixtures(config.fixtures, config.base ?? ctx.root);
      // Its own call, not describe(): a server that never answers is told apart from one that answers wrong.
      const answered = await server.call(DESCRIBE, {}).then(
        (answer) => ({ answer }),
        (error: Error) => ({ error: error.message }),
      );
      server.close();
      if ('error' in answered)
        return {
          text: `✗ the fixtures server gave no answer to lynkeus.describe: ${answered.error}\n  (is its backend up? the command is \`${config.fixtures.command}\`)`,
          json: { ok: false, error: answered.error },
          code: 1,
        };
      const d = readDescription(answered.answer);
      const { ok, lines } = checkDescription(d);
      return { text: lines.join('\n'), json: { ok, description: d }, code: ok ? 0 : 1 };
    },
  }),
];

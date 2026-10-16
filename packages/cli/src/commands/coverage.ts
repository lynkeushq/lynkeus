import fs from 'node:fs';
import path from 'node:path';

import { coverageOf, impactOf, readSeen } from '../cases/coverage.js';
import { draftCase } from '../cases/draft.js';
import { Fixtures } from '../cases/fixtures.js';
import { readCases } from '../cases/format.js';
import { edgesFile } from '../config.js';
import * as edges from '../knowledge/edges.js';
import { plan } from '../knowledge/plan.js';
import { screensAffectedBy } from '../knowledge/query.js';
import { type Base, define } from '../registry.js';
import { caseFiles } from './cases.js';
import { changedSources } from './map.js';

// The project's cases and what they cover, read the way `case run` reads them.
const coverageFor = (ctx: Base & { graph: () => { screens: Record<string, unknown> } }, seenFlag: unknown) => {
  const config = ctx.config.cases ?? {};
  const home = config.base ?? ctx.root;
  const files = caseFiles([], home, config.dir);
  if (typeof files === 'string') return files;
  const cases = files.flatMap(readCases);
  const seenDir = path.resolve(ctx.root, typeof seenFlag === 'string' ? seenFlag : '.lynkeus/seen');
  return { cases, coverage: coverageOf(cases, Object.keys(ctx.graph().screens).sort(), readSeen(seenDir)) };
};

export const coverageCommands = [
  define({
    name: 'case coverage',
    group: 'runs',
    summary: 'Which of the app’s screens the cases touch, which none does, and which a case names that the app no longer has',
    details:
      'A screen counts as touched when a case goes to it (`app.nav`), waits for it (`app.wait`), checks it (`app.see: { route }`), or went through it on its last passing run (`case run --seen <dir>`, read from .lynkeus/seen unless --seen says where). The screens come from the route graph (`lynkeus map build`).',
    flags: {
      route: { type: 'string', help: 'only this screen: the cases that touch it', value: 'Route' },
      seen: { type: 'string', help: 'where `case run --seen` kept the screens of passing cases (default .lynkeus/seen)', value: 'dir' },
    },
    needs: 'graph',
    session: false,
    mcp: true,
    run: async (ctx) => {
      const read = coverageFor(ctx, ctx.flags.seen);
      if (typeof read === 'string') return { text: read, code: 1 };
      const { cases, coverage } = read;
      if (typeof ctx.flags.route === 'string') {
        const ids = coverage.byRoute[ctx.flags.route] ?? [];
        return { text: `${ctx.flags.route}: ${ids.length ? ids.join(', ') : 'no case'}`, json: { route: ctx.flags.route, cases: ids } };
      }
      const pct = coverage.routes ? Math.round((100 * coverage.covered.length) / coverage.routes) : 0;
      const top = Object.entries(coverage.byRoute)
        .filter(([r]) => !coverage.unknown.includes(r))
        .sort((a, b) => b[1].length - a[1].length)
        .slice(0, 8);
      const lines = [
        `${coverage.covered.length} of ${coverage.routes} screens touched by a case (${pct}%), from ${cases.length} case${cases.length === 1 ? '' : 's'}`,
        ...(top.length ? ['most covered:', ...top.map(([r, ids]) => `  ${r.padEnd(34)} ${ids.length}`)] : []),
        ...(coverage.unknown.length
          ? ['named by a case, unknown to the app (renamed? a typo?):', ...coverage.unknown.map((r) => `  ${r} ← ${coverage.byRoute[r]!.join(', ')}`)]
          : []),
        `${coverage.uncovered.length} screen${coverage.uncovered.length === 1 ? '' : 's'} no case touches${coverage.uncovered.length ? ':' : ''}`,
        ...coverage.uncovered.slice(0, 30).map((r) => `  ${r}`),
        ...(coverage.uncovered.length > 30 ? [`  … ${coverage.uncovered.length - 30} more (--json)`] : []),
      ];
      return { text: lines.join('\n'), json: coverage };
    },
  }),
  define({
    name: 'case impact',
    group: 'runs',
    summary: 'The cases a branch’s changes reach, to run only those, and the reached screens no case covers',
    details:
      'The screens the diff against --base touches or imports (as `map check` finds them), crossed with what each case covers (as `case coverage` finds it). --files prints one case file per line: `lynkeus case run $(lynkeus case impact --files)`.',
    flags: {
      base: { type: 'string', help: 'git ref to diff against', default: 'main', value: 'ref' },
      depth: { type: 'number', help: 'how many imports away a change still reaches a screen', default: 4, value: 'n' },
      seen: { type: 'string', help: 'where `case run --seen` kept the screens of passing cases (default .lynkeus/seen)', value: 'dir' },
      files: { type: 'boolean', help: 'print only the case files, one per line' },
    },
    needs: 'graph',
    session: false,
    mcp: true,
    run: async (ctx) => {
      const read = coverageFor(ctx, ctx.flags.seen);
      if (typeof read === 'string') return { text: read, code: 1 };
      const base = ctx.flags.base as string;
      const changed = changedSources(ctx.root, base, ctx.err);
      const affected = screensAffectedBy(ctx.graph(), changed, ctx.flags.depth as number);
      const impact = impactOf(affected, read.coverage);
      if (ctx.flags.files) return { text: [...new Set(impact.cases.map((c) => c.file))].join('\n'), json: impact };
      const lines = [
        `${changed.length} source file${changed.length === 1 ? '' : 's'} changed against ${base}; they reach ${new Set(affected.map((a) => a.route)).size} screen(s)`,
        ...(impact.cases.length
          ? [`cases to run (${impact.cases.length}):`, ...impact.cases.map((c) => `  ${c.id.padEnd(46)} ${c.routes.join(', ')} (via ${c.via})`)]
          : ['no case touches them']),
        ...(impact.untested.length ? [`reached, and touched by no case (${impact.untested.length}):`, ...impact.untested.map((r) => `  ${r}`)] : []),
      ];
      return { text: lines.join('\n'), json: { base, changed, ...impact } };
    },
  }),
  define({
    name: 'case new',
    group: 'runs',
    summary: 'Draft a case for a screen: the way there, the backend setup to pick from, and the checks left to write',
    details:
      'Prints a case to finish: the frontmatter with the questions a reader needs answered, the setup the project’s fixtures server offers (from `lynkeus.describe`, commented out: what state the case needs is the author’s call), the presses from --from (default `cases.start`) to the screen as `map plan` knows them, and the checks to write. --write saves it as <cases dir>/<id>.md, never over a file that is there.',
    positionals: [{ name: 'id', help: 'the case id, which is also its file name', required: true }],
    flags: {
      to: { type: 'string', help: 'the screen the case is about', value: 'Route' },
      from: { type: 'string', help: 'where it begins (default: cases.start in lynkeus.config.json)', value: 'Route' },
      title: { type: 'string', help: 'what a person can do there, as the report will title it', value: 'text' },
      write: { type: 'boolean', help: 'save it in the cases folder instead of printing it' },
    },
    needs: 'graph',
    session: false,
    mcp: true,
    run: async (ctx) => {
      const config = ctx.config.cases ?? {};
      const id = ctx.args[0]!;
      if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) return { text: `${id}: an id is lower case letters, digits, dots, dashes and underscores`, code: 2 };
      const to = ctx.flags.to as string | undefined;
      const from = (ctx.flags.from as string | undefined) ?? config.start;
      if (!to) return { text: 'case new needs --to <Route>, the screen the case is about', code: 2 };
      if (!from) return { text: 'case new needs --from <Route>, or cases.start in lynkeus.config.json', code: 2 };
      const graph = ctx.graph();
      if (!graph.screens[to]) return { text: `${to}: the app has no such screen (lynkeus map routes lists them)`, code: 1 };
      const server = config.fixtures ? new Fixtures(config.fixtures, config.base ?? ctx.root) : undefined;
      const described = server ? await server.describe().finally(() => server.close()) : undefined;
      const text = draftCase({
        id,
        title: ctx.flags.title as string | undefined,
        from,
        to,
        path: plan(graph, from, to, edges.load(edgesFile(ctx.root))) ?? undefined,
        fixtures: described?.details,
        fixturesSilent: !!server && !described,
        macros: Object.keys(config.macros ?? {}),
      });
      if (!ctx.flags.write) return { text, json: { id, text } };
      const dir = path.resolve(config.base ?? ctx.root, config.dir ?? 'cases');
      const file = path.join(dir, `${id}.md`);
      if (fs.existsSync(file)) return { text: `${path.relative(ctx.root, file)} is there already; pick another id or edit it`, code: 1 };
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, text);
      return { text: `wrote ${path.relative(ctx.root, file)}`, json: { id, file } };
    },
  }),
];

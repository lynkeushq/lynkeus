import fs from 'node:fs';
import path from 'node:path';

import { coverageOf, impactOf, readSeenRuns, SEEN_DIR, withIdCases, withTextCases } from '../cases/coverage.js';
import { type DraftInput, draftCase, hereCase } from '../cases/draft.js';
import { Fixtures } from '../cases/fixtures.js';
import { FIXTURES } from '../cases/templates.js';
import { readCases } from '../cases/format.js';
import { macroSnippet, repeatedOpening, wayTo } from '../cases/reuse.js';
import { edgesFile, lynkeusDir } from '../config.js';
import * as edges from '../knowledge/edges.js';
import { navigatorRoutes } from '../knowledge/nesting.js';
import { plan } from '../knowledge/plan.js';
import { IMPACT_DEPTH, vocabularyOf } from '../knowledge/query.js';
import * as screens from '../knowledge/screens.js';
import type { ScreenGraph } from '../knowledge/types.js';
import { type Base, define } from '../registry.js';
import { changedAppEntry, entryReason } from './appEntry.js';
import { caseFiles, startHost, stopHost } from './cases.js';
import { runtimeAt } from '../runtimes/index.js';
import { changedSources, reachOfChanges } from './map.js';

// The project's cases and what they cover, read the way `case run` reads them.
const coverageFor = (ctx: Base & { graph: () => ScreenGraph }, seenFlag: unknown) => {
  const config = ctx.config.cases ?? {};
  const home = config.base ?? ctx.root;
  const files = caseFiles([], home, config.dir);
  if (typeof files === 'string') return files;
  const cases = files.flatMap(readCases);
  const graph = ctx.graph();
  const seen = readSeenRuns(path.resolve(ctx.root, typeof seenFlag === 'string' ? seenFlag : SEEN_DIR));
  const routes = Object.fromEntries(Object.entries(seen).map(([id, s]) => [id, s.routes]));
  return { cases, seen, coverage: coverageOf(cases, Object.keys(graph.screens).sort(), routes, { macros: config.macros, navigators: navigatorRoutes(graph) }) };
};

// The fixtures server `case init` writes, still as written: its fixtures are an example, not this app's backend.
const isTemplateServer = (command: string, home: string): boolean =>
  command.split(/\s+/).some((word) => {
    try {
      const file = path.resolve(home, word);
      return fs.statSync(file).isFile() && fs.readFileSync(file, 'utf8') === FIXTURES;
    } catch {
      return false;
    }
  });

const SCREEN_READ_MS = 1500;

// What a draft can offer to check on a screen no case reaches: the testIDs its own file writes (else those of what it
// imports), what runs saw on it, and the presses its source has lead on.
const knownOn = (graph: ScreenGraph, route: string, seen: screens.Observed | undefined): NonNullable<DraftInput['known']> => {
  const own = vocabularyOf(graph, route, 0);
  const near = own?.selectors.length ? own : vocabularyOf(graph, route, 1);
  const ids: { id: string; from?: string }[] = [...new Map((near?.selectors ?? []).map((s) => [s.id, { id: s.id, from: s.from }])).values()].filter(
    (s) => !s.id.includes('${'),
  );
  for (const id of seen?.testIds ?? []) if (!ids.some((i) => i.id === id)) ids.push({ id });
  const leadsTo = (own?.navigatesTo ?? []).flatMap((e) =>
    e.via.kind === 'testId' && e.confidence === 'static' && graph.screens[e.to] && e.to !== route ? [{ press: e.via.testId, to: e.to }] : [],
  );
  const pressed = new Set(leadsTo.map((l) => l.press));
  return { ids: ids.filter((i) => !pressed.has(i.id)), texts: seen?.texts ?? [], leadsTo };
};

/**
 * Where a draft begins when neither --from nor cases.start says: the screen an attached app shows now (asked only in a
 * session or over MCP, where a connection may already be there, and briefly), else the first screen the navigator declares.
 */
const startOf = async (ctx: Base, routes: string[]): Promise<{ route: string; why: string } | undefined> => {
  if (ctx.attached) {
    const shown = await Promise.race([
      ctx
        .device()
        .then((d) => d.screen())
        .then(
          (sc) => sc.route,
          () => undefined,
        ),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), SCREEN_READ_MS).unref()),
    ]);
    if (shown && routes.includes(shown)) return { route: shown, why: 'the screen the app shows now' };
  }
  return routes[0] ? { route: routes[0], why: 'the first screen the navigator declares' } : undefined;
};

export const coverageCommands = [
  define({
    name: 'case coverage',
    group: 'runs',
    summary: 'Which of the app’s screens the cases touch, which none does, and which a case names that the app no longer has',
    details:
      'A screen counts as touched when a case, or a macro it calls, goes to it (`app.nav`), waits for it (`app.wait`), checks it (`app.see: { route }`), or went through it on its last passing run (`case run` keeps that in .lynkeus/seen, or where its --seen says; so does this --seen). The screens come from the route graph (`lynkeus map build`). When three or more case files open with the same app steps, a hint names them and the macro (`cases.macros`) that would say them once.',
    flags: {
      route: { type: 'string', help: 'only this screen: the cases that touch it', value: 'Route' },
      seen: { type: 'string', help: 'where `case run` kept the screens of passing cases (default .lynkeus/seen)', value: 'dir' },
    },
    needs: 'graph',
    session: false,
    mcp: 'core',
    run: async (ctx) => {
      const read = coverageFor(ctx, ctx.flags.seen);
      if (typeof read === 'string') return { text: read, code: 1 };
      const { cases, coverage } = read;
      const macros = ctx.config.cases?.macros ?? {};
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
        ...(coverage.navigators.length ? [`not counted, navigators whose screens are counted instead: ${coverage.navigators.join(', ')}`] : []),
      ];
      const repeated = repeatedOpening(cases, macros);
      if (repeated)
        lines.push(
          repeated.declared
            ? `hint: ${repeated.cases.length} cases (${repeated.cases.join(', ')}) open with the ${repeated.steps.length} steps of the macro ${repeated.declared}: call it instead`
            : `hint: ${repeated.cases.length} cases (${repeated.cases.join(', ')}) open with the same ${repeated.steps.length} steps; declare them once under cases.macros in lynkeus.config.json and call \`- ${repeated.macro}\` instead:\n  ${macroSnippet(repeated)}`,
        );
      return { text: lines.join('\n'), json: { ...coverage, ...(repeated ? { repeated } : {}) } };
    },
  }),
  define({
    name: 'case impact',
    group: 'runs',
    summary: 'The cases a branch’s changes reach, to run only those, and the reached screens no case covers',
    details:
      'The screens the diff against --base touches or imports (as `map check` finds them), crossed with what each case covers (as `case coverage` finds it). A change to a string table (a file of object literals of strings, such as the app’s translations) counts only for the files that name its changed keys (`t(\'a.b\')`, `tx="a:b"`, `strings.a.b`) and the cases whose steps name a changed string’s old or new text; when a changed key is named nowhere by its whole key, every importer counts and a line says why. A file whose change is only testIDs or accessibility labels (or comments and formatting) reaches no screen, only the cases whose steps or macros name a changed testID (old or new) or a changed label’s text. --files prints one case file per line: `lynkeus case run $(lynkeus case impact --files)`.',
    flags: {
      base: { type: 'string', help: 'git ref to diff against', default: 'main', value: 'ref' },
      depth: { type: 'number', help: 'how many imports away a change still reaches a screen', default: IMPACT_DEPTH, value: 'n' },
      seen: { type: 'string', help: 'where `case run` kept the screens of passing cases (default .lynkeus/seen)', value: 'dir' },
      files: { type: 'boolean', help: 'print only the case files, one per line' },
    },
    needs: 'graph',
    session: false,
    mcp: 'core',
    run: async (ctx) => {
      const read = coverageFor(ctx, ctx.flags.seen);
      if (typeof read === 'string') return { text: read, code: 1 };
      const base = ctx.flags.base as string;
      const runtime = await runtimeAt(ctx.root);
      const changed = changedSources(ctx.root, base, ctx.err, runtime.sources);
      const { affected, texts, ids, notes } = await reachOfChanges(ctx.root, ctx.graph(), changed, {
        base,
        depth: ctx.flags.depth as number,
        runtime,
        relative: runtime.sources.relative,
      });
      const impact = withIdCases(
        withTextCases(impactOf(affected, read.coverage, entryReason(changedAppEntry(ctx.root, changed))), read.cases, texts),
        read.cases,
        ids,
        ctx.config.cases?.macros,
      );
      if (ctx.flags.files) return { text: [...new Set(impact.cases.map((c) => c.file))].join('\n'), json: { ...impact, notes } };
      const lines = [
        `${changed.length} source file${changed.length === 1 ? '' : 's'} changed against ${base}; they reach ${new Set(affected.map((a) => a.route).filter((r) => !read.coverage.navigators.includes(r))).size} screen(s)`,
        ...(impact.reason ? [`every case is affected: ${impact.reason}`] : notes),
        ...(impact.cases.length
          ? [`cases to run (${impact.cases.length}):`, ...impact.cases.map((c) => `  ${c.id.padEnd(46)} ${c.routes.join(', ')} (via ${c.via})`)]
          : ['no case touches them']),
        ...(impact.untested.length ? [`reached, and touched by no case (${impact.untested.length}):`, ...impact.untested.map((r) => `  ${r}`)] : []),
      ];
      return { text: lines.join('\n'), json: { base, changed, ...impact, notes } };
    },
  }),
  define({
    name: 'case new',
    group: 'runs',
    summary: 'Draft a case for a screen: the way there, the backend setup to pick from, and the checks left to write',
    details:
      'Prints a case to finish: the frontmatter with the questions a reader needs answered, the names of the fixtures the project’s server offers (from `lynkeus.describe`, as a comment: what state the case needs is the author’s call; none while it is the example `case init` wrote), the way to the screen, and the checks to write. The way is the one an existing case takes, when one reaches the screen (its last passing run was there, as `case run` keeps in .lynkeus/seen, or a step of it goes to, waits for or checks the screen), with a line naming that case; otherwise the presses from --from (default `cases.start`, else the screen the app shows, else the first screen the navigator declares) as `map plan` knows them; without --from, a start with no known way gives way to `cases.start`, then the first declared screen. With no case through the screen, it lists (commented out) the testIDs its source writes, texts runs saw there and the presses that lead on. --write saves it as <cases dir>/<id>.md, never over a file that is there.',
    positionals: [{ name: 'id', help: 'the case id, which is also its file name', required: true }],
    flags: {
      to: { type: 'string', help: 'the screen the case is about', value: 'Route' },
      from: {
        type: 'string',
        help: 'where it begins (default: cases.start in lynkeus.config.json, else the screen the app shows, else the first screen declared)',
        value: 'Route',
      },
      title: { type: 'string', help: 'what a person can do there, as the report will title it', value: 'text' },
      write: { type: 'boolean', help: 'save it in the cases folder instead of printing it' },
    },
    needs: 'graph',
    session: false,
    mcp: 'core',
    run: async (ctx) => {
      const config = ctx.config.cases ?? {};
      const id = ctx.args[0]!;
      if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) return { text: `${id}: an id is lower case letters, digits, dots, dashes and underscores`, code: 2 };
      const to = ctx.flags.to as string | undefined;
      if (!to) return { text: 'case new needs --to <Route>, the screen the case is about; `case here` drafts one from the screen the app shows now', code: 2 };
      const graph = ctx.graph();
      if (!graph.screens[to]) return { text: `${to}: the app has no such screen (lynkeus map screens lists them)`, code: 1 };
      const begin = (ctx.flags.from as string | undefined) ?? config.start;
      const first = begin ? { route: begin } : await startOf(ctx, Object.keys(graph.screens));
      if (!first) return { text: 'case new needs --from <Route>, or cases.start in lynkeus.config.json: the route graph has no screens to begin on', code: 2 };
      const observedEdges = edges.load(edgesFile(ctx.root));
      const read = coverageFor(ctx, undefined);
      // A project with no cases yet has no way to offer; the route map's plan still is one.
      const way =
        typeof read === 'string'
          ? undefined
          : wayTo(read.cases, read.seen, to, { from: ctx.flags.from as string | undefined, skip: id, macros: Object.keys(config.macros ?? {}) });
      // A screen the app happens to show may lead nowhere the map knows: the configured start, then the first declared
      // screen, may. Only when the author did not name where to begin.
      const fallbacks = [
        ...(config.start ? [{ route: config.start, why: 'cases.start' }] : []),
        ...(Object.keys(graph.screens)[0] ? [{ route: Object.keys(graph.screens)[0]!, why: 'the first screen the navigator declares' }] : []),
      ];
      let start: { route: string; why?: string } = first;
      let path = way ? undefined : (plan(graph, first.route, to, observedEdges) ?? undefined);
      if (!way && !path && !ctx.flags.from)
        for (const other of fallbacks.filter((f) => f.route !== first.route)) {
          const found = plan(graph, other.route, to, observedEdges);
          if (!found) continue;
          const was = 'why' in first && first.why ? ` (${first.why})` : '';
          start = { route: other.route, why: `${other.why}; no known way from ${first.route}${was}` };
          path = found;
          break;
        }
      const from = start.route;
      const template = config.fixtures ? isTemplateServer(config.fixtures.command, config.base ?? ctx.root) : false;
      const server = config.fixtures && !template ? new Fixtures(config.fixtures, config.base ?? ctx.root) : undefined;
      const described = server ? await server.describe().finally(() => server.close()) : undefined;
      const text = draftCase({
        id,
        title: ctx.flags.title as string | undefined,
        from,
        to,
        way,
        path,
        fixtures: described?.details,
        fixturesSilent: !!server && !described,
        macros: Object.keys(config.macros ?? {}),
        ...(start.why ? { fromNote: start.why } : {}),
        ...(way ? {} : { known: knownOn(graph, to, screens.observed(lynkeusDir(ctx.root)).get(to)) }),
      });
      const reused = way ? { case: way.source, how: way.how, steps: way.setup.length + way.steps.length } : undefined;
      return ctx.flags.write ? writeCase(ctx, id, text) : { text, json: { id, text, ...(reused ? { reused } : {}) } };
    },
  }),
  define({
    name: 'case here',
    group: 'runs',
    summary: 'Draft a case from the screen the app shows now, with checks that pass as it is',
    details:
      'Reads the attached app’s screen and writes a case that goes to its route (`app.nav`, when it has one) and sees up to three of what is on it, testIDs first, then texts: a project’s first case that runs green at once, or the start of one for a screen. --write saves it as <cases dir>/<id>.md, never over a file that is there.',
    positionals: [{ name: 'id', help: 'the case id, which is also its file name', required: true }],
    flags: {
      title: { type: 'string', help: 'what the case shows, as the report will title it', value: 'text' },
      write: { type: 'boolean', help: 'save it in the cases folder instead of printing it' },
      host: { type: 'boolean', help: 'start `headless start` for the read and stop it after' },
    },
    needs: 'app',
    mcp: 'core',
    run: async (ctx) => {
      const id = ctx.args[0]!;
      if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) return { text: `${id}: an id is lower case letters, digits, dots, dashes and underscores`, code: 2 };
      // Over MCP no shell keeps a host running: --host brings one up for the read, as `case run --host` does for a run.
      const host = ctx.flags.host ? await startHost(ctx.root, ctx.err) : undefined;
      let locale: string | undefined;
      const screen = await (async () => {
        try {
          const device = await ctx.device();
          locale = device.server.hello?.locale;
          return await device.screen();
        } finally {
          if (host) await stopHost(host);
        }
      })();
      const text = hereCase(id, screen, ctx.flags.title as string | undefined, { locale, language: ctx.config.language });
      return ctx.flags.write ? writeCase(ctx, id, text) : { text, json: { id, text } };
    },
  }),
];

/** Saves a drafted case in the cases folder, never over a file that is there. */
const writeCase = (ctx: Base, id: string, text: string) => {
  const config = ctx.config.cases ?? {};
  const dir = path.resolve(config.base ?? ctx.root, config.dir ?? 'cases');
  const file = path.join(dir, `${id}.md`);
  if (fs.existsSync(file)) return { text: `${path.relative(ctx.root, file)} is there already; pick another id or edit it`, code: 1 };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, text);
  return { text: `wrote ${path.relative(ctx.root, file)}`, json: { id, file } };
};

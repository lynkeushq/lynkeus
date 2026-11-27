import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { edgesFile, graphFile, lynkeusDir, saveGraph } from '../config.js';
import { CLI_VERSION } from '../device/agentVersion.js';
import { readJson, writeJson } from '../files.js';
import * as edges from '../knowledge/edges.js';
import { describePlan, plan } from '../knowledge/plan.js';
import { type Affected, pathsTo, screensAffectedBy, vocabularyOf } from '../knowledge/query.js';
import * as screens from '../knowledge/screens.js';
import { narrowStringTables, type StringNarrowing } from '../knowledge/stringTables.js';
import type { ScreenGraph } from '../knowledge/types.js';
import { define } from '../registry.js';
import type { RuntimeAdapter } from '../runtimes/index.js';
import { runtimeAt } from '../runtimes/index.js';
import { changedAppEntry } from './appEntry.js';
import { describeGraphDiff, diffGraphs } from './check.js';

const baseGraphFile = (root: string) => path.join(lynkeusDir(root), 'graph.base.json');

/** Nearest first, under a heading per distance; `chain` names every file in between instead of the last. */
const describeAffected = (affected: Affected[], chain: boolean): string[] => {
  const lines: string[] = [];
  let last = -1;
  for (const a of affected) {
    if (a.distance !== last) {
      last = a.distance;
      lines.push(a.distance === 0 ? '  changed screens' : a.distance === 1 ? '  screens importing a changed file' : `  ${a.distance} imports away`);
    }
    const how = a.distance === 0 ? '' : a.through.length ? `via ${chain ? a.through.join(' > ') : a.through.at(-1)}` : `imports ${a.via}`;
    lines.push(`    ${a.route.padEnd(32)} ${how}`.trimEnd());
  }
  return lines;
};

/** Source files a branch changed against `base`, committed or not. */
export const changedSources = (root: string, base: string, err: (line: string) => void, sources: RuntimeAdapter['sources']): string[] => {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  const diff = sources.relative ? ['diff', '--name-only', '--relative'] : ['diff', '--name-only'];
  const source = sources.pattern;
  try {
    const names = `${git(...diff, `${base}...HEAD`)}\n${git(...diff, 'HEAD')}`;
    return [
      ...new Set(
        names
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => source.test(l)),
      ),
    ];
  } catch (error) {
    err(`could not diff against ${base}: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
};

/**
 * The screens `changed` reaches through imports, with each changed string table narrowed to the files naming its
 * changed keys (`narrowStringTables`). `base` is what the diff is against (`changedSources`); `relative` says the
 * names are from the app's folder rather than the repository's root.
 */
export const reachOfChanges = async (
  root: string,
  graph: ScreenGraph,
  changed: string[],
  options: { base: string; depth?: number; runtime: Pick<RuntimeAdapter, 'stringTable'>; relative: boolean },
): Promise<{ affected: Affected[]; texts: StringNarrowing['texts']; notes: string[] }> => {
  const table = options.runtime.stringTable;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const narrowed = table
    ? await (async () => {
        try {
          const top = options.relative ? root : git('rev-parse', '--show-toplevel').trim();
          const at = git('merge-base', options.base, 'HEAD').trim();
          return await narrowStringTables(changed, graph, {
            now: (f) => (fs.existsSync(path.join(top, f)) ? fs.readFileSync(path.join(top, f), 'utf8') : undefined),
            before: (f) => {
              try {
                return git('show', `${at}:${options.relative ? `./${f}` : f}`);
              } catch {
                return undefined;
              }
            },
            table,
          });
        } catch {
          return undefined;
        }
      })()
    : undefined;
  return {
    affected: screensAffectedBy(graph, narrowed?.files ?? changed, options.depth),
    texts: narrowed?.texts ?? [],
    notes: narrowed?.notes ?? [],
  };
};

export const mapCommands = [
  define({
    name: 'map build',
    group: 'map',
    summary: 'Read the source once: routes, testIDs, navigations → .lynkeus/graph.json',
    details:
      'Rarely needed by hand: every command that reads the graph (case coverage, case new, map plan, map show, smoke…) builds it first when it is missing or when a source file it was read from changed since, or a folder of them gained or lost a file. Run it to see what was read and what could not be, or with --as-base to keep a graph for `map check`.',
    flags: { 'as-base': { type: 'boolean', help: 'also keep it as graph.base.json, for `map check` to diff against' } },
    needs: 'nothing',
    run: async (ctx) => {
      const runtime = await runtimeAt(ctx.root);
      const missing = runtime.graphMissing(ctx.root);
      if (missing) return { text: missing, code: 1 };
      const started = Date.now();
      const graph = await runtime.buildGraph(ctx.root, ctx.err);
      const dropped = saveGraph(ctx.root, graph);
      if (ctx.flags['as-base']) writeJson(baseGraphFile(ctx.root), graph);
      const routes = new Set(Object.keys(graph.screens));
      const facts = Object.values(graph.files);
      const summary = {
        screens: routes.size,
        files: facts.length,
        selectors: facts.reduce((n, f) => n + f.selectors.length, 0),
        edges: facts.reduce((n, f) => n + f.navigates.length, 0),
        seconds: (Date.now() - started) / 1000,
        wrote: graphFile(ctx.root),
      };
      const text = [
        `  screens    ${summary.screens}`,
        `  files      ${summary.files}`,
        `  selectors  ${summary.selectors}`,
        `  edges      ${summary.edges}`,
        `  took       ${summary.seconds.toFixed(1)}s`,
        `  wrote      ${summary.wrote}`,
        ...(dropped ? [`  collected  ${dropped} rows for screens that are gone`] : []),
        ...graph.warnings.slice(0, 5).map((w) => `  warning    ${w}`),
        ...(graph.warnings.length > 5 ? [`  …          ${graph.warnings.length - 5} more warnings (--json)`] : []),
      ];
      return { text: text.join('\n'), json: { ...summary, dropped, warnings: graph.warnings }, ...(routes.size ? {} : { code: 1 }) };
    },
  }),
  define({
    name: 'map screens',
    group: 'map',
    summary: 'Every route in the graph, and every route a run has actually opened',
    needs: 'graph',
    run: async (ctx) => {
      const fromSource = new Set(Object.keys(ctx.graph().screens));
      const seen = screens.observed(lynkeusDir(ctx.root));
      const rows = [...new Set([...fromSource, ...seen.keys()])]
        .sort()
        .map((route) => ({ route, source: fromSource.has(route), seen: seen.get(route)?.seen ?? 0 }));
      const text = rows.map((r) => `${r.route}${r.source ? '' : '  (observed only)'}${r.seen ? `  seen ${r.seen}x` : ''}`).join('\n');
      return { text, json: rows };
    },
  }),
  define({
    name: 'map show',
    mcp: 'core',
    group: 'map',
    summary: 'testIDs and navigations a screen is likely to have, from source',
    positionals: [{ name: 'route', help: 'e.g. Settings.Main', required: true }],
    needs: 'graph',
    run: async (ctx) => {
      const route = ctx.args[0]!;
      const v = vocabularyOf(ctx.graph(), route);
      const seen = screens.observed(lynkeusDir(ctx.root)).get(route);
      if (!v && !seen) return { text: `Unknown route ${route}`, code: 1 };
      // Observed first: a testID read off the running app is a fact; one from source is a guess about which screen renders it.
      const observedIds = seen?.testIds ?? [];
      const fromSource = new Set((v?.selectors ?? []).map((s) => s.id));
      const sourceOnly = (v?.selectors ?? []).filter((s) => !observedIds.includes(s.id));
      const navigatesTo = v?.navigatesTo ?? [];
      const lines = [
        `${route}  (${v?.file ?? 'not in the source graph'})`,
        seen ? `seen ${seen.seen}x, last ${seen.date}${seen.path.length ? `  [${seen.path.join(' > ')}]` : ''}` : 'never opened by a run',
        '',
        'selectors:',
        ...observedIds.map((id) => `  #${id}${fromSource.has(id) ? '' : '  (observed)'}`),
        ...sourceOnly.map((s) => `  #${s.id}  (source only, not seen)`),
        ...(observedIds.length + sourceOnly.length === 0 ? ['  (none)'] : []),
        '',
        'navigates to:',
        ...navigatesTo.map((e) => `  ${e.to}  ${e.via.kind === 'testId' ? `via #${e.via.testId}` : `(${e.via.kind})`}`),
        ...(navigatesTo.length === 0 ? ['  (none)'] : []),
      ];
      return {
        text: lines.join('\n'),
        json: {
          ...(v ?? { route, file: null, selectors: [], navigatesTo: [], filesConsidered: 0 }),
          observed: seen ?? null,
          observedOnly: observedIds.filter((id) => !fromSource.has(id)),
        },
      };
    },
  }),
  define({
    name: 'map paths',
    group: 'map',
    summary: 'What leads to a route: observed edges first, then static',
    positionals: [{ name: 'route', help: 'e.g. Checkout.Confirm', required: true }],
    needs: 'graph',
    run: async (ctx) => {
      const list = pathsTo(ctx.graph(), ctx.args[0]!, edges.load(edgesFile(ctx.root)));
      const text = list.map((a) => `  ${a.source.padEnd(8)} ${a.via.padEnd(40)} from ${a.from}${a.seen ? `  (seen ${a.seen}×)` : ''}`).join('\n');
      return { text: text || '(nothing known)', json: list };
    },
  }),
  define({
    name: 'map plan',
    mcp: 'core',
    group: 'map',
    summary: 'Directions from one route to another: which buttons to press, screen by screen',
    flags: {
      from: { type: 'string', help: 'starting route', value: 'Route' },
      to: { type: 'string', help: 'destination route', value: 'Route' },
    },
    aliases: ['plan'],
    needs: 'graph',
    run: async (ctx) => {
      const from = ctx.flags.from as string | undefined;
      const to = ctx.flags.to as string | undefined;
      if (!from || !to) throw new Error('map plan needs --from <Route> --to <Route>');
      const steps = plan(ctx.graph(), from, to, edges.load(edgesFile(ctx.root)));
      if (!steps) return { text: `No known path from ${from} to ${to}. Crawl to learn more edges.`, code: 1 };
      return { text: steps.length ? describePlan(steps) : 'Already there.', json: steps };
    },
  }),
  define({
    name: 'map impact',
    group: 'map',
    summary: 'Screens a change can reach, nearest first',
    positionals: [{ name: 'file', help: 'changed source files', required: true, rest: true }],
    flags: {
      depth: { type: 'number', help: 'how many imports away to look', default: 4, value: 'n' },
      direct: { type: 'boolean', help: 'only the screen and its importers' },
    },
    needs: 'graph',
    run: async (ctx) => {
      const depth = ctx.flags.depth as number;
      const graph = ctx.graph();
      const entry = changedAppEntry(ctx.root, ctx.args);
      // A file given with uncommitted edits to a string table reaches only what names the changed keys.
      const reach = entry
        ? undefined
        : await reachOfChanges(ctx.root, graph, ctx.args, { base: 'HEAD', depth, runtime: await runtimeAt(ctx.root), relative: true });
      const all: Affected[] = entry ? Object.keys(graph.screens).map((route) => ({ route, distance: 0, via: entry, through: [] })) : reach!.affected;
      const notes = reach?.notes.map((n) => `  ${n}`) ?? [];
      const affected = ctx.flags.direct ? all.filter((a) => a.distance <= 1) : all;
      if (affected.length === 0) {
        const text =
          all.length === 0
            ? `  (no screen imports these files, directly or through ${depth} levels)`
            : `  (nothing within one import; ${all.length} screens further away, a shared module. Drop --direct to list them.)`;
        return { text: [...notes, text].join('\n'), json: affected };
      }
      const lines = [...notes, ...describeAffected(affected, false)];
      const far = affected.filter((a) => a.distance > 1).length;
      if (far > 20) lines.push(`  (${far} screens more than one import away, a shared module; --direct narrows to what to test first)`);
      return { text: lines.join('\n'), json: affected };
    },
  }),
  define({
    name: 'map ci',
    group: 'map',
    summary: 'Write a GitHub workflow that comments on each pull request which screens its diff reaches',
    details:
      'Writes `.github/workflows/lynkeus-map-check.yml` in the app. On every pull request it builds the map from the sources (no app, no device, well under a second of analysis), runs `map check` against the base branch and keeps one comment on the PR up to date. `--force` overwrites an existing file.',
    flags: {
      force: { type: 'boolean', help: 'overwrite the workflow if it exists' },
      depth: { type: 'number', help: 'how many imports away the check looks', default: 2, value: 'n' },
    },
    needs: 'nothing',
    run: async (ctx) => {
      const file = path.join(ctx.root, '.github', 'workflows', 'lynkeus-map-check.yml');
      if (fs.existsSync(file) && !ctx.flags.force) return { text: `${path.relative(ctx.root, file)} exists; --force overwrites it`, code: 1 };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, mapCheckWorkflow(ctx.flags.depth as number));
      return { text: `wrote ${path.relative(ctx.root, file)}`, json: { file } };
    },
  }),
  define({
    name: 'map check',
    group: 'map',
    summary: "A branch from the app's side: screens its diff reaches, routes/navigations/testIDs that changed",
    flags: {
      base: { type: 'string', help: 'git ref to diff against', default: 'main', value: 'ref' },
      'graph-base': { type: 'string', help: 'graph to diff against (default .lynkeus/graph.base.json)', value: 'file' },
      depth: { type: 'number', help: 'how many imports away to look', default: 4, value: 'n' },
    },
    needs: 'graph',
    run: async (ctx) => {
      const graph = ctx.graph();
      const base = ctx.flags.base as string;
      const runtime = await runtimeAt(ctx.root);
      const changed = changedSources(ctx.root, base, ctx.err, runtime.sources);
      const { affected, notes } = await reachOfChanges(ctx.root, graph, changed, {
        base,
        depth: ctx.flags.depth as number,
        runtime,
        relative: runtime.sources.relative,
      });
      const lines = [`changed against ${base}: ${changed.length} source file(s)`, ...notes.map((n) => `  ${n}`), ...describeAffected(affected, true)];
      if (!affected.length && changed.length) lines.push('  (no screen imports these files within the depth)');
      const baseFile = (ctx.flags['graph-base'] as string | undefined) ?? baseGraphFile(ctx.root);
      const graphDiff = fs.existsSync(baseFile) ? diffGraphs(readJson<ScreenGraph>(baseFile), graph) : undefined;
      if (graphDiff) lines.push(`graph against ${path.relative(ctx.root, baseFile)}:`, describeGraphDiff(graphDiff));
      else lines.push(`graph: no baseline (run \`lynkeus map build --as-base\` on ${base} to diff routes, navigations and testIDs)`);
      if (affected.length) {
        const first = affected.slice(0, 5).map((a) => a.route);
        lines.push(
          `next: run the cases that cover ${first.join(', ')}${affected.length > 5 ? ', …' : ''}; \`lynkeus lint --baseline <file>\` on those screens prints what is new`,
        );
      }
      return { text: lines.join('\n'), json: { base, changed, affected, notes, graphDiff } };
    },
  }),
  define({
    name: 'map changes',
    group: 'map',
    summary: 'testIDs that appeared, disappeared or moved on a recorded screen since it was last read',
    flags: { last: { type: 'number', help: 'how many changes', default: 30, value: 'n' } },
    needs: 'nothing',
    run: async (ctx) => {
      const list = screens.changes(lynkeusDir(ctx.root), ctx.flags.last as number);
      if (list.length === 0) return { text: '(no recorded screen changes; record with `lynkeus screen --record` or LYNKEUS_RECORD_SCREENS=1)', json: [] };
      return { text: list.map(screens.describeChange).join('\n'), json: list };
    },
  }),
];

// Pinned to the CLI that wrote it: an unpinned npx takes whatever is latest on the day CI runs, which can read the map differently.
export const mapCheckWorkflow = (depth: number, version = CLI_VERSION): string => `name: lynkeus map check
on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

jobs:
  map-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v5
        with:
          node-version: 22
      - name: Build the map and check the diff
        run: |
          npx --yes lynkeus@${version} map build > /dev/null
          npx --yes lynkeus@${version} map check --base origin/\${{ github.base_ref }} --depth ${depth} > map-check.txt
      - name: Comment on the pull request
        env:
          GH_TOKEN: \${{ github.token }}
        run: |
          {
            echo '<!-- lynkeus map check -->'
            echo '**Screens this diff reaches** (lynkeus map check)'
            echo
            echo '\`\`\`'
            cat map-check.txt
            echo '\`\`\`'
          } > body.md
          gh pr comment \${{ github.event.pull_request.number }} --edit-last --body-file body.md || gh pr comment \${{ github.event.pull_request.number }} --body-file body.md
`;

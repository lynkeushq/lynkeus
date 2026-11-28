import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { CI_TARGETS, declaredTargets, type TargetName } from '../cases/onTargets.js';
import { edgesFile, graphFile, type LynkeusConfig, lynkeusDir, saveGraph } from '../config.js';
import { CLI_VERSION } from '../device/agentVersion.js';
import { readJson, writeJson } from '../files.js';
import * as edges from '../knowledge/edges.js';
import { describePlan, plan } from '../knowledge/plan.js';
import { type Affected, IMPACT_DEPTH, pathsTo, screensAffectedBy, vocabularyOf } from '../knowledge/query.js';
import * as screens from '../knowledge/screens.js';
import { type IdentifierNarrowing, narrowIdentifierChanges } from '../knowledge/identifiers.js';
import { narrowStringTables, type StringNarrowing } from '../knowledge/stringTables.js';
import type { ScreenGraph } from '../knowledge/types.js';
import { define } from '../registry.js';
import type { RuntimeAdapter } from '../runtimes/index.js';
import { runtimeAt } from '../runtimes/index.js';
import { changedAppEntry } from './appEntry.js';
import { describeGraphDiff, diffGraphs } from './check.js';
import { managerOf } from './init.js';

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

/** A diff against a base that git could not make: an error, never "nothing changed" (that would pass a branch untested). */
export class DiffError extends Error {}

const gitError = (error: unknown): string => {
  const stderr = (error as { stderr?: unknown })?.stderr;
  const said = (typeof stderr === 'string' ? stderr : Buffer.isBuffer(stderr) ? stderr.toString() : '').trim();
  const fatal = said.split('\n').find((l) => /^(fatal|error):/.test(l)) ?? said.split('\n')[0];
  return fatal || (error instanceof Error ? error.message.split('\n')[0]! : String(error));
};

/** Why a diff against `base` failed, with what to do about it: a ref that is not here, a shallow checkout, no repository. */
const diffFailure = (root: string, base: string, error: unknown): DiffError => {
  const quiet = (...args: string[]) => {
    try {
      return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return undefined;
    }
  };
  const said = gitError(error);
  if (quiet('rev-parse', '--git-dir') === undefined) return new DiffError(`could not diff against ${base}: ${said} (${root} is not in a git checkout)`);
  const shallow = quiet('rev-parse', '--is-shallow-repository') === 'true';
  const known = quiet('rev-parse', '--verify', '--quiet', `${base}^{commit}`) !== undefined;
  const branch = base.replace(/^origin\//, '');
  const fix = !known
    ? `${base} is not a ref in this checkout: pass --base with one that is (\`git branch -a\` lists them), or fetch it first (\`git fetch origin ${branch}\`)${shallow ? '; the checkout is also shallow: `git fetch --unshallow` (actions/checkout: fetch-depth: 0)' : ''}`
    : shallow
      ? `the checkout is shallow and does not hold where this branch left ${base}: \`git fetch --unshallow\` (actions/checkout: fetch-depth: 0), or \`git fetch --deepen=200 origin ${branch}\``
      : `check that ${base} and this branch share history (\`git merge-base ${base} HEAD\`)`;
  return new DiffError(`could not diff against ${base}: ${said}\n${fix}`);
};

/**
 * Source files a branch changed against `base`, committed or not. Throws a DiffError when git cannot make the diff
 * (an unknown ref, a shallow checkout without the base): no list is not an empty list.
 */
export const changedSources = (root: string, base: string, sources: RuntimeAdapter['sources']): string[] => {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const diff = sources.relative ? ['diff', '--name-only', '--relative'] : ['diff', '--name-only'];
  const source = sources.pattern;
  let names: string;
  try {
    names = `${git(...diff, `${base}...HEAD`)}\n${git(...diff, 'HEAD')}`;
  } catch (error) {
    throw diffFailure(root, base, error);
  }
  return [
    ...new Set(
      names
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => source.test(l)),
    ),
  ];
};

/**
 * The screens `changed` reaches through imports. A file whose change is only testIDs or labels (`narrowIdentifierChanges`)
 * reaches only the cases naming them, and each changed string table only the files naming its changed keys
 * (`narrowStringTables`). `base` is what the diff is against (`changedSources`); `relative` says the names are from
 * the app's folder rather than the repository's root.
 */
export const reachOfChanges = async (
  root: string,
  graph: ScreenGraph,
  changed: string[],
  options: { base: string; depth?: number; runtime: Pick<RuntimeAdapter, 'stringTable' | 'identifierChange'>; relative: boolean },
): Promise<{ affected: Affected[]; texts: StringNarrowing['texts']; ids: IdentifierNarrowing['ids']; notes: string[] }> => {
  const { stringTable: table, identifierChange } = options.runtime;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const sources = (() => {
    if (!table && !identifierChange) return undefined;
    try {
      const top = options.relative ? root : git('rev-parse', '--show-toplevel').trim();
      const at = git('merge-base', options.base, 'HEAD').trim();
      return {
        now: (f: string) => (fs.existsSync(path.join(top, f)) ? fs.readFileSync(path.join(top, f), 'utf8') : undefined),
        before: (f: string) => {
          try {
            return git('show', `${at}:${options.relative ? `./${f}` : f}`);
          } catch {
            return undefined;
          }
        },
      };
    } catch {
      return undefined;
    }
  })();
  const identifiers =
    sources && identifierChange ? await narrowIdentifierChanges(changed, { ...sources, change: identifierChange }).catch(() => undefined) : undefined;
  const rest = identifiers?.files ?? changed;
  const narrowed = sources && table ? await narrowStringTables(rest, graph, { ...sources, table }).catch(() => undefined) : undefined;
  return {
    affected: screensAffectedBy(graph, narrowed?.files ?? rest, options.depth),
    texts: [...(narrowed?.texts ?? []), ...(identifiers?.labels ?? [])],
    ids: identifiers?.ids ?? [],
    notes: [...(identifiers?.notes ?? []), ...(narrowed?.notes ?? [])],
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
      depth: { type: 'number', help: 'how many imports away to look', default: IMPACT_DEPTH, value: 'n' },
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
      "Writes `.github/workflows/lynkeus-map-check.yml` in the app. On every pull request it builds the map from the sources (no app, no device, well under a second of analysis), runs `map check` against the base branch and keeps one comment on the PR up to date. `--cases` adds a job that runs the cases the pull request reaches with `lynkeus ci --affected`, on the project's CI targets (headless and FastSim in cases.targets; for FastSim it installs the kit and bundles the app first); that job needs LYNKEUS_TOKEN, LYNKEUS_CLOUD_KEY for FastSim and LYNKEUS_REPORTS_KEY with ci.push in the repository's secrets, and a backend (ci.backend). Without `--cases`, when cases.targets has such targets, it says what `--cases` would add. `--force` overwrites an existing file.",
    flags: {
      force: { type: 'boolean', help: 'overwrite the workflow if it exists' },
      depth: { type: 'number', help: 'how many imports away the check looks (as `case impact`)', default: IMPACT_DEPTH, value: 'n' },
      cases: {
        type: 'boolean',
        help: "also run the cases the pull request reaches with `lynkeus ci --affected`, on the project's CI targets (cases.targets: headless, fastsim:ios, fastsim:android)",
      },
    },
    needs: 'nothing',
    run: async (ctx) => {
      const file = path.join(ctx.root, '.github', 'workflows', 'lynkeus-map-check.yml');
      if (fs.existsSync(file) && !ctx.flags.force) return { text: `${path.relative(ctx.root, file)} exists; --force overwrites it`, code: 1 };
      const version = ciVersion(ctx.root);
      const job = casesJobPlan(ctx.config);
      if (typeof job === 'string') return { text: job, code: 2 };
      if (ctx.flags.cases && job.declared && job.targets.length === 0)
        return { text: 'cases.targets has no target a CI job can start (headless, fastsim:ios, fastsim:android): --cases would run nothing', code: 2 };
      const cases = ctx.flags.cases ? { manager: managerOf(ctx.root), ...job } : undefined;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, mapCheckWorkflow(ctx.flags.depth as number, version.range, cases));
      const secrets = (o: CasesJobPlan) => o.secrets.join(', ');
      const where = job.declared ? job.targets.join(', ') : 'ci.hosts.command, else headless (no cases.targets declared)';
      const lines = [
        `wrote ${path.relative(ctx.root, file)} (lynkeus@${version.range}, --depth ${ctx.flags.depth}${cases ? ', with a cases job' : ''})`,
        ...(version.note ? [version.note] : []),
        ...(cases
          ? [
              `the cases job runs \`lynkeus ci --affected\` on ${where}; it needs ${secrets(job)} in the repository's secrets${job.backend ? '' : ', and a backend the app reaches (ci.backend in lynkeus.config.json brings one up; none is declared)'}`,
            ]
          : job.targets.length > 0
            ? [
                `--cases would also run the cases each pull request reaches on ${where} (\`lynkeus ci --affected\`); that job needs ${secrets(job)} in the repository's secrets${job.backend ? '' : ' and a backend (ci.backend)'}`,
              ]
            : []),
      ];
      return { text: lines.join('\n'), json: { file, version: version.range, depth: ctx.flags.depth, ...(cases ? { cases: job } : {}) } };
    },
  }),
  define({
    name: 'map check',
    group: 'map',
    summary: "A branch from the app's side: screens its diff reaches, routes/navigations/testIDs that changed",
    flags: {
      base: { type: 'string', help: 'git ref to diff against', default: 'main', value: 'ref' },
      'graph-base': { type: 'string', help: 'graph to diff against (default .lynkeus/graph.base.json)', value: 'file' },
      depth: { type: 'number', help: 'how many imports away to look', default: IMPACT_DEPTH, value: 'n' },
    },
    needs: 'graph',
    run: async (ctx) => {
      const graph = ctx.graph();
      const base = ctx.flags.base as string;
      const runtime = await runtimeAt(ctx.root);
      const changed = changedSources(ctx.root, base, runtime.sources);
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
          `next: run the cases that cover ${first.join(', ')}${affected.length > 5 ? ', …' : ''} on the project's targets (\`case run --on targets $(lynkeus case impact --files)\`, or \`lynkeus ci --affected\` in CI); \`lynkeus lint --baseline <file>\` on those screens prints what is new`,
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

const DEPENDENCIES = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

/** `0.7.7-dev.2026…` → `^0.7.7`: what npm will have once that release is out, never a build only this machine has. */
const released = (version: string): string => `^${version.replace(/^[\^~=v]+/, '').split(/[-+]/)[0]}`;

/**
 * The lynkeus a generated workflow runs: the range the app depends on (lynkeus, else lynkeus-agent or
 * lynkeus-headless, which are released together with it), else the CLI's own release. A dev build or a local
 * path (`file:`, `link:`, `workspace:`) is never written: CI cannot fetch it, so the release it leads to is.
 */
export const ciVersion = (root: string, cli = CLI_VERSION, published: Published = registry.published): { range: string; note?: string } => {
  const wanted = wantedVersion(root, cli);
  // A range nothing published satisfies yet (a release still in development) would fail every CI run: the last
  // release is run instead, and the note says to move it on once that release is out (trial run 10: ^0.7.7).
  const answer = published(wanted.range);
  if (answer === undefined)
    return {
      ...wanted,
      note: [wanted.note, `npm could not be asked whether lynkeus@${wanted.range} is published: check it before the workflow runs`].filter(Boolean).join('; '),
    };
  if (answer.matches) return wanted;
  if (!answer.latest) return wanted;
  const range = `^${answer.latest}`;
  return {
    range,
    note: `no published lynkeus matches ${wanted.range} yet${wanted.note ? ` (${wanted.note.split(':')[0]})` : ''}: the workflow runs lynkeus@${range}, the last release; move it on once ${wanted.range.replace(/^\^/, '')} is out`,
  };
};

/** Whether npm has a lynkeus in `range`, and its latest release; undefined when npm cannot be asked. */
export type Published = (range: string) => { matches: boolean; latest?: string } | undefined;

const npmPublished: Published = (range) => {
  const ask = (spec: string): string | undefined => {
    try {
      return execFileSync('npm', ['view', spec, 'version', '--json'], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch (error) {
      // npm exits non-zero with E404 when nothing matches: an answer, not an outage.
      const out = String((error as { stdout?: unknown }).stdout ?? '');
      return /E404|"code":\s*"E404"/.test(out) ? '' : undefined;
    }
  };
  const matching = ask(`lynkeus@${range}`);
  if (matching === undefined) return undefined;
  if (matching !== '' && matching !== '[]') return { matches: true };
  const latest = ask('lynkeus');
  const version = latest ? (JSON.parse(latest) as string) : undefined;
  return { matches: false, ...(typeof version === 'string' ? { latest: version } : {}) };
};

/** Where `map ci` asks what is published; a test answers in npm's place. */
export const registry: { published: Published } = { published: npmPublished };

/** The range the app asks for (see ciVersion), before npm is asked whether it is out. */
const wantedVersion = (root: string, cli: string): { range: string; note?: string } => {
  let pkg: Partial<Record<(typeof DEPENDENCIES)[number], Record<string, string>>> = {};
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch {
    // No package.json: the CLI's own release.
  }
  for (const name of ['lynkeus', 'lynkeus-agent', 'lynkeus-headless']) {
    const spec = DEPENDENCIES.map((d) => pkg[d]?.[name]).find((v) => typeof v === 'string');
    if (!spec) continue;
    if (/^(file|link|workspace|portal|git\+?|https?):/.test(spec) || /\d+\.\d+\.\d+-/.test(spec)) {
      const base = /\d+\.\d+\.\d+/.exec(spec)?.[0] ?? cli;
      const range = released(base);
      return {
        range,
        note: `${name} is ${spec} in package.json, which CI cannot install: the workflow runs lynkeus@${range}, published once that release is out`,
      };
    }
    return { range: spec };
  }
  if (/\d+\.\d+\.\d+-/.test(cli))
    return {
      range: released(cli),
      note: `this lynkeus is a dev build (${cli}): the workflow runs lynkeus@${released(cli)}, published once that release is out`,
    };
  return { range: `^${cli}` };
};

// A range the project depends on, never "latest": an unpinned npx takes whatever is out the day CI runs, which can read the map differently.
type CasesJobPlan = {
  /** Whether the project declares cases.targets; without, `lynkeus ci` runs on ci.hosts.command or headless. */
  declared: boolean;
  /** The declared targets a CI job can start. */
  targets: TargetName[];
  /** The secrets the job reads, by name. */
  secrets: string[];
  /** Whether ci.backend brings a backend up. */
  backend: boolean;
};

/** What a cases job of the workflow would run and need, from the configuration; a sentence when cases.targets is wrong. */
export const casesJobPlan = (config: LynkeusConfig): CasesJobPlan | string => {
  const declared = declaredTargets({}, config.cases?.targets);
  if (typeof declared === 'string') return declared;
  const targets = (declared ?? []).filter((t) => CI_TARGETS.includes(t));
  const fastsim = targets.some((t) => t.startsWith('fastsim')) || (!declared && /fastsim-run/.test(config.ci?.hosts?.command ?? ''));
  return {
    declared: declared !== undefined,
    targets,
    // The token is per machine and kept out of git: the job's hosts and driver need the same one.
    secrets: ['LYNKEUS_TOKEN', ...(fastsim ? ['LYNKEUS_CLOUD_KEY'] : []), ...(config.ci?.push ? ['LYNKEUS_REPORTS_KEY'] : [])],
    backend: config.ci?.backend !== undefined,
  };
};

const INSTALL: Record<string, string> = {
  pnpm: 'corepack enable && pnpm install --frozen-lockfile',
  yarn: 'corepack enable && yarn install',
  bun: 'npx --yes bun install --frozen-lockfile',
  npm: 'npm ci',
};

/**
 * The job that runs the cases a pull request reaches. FastSim's bundles live in the git-ignored .lynkeus, so the job
 * installs the kit of each declared platform and bundles the app before `lynkeus ci` looks for them.
 */
const casesJob = (version: string, o: CasesJobPlan & { manager: string }): string => {
  const npx = `npx --yes 'lynkeus@${version}'`;
  const bundles = (['ios', 'android'] as const)
    .filter((p) => o.targets.includes(`fastsim:${p}`))
    .map(
      (p) => `      - name: Install Lynkeus FastSim for ${p} and bundle the app
        run: |
          kit=$(${npx} fastsim install --platform ${p} --json | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(0, 'utf8')).dir)")
          "$kit/bin/fastsim-bundle" . .lynkeus/fastsim-${p} ${p}
`,
    )
    .join('');
  // FastSim draws iOS as the Simulator does only on a Mac (Apple Silicon); Android and headless run anywhere.
  const runner = o.targets.includes('fastsim:ios') ? 'macos-latest' : 'ubuntu-latest';
  return `
  cases:
    runs-on: ${runner}
    env:
${o.secrets.map((s) => `      ${s}: \${{ secrets.${s} }}`).join('\n')}
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v5
        with:
          node-version: 22
      - run: ${INSTALL[o.manager] ?? INSTALL.npm}
${bundles}      - name: Run the cases this diff reaches
        run: ${npx} ci --affected --base origin/\${{ github.base_ref }}
`;
};

export const mapCheckWorkflow = (depth: number, version: string, cases?: CasesJobPlan & { manager: string }): string => `name: lynkeus map check
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
          npx --yes 'lynkeus@${version}' map build > /dev/null
          npx --yes 'lynkeus@${version}' map check --base origin/\${{ github.base_ref }} --depth ${depth} > map-check.txt
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
${cases ? casesJob(version, cases) : ''}`;

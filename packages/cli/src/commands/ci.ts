import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { coverageOf, impactOf, readSeen, withIdCases, withTextCases } from '../cases/coverage.js';
import { readCases } from '../cases/format.js';
import { readJson } from '../files.js';
import type { ScreenGraph } from '../knowledge/types.js';
import { DEFAULT_PORT, portFromEnv } from '../config.js';
import { define } from '../registry.js';
import { changedAppEntry, entryReason } from './appEntry.js';
import { caseFiles } from './cases.js';
import { hostsFileOf, stopLeftHosts } from '../cases/hostPids.js';
import { freePorts } from '../cases/portClaim.js';
import { PROGRESS_FILE } from '../cases/progress.js';
import { runtimeAt } from '../runtimes/index.js';
import { changedSources, reachOfChanges } from './map.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The case results of a run folder, by each case's last attempt. */
export const resultsOf = (dir: string): { id: string; result: string; title?: string }[] => {
  const file = path.join(dir, 'cases.jsonl');
  if (!fs.existsSync(file)) return [];
  const last = new Map<string, { id: string; result: string; title?: string }>();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const c = JSON.parse(line) as { id: string; result: string; title?: string };
    last.set(c.id, c);
  }
  return [...last.values()];
};

/** The summary a CI job shows: how many passed, which failed, and the report. */
export const summaryOf = (results: { id: string; result: string; title?: string }[], report: string | undefined, picked: string): string => {
  const failed = results.filter((r) => r.result === 'failed');
  const passed = results.filter((r) => r.result === 'passed').length;
  return [
    `### lynkeus: ${passed}/${results.length} cases passed${failed.length ? `, ${failed.length} failed` : ''}`,
    '',
    picked,
    ...(report ? ['', `[Open the report](${report})`] : []),
    ...(failed.length ? ['', '| Failed | |', '|---|---|', ...failed.map((f) => `| \`${f.id}\` | ${f.title ?? ''} |`)] : []),
    '',
  ].join('\n');
};

/**
 * The `case run` a CI job makes: one kept host per job on its own port. Frames are asked for only from hosts the
 * project names (`ci.hosts.command`, FastSim say): the default headless host draws nothing, so asking would only
 * warn on every run that no frame was kept.
 */
export const suiteArgs = (o: {
  files: string[];
  jobs: number;
  ports: number[];
  hostCommand: string;
  ownHosts: boolean;
  timeoutMs?: number;
  out: string;
  push: boolean;
  extra?: string[];
}): string[] => [
  'case',
  'run',
  ...o.files,
  '--jobs',
  String(o.jobs),
  '--ports',
  o.ports.join(','),
  '--host-command',
  o.hostCommand,
  // The run keeps one host per job and starts it again when it dies or runs short of heap.
  '--keep-hosts',
  ...(o.timeoutMs ? ['--host-timeout', String(o.timeoutMs)] : []),
  '--out',
  o.out,
  ...(o.ownHosts ? ['--screenshots'] : []),
  ...(o.push ? ['--push'] : []),
  ...(o.extra ?? []),
];

const waitFor = async (ok: () => boolean | Promise<boolean>, timeoutMs: number, every = 3000): Promise<boolean> => {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (await ok()) return true;
    if (Date.now() > until) return false;
    await sleep(every);
  }
};

/**
 * Runs `case run` as a child and waits for it, passing SIGINT and SIGTERM on so it stops its hosts. Whatever hosts
 * it left running when it ended, as a run that dies out of memory or is killed does, are stopped by the list it
 * keeps in `hostsFile`.
 */
export const runSuite = async (
  node: string,
  args: string[],
  cwd: string,
  hostsFile: string,
  say: (line: string) => void,
): Promise<{ code: number; signal?: NodeJS.Signals; report?: string }> => {
  fs.rmSync(hostsFile, { force: true });
  const child = spawn(node, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] });
  let report: string | undefined;
  let partial = '';
  child.stdout.on('data', (chunk: Buffer) => {
    process.stdout.write(chunk);
    const lines = (partial + chunk.toString()).split('\n');
    partial = lines.pop() ?? '';
    for (const line of lines) report ??= /report: (https?:\/\/\S+)/.exec(line)?.[1];
  });
  let signal: NodeJS.Signals | undefined;
  const pass = (s: NodeJS.Signals) => () => {
    signal = s;
    child.kill(s);
  };
  const onInt = pass('SIGINT');
  const onTerm = pass('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  const code = await new Promise<number>((resolve) => {
    child.once('error', (error) => {
      say(`case run did not start: ${error.message}`);
      resolve(1);
    });
    child.once('close', (exitCode, exitSignal) => {
      if (exitSignal && !signal) say(`case run died (${exitSignal})`);
      resolve(exitCode ?? 1);
    });
  }).finally(() => {
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
  });
  report ??= /report: (https?:\/\/\S+)/.exec(partial)?.[1];
  const left = await stopLeftHosts(hostsFile);
  if (left > 0) say(`stopped ${left} host(s) the run left running`);
  return { code, ...(signal ? { signal } : {}), ...(report ? { report } : {}) };
};

export const ciCommands = [
  define({
    name: 'ci',
    group: 'runs',
    summary: 'Run the suite the way a CI job does: bring the backend and N hosts up, run the cases across them, report, tear down',
    details:
      'Reads `ci` in lynkeus.config.json: `backend.up` / `backend.down` (the project’s commands; Lynkeus knows no backend) and `backend.ready` (a URL to wait for), `hosts.count` and `hosts.command` (default: a headless host; `{port}` is where it dials), `push`, and extra `run` flags. --affected runs only the cases a branch’s changes reach (as `case impact` finds them). Writes the job summary to $GITHUB_STEP_SUMMARY when it is set. The exit code is the suite’s.',
    flags: {
      affected: { type: 'boolean', help: 'only the cases the changes against --base reach' },
      base: { type: 'string', help: 'git ref --affected diffs against', default: 'origin/main', value: 'ref' },
      jobs: { type: 'number', help: 'how many hosts and jobs (default ci.hosts.count, else 2)', value: 'n' },
      out: { type: 'string', help: 'where the run goes', default: 'lynkeus-run', value: 'dir' },
      'keep-up': { type: 'boolean', help: 'leave the backend up afterwards (the hosts end with the run)' },
      'dry-run': { type: 'boolean', help: 'say what it would do and run nothing' },
    },
    needs: 'nothing',
    session: false,
    mcp: false,
    run: async (ctx) => {
      const ci = ctx.config.ci ?? {};
      const config = ctx.config.cases ?? {};
      const home = config.base ?? ctx.root;
      const self = process.argv[1]!;
      const say = (line: string) => ctx.err(`▸ ${line}`);
      const jobs = Math.max(1, Number(ctx.flags.jobs ?? ci.hosts?.count ?? 2));
      const out = path.resolve(ctx.root, String(ctx.flags.out));

      // Which cases: all, or the ones the branch's changes reach.
      const all = caseFiles([], home, config.dir);
      if (typeof all === 'string') return { text: all, code: 1 };
      let files = all;
      let picked = `All ${all.length} case files.`;
      const graphFile = path.join(ctx.root, '.lynkeus', 'graph.json');
      const screens = () => (fs.existsSync(graphFile) ? Object.keys(readJson<ScreenGraph>(graphFile).screens ?? {}).length : 0);
      if (ctx.flags.affected && screens() === 0) spawnSync(process.execPath, [self, 'map', 'build'], { cwd: ctx.root, stdio: 'inherit' });
      // With no route map no change traces to a screen: picking cases from it would pass every PR untested.
      const blind = ctx.flags.affected && screens() === 0;
      if (blind) picked = `All ${all.length} case files: the route map has no screen, so the changes cannot be traced to cases.`;
      if (ctx.flags.affected && !blind) {
        const cases = all.flatMap(readCases);
        const graph = ctx.graph();
        const coverage = coverageOf(cases, Object.keys(graph.screens).sort(), readSeen(path.join(ctx.root, '.lynkeus', 'seen')));
        const runtime = await runtimeAt(ctx.root);
        const changed = changedSources(ctx.root, String(ctx.flags.base), ctx.err, runtime.sources);
        const reach = await reachOfChanges(ctx.root, graph, changed, { base: String(ctx.flags.base), runtime, relative: runtime.sources.relative });
        const impact = withIdCases(
          withTextCases(impactOf(reach.affected, coverage, entryReason(changedAppEntry(ctx.root, changed))), cases, reach.texts),
          cases,
          reach.ids,
          config.macros,
        );
        if (!impact.reason) reach.notes.forEach(say);
        files = [...new Set(impact.cases.map((c) => c.file))];
        picked = `${files.length} of ${all.length} case files: the ones the ${changed.length} changed source file(s) against ${ctx.flags.base} reach.`;
        if (files.length === 0) {
          if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### lynkeus: no case to run\n\n${picked}\n`);
          return { text: `no case to run: ${picked}`, json: { files } };
        }
      }
      const first = portFromEnv(ctx.config) ?? DEFAULT_PORT;
      // A port some process listens on (a `lynkeus mcp` server of this project on 8123) or another run claims is
      // passed over: a host dialing it would attach to that driver, not to this run.
      const ports = await freePorts(jobs, first - 1);
      if (ports.length < jobs) return { text: `no ${jobs} free driver port(s) from ${first} up: free some, or set LYNKEUS_PORT`, code: 1 };
      const moved = ports[0] !== first ? `port ${first} is in use or claimed by another run, so the hosts take ${ports.join(', ')}` : undefined;
      const hostCommand = ci.hosts?.command ?? `LYNKEUS_PORT={port} "${process.execPath}" "${self}" headless start`;
      const runArgs = suiteArgs({ files, jobs, ports, hostCommand, ownHosts: ci.hosts?.command !== undefined, timeoutMs: ci.hosts?.timeoutMs, out, push: !!ci.push, extra: ci.run });
      if (ctx.flags['dry-run']) {
        const plan = [
          picked,
          ci.backend ? `backend: \`${ci.backend.up}\`${ci.backend.ready ? `, ready at ${ci.backend.ready}` : ''}` : 'backend: none declared (ci.backend)',
          `hosts: ${jobs} × \`${hostCommand}\` on ${ports.join(', ')}${moved ? ` (${moved})` : ''}`,
          `run: lynkeus ${runArgs.slice(0, 2).join(' ')} … ${runArgs.slice(2 + files.length).join(' ')}`,
        ];
        return { text: plan.join('\n'), json: { files, ports, hostCommand, runArgs } };
      }

      const down = () => {
        if (ctx.flags['keep-up']) return say('left up (--keep-up)');
        if (ci.backend?.down) {
          say('backend down');
          spawnSync('/bin/sh', ['-c', ci.backend.down], { cwd: ctx.root, stdio: 'inherit' });
        }
      };
      try {
        if (ci.backend) {
          say(`backend up: ${ci.backend.up}`);
          const up = spawnSync('/bin/sh', ['-c', ci.backend.up], { cwd: ctx.root, stdio: 'inherit' });
          if (up.status !== 0) return { text: `the backend did not come up (\`${ci.backend.up}\` exited ${up.status})`, code: 1 };
          if (ci.backend.ready) {
            const url = ci.backend.ready;
            say(`waiting for ${url}`);
            const ready = await waitFor(
              () =>
                fetch(url).then(
                  (r) => r.ok,
                  () => false,
                ),
              ci.backend.timeoutMs ?? 300_000,
            );
            if (!ready) return { text: `${url} never answered`, code: 1 };
          }
        }
        if (moved) say(moved);
        say(`running ${files.length} case file(s) on ${jobs} host(s): ${hostCommand}`);
        const run = await runSuite(process.execPath, [self, ...runArgs], ctx.root, hostsFileOf(path.join(out, PROGRESS_FILE)), say);
        if (run.signal) return { text: `stopped by ${run.signal}`, code: run.signal === 'SIGINT' ? 130 : 143 };
        const summary = summaryOf(resultsOf(out), run.report, picked);
        if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
        return { text: summary, code: run.code };
      } finally {
        down();
      }
    },
  }),
];

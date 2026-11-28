import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { coverageOf, impactOf, readSeen, withIdCases, withTextCases } from '../cases/coverage.js';
import { readCases } from '../cases/format.js';
import { readJson } from '../files.js';
import { navigatorRoutes } from '../knowledge/nesting.js';
import type { ScreenGraph } from '../knowledge/types.js';
import { DEFAULT_PORT, portFromEnv } from '../config.js';
import { define } from '../registry.js';
import { changedAppEntry, entryReason } from './appEntry.js';
import { caseFiles, fastsimHostCommand } from './cases.js';
import { CI_TARGETS, DEVICE_TARGETS, declaredTargets, TARGETS, type TargetName, targetSlug } from '../cases/onTargets.js';
import { fastsimBundleDir, startsFastsim } from '../cases/staleBundle.js';
import type { LynkeusConfig } from '../config.js';
import { hostsFileOf, stopLeftHosts } from '../cases/hostPids.js';
import { freePorts } from '../cases/portClaim.js';
import { PROGRESS_FILE } from '../cases/progress.js';
import { runtimeAt } from '../runtimes/index.js';
import { REPORT_FILE } from './localReport.js';
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

/** The summary a CI job shows: how many passed, which failed, and the report (one per target when the run had several). */
export const summaryOf = (
  results: { id: string; result: string; title?: string }[],
  report: string | { label: string; url: string }[] | undefined,
  picked: string,
  local?: string,
): string => {
  const failed = results.filter((r) => r.result === 'failed');
  const passed = results.filter((r) => r.result === 'passed').length;
  const reports = typeof report === 'string' ? [`[Open the report](${report})`] : (report ?? []).map((r) => `[Open the ${r.label} report](${r.url})`);
  return [
    `### lynkeus: ${passed}/${results.length} cases passed${failed.length ? `, ${failed.length} failed` : ''}`,
    '',
    picked,
    ...(reports.length ? ['', reports.join(' · ')] : []),
    ...(local ? ['', `\`${local}\` in the run folder is a report to open offline: upload the folder as an artifact to keep it.`] : []),
    ...(failed.length ? ['', '| Failed | |', '|---|---|', ...failed.map((f) => `| \`${f.id}\` | ${f.title ?? ''} |`)] : []),
    '',
  ].join('\n');
};

/**
 * The `case run` a CI job makes: a host per job on its own port (kept for headless, one per case for FastSim). Frames are asked for only from hosts the
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
  // A headless host is kept per job, reset between cases and started again when it dies or runs short of heap; a
  // FastSim host is started for each case, as nothing resets the app it holds.
  ...(startsFastsim(o.hostCommand) ? [] : ['--keep-hosts']),
  ...(o.timeoutMs ? ['--host-timeout', String(o.timeoutMs)] : []),
  '--out',
  o.out,
  ...(o.ownHosts ? ['--screenshots'] : []),
  ...(o.push ? ['--push'] : []),
  ...(o.extra ?? []),
];

/** One `case run` of a CI job: the cases one declared target takes, and the host command that target runs them on. */
export type CiLane = { target: TargetName; files: string[]; hostCommand: string; ownHosts: boolean };

/**
 * What a CI job runs when the project declares `cases.targets`: a lane per declared target CI can start (headless,
 * FastSim), each with the files of the cases that declare it; the device targets it leaves to a machine that has one;
 * and the declared targets it could not start, with why, which make the job's check incomplete. Undefined when the
 * project declares no targets (the job runs as before: `ci.hosts.command` or headless); a sentence when one names
 * something that is not a target.
 */
export const ciLanes = (
  files: string[],
  o: { root: string; config: LynkeusConfig; headless: string; kits?: string },
): { lanes: CiLane[]; device: string[]; missing: string[] } | string | undefined => {
  const project = o.config.cases?.targets;
  if (project === undefined) return undefined;
  const byTarget = new Map<TargetName, Set<string>>();
  for (const file of files)
    for (const c of readCases(file)) {
      const targets = declaredTargets(c.meta, project, path.basename(file));
      if (typeof targets === 'string') return targets;
      for (const t of targets ?? []) byTarget.set(t, (byTarget.get(t) ?? new Set()).add(file));
    }
  const configured = o.config.ci?.hosts?.command;
  // A configured command that starts no FastSim is the project's own headless host (in a container, say).
  const ownHeadless = configured !== undefined && !fastsimBundleDir(configured, o.root) ? configured : undefined;
  const lanes: CiLane[] = [];
  const device: string[] = [];
  const missing: string[] = [];
  for (const target of TARGETS) {
    const taken = byTarget.get(target);
    if (!taken) continue;
    const count = `${target} (${taken.size} case file(s))`;
    if (DEVICE_TARGETS.includes(target) || !CI_TARGETS.includes(target)) {
      device.push(count);
      continue;
    }
    if (target === 'headless') {
      lanes.push({ target, files: [...taken], hostCommand: ownHeadless ?? o.headless, ownHosts: ownHeadless !== undefined });
      continue;
    }
    const platform = target === 'fastsim:ios' ? 'ios' : target === 'fastsim:android' ? 'android' : undefined;
    const found = fastsimHostCommand(o.root, { configured, kits: o.kits, ...(platform ? { platform } : {}) });
    if ('unavailable' in found) missing.push(`${count}: ${found.unavailable}`);
    else lanes.push({ target, files: [...taken], hostCommand: found.command, ownHosts: true });
  }
  return { lanes, device, missing };
};

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
      'Reads `ci` in lynkeus.config.json: `backend.up` / `backend.down` (the project’s commands; Lynkeus knows no backend) and `backend.ready` (a URL to wait for), `hosts.count` and `hosts.command` (default: a headless host; `{port}` is where it dials), `push`, and extra `run` flags. With `cases.targets` declared, each case runs on its declared targets CI can start (headless, fastsim:ios, fastsim:android; a case’s own `targets:` replaces the project’s), one target after another, each in `<out>/<target>` when there are several; `ios` and `android` need a device and are listed, not run; a declared FastSim target with no kit or bundle here fails the job as an incomplete check. --affected runs only the cases a branch’s changes reach (as `case impact` finds them). Writes the job summary to $GITHUB_STEP_SUMMARY when it is set. The exit code is the suite’s.',
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
        const coverage = coverageOf(cases, Object.keys(graph.screens).sort(), readSeen(path.join(ctx.root, '.lynkeus', 'seen')), {
          macros: config.macros,
          navigators: navigatorRoutes(graph),
        });
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
      const headless = `LYNKEUS_PORT={port} "${process.execPath}" "${self}" headless start`;
      const declared = ciLanes(files, { root: ctx.root, config: ctx.config, headless });
      if (typeof declared === 'string') return { text: declared, code: 2 };
      const hostCommand = ci.hosts?.command ?? headless;
      const lanes: CiLane[] = declared?.lanes ?? [{ target: 'headless', files, hostCommand, ownHosts: ci.hosts?.command !== undefined }];
      // One target keeps the run folder as it always was; several each get theirs, as `case run --on` does.
      const outOf = (lane: CiLane) => (lanes.length > 1 ? path.join(out, targetSlug(lane.target)) : out);
      const argsOf = (lane: CiLane) =>
        suiteArgs({
          files: lane.files,
          jobs,
          ports,
          hostCommand: lane.hostCommand,
          ownHosts: lane.ownHosts,
          timeoutMs: ci.hosts?.timeoutMs,
          out: outOf(lane),
          push: !!ci.push,
          extra: ci.run,
        });
      const notes = [
        ...(declared?.device.length
          ? [`not run in CI, as they need a device: ${declared.device.join(', ')}; check them with \`case run --on targets\` where one is`]
          : []),
        ...(declared?.missing.length ? [`check incomplete: declared but not startable here: ${declared.missing.join('; ')}`] : []),
      ];
      if (declared && lanes.length === 0) {
        const text = [picked, ...notes, 'no declared target CI can run (headless, fastsim:ios, fastsim:android)'].join('\n');
        if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### lynkeus: no target to run\n\n${text}\n`);
        return { text, code: declared.missing.length ? 1 : 0 };
      }
      if (ctx.flags['dry-run']) {
        const plan = [
          picked,
          ci.backend ? `backend: \`${ci.backend.up}\`${ci.backend.ready ? `, ready at ${ci.backend.ready}` : ''}` : 'backend: none declared (ci.backend)',
          ...lanes.flatMap((lane) => {
            const runArgs = argsOf(lane);
            return [
              `${declared ? `${lane.target}: ${lane.files.length} case file(s), ` : ''}hosts: ${jobs} × \`${lane.hostCommand}\` on ${ports.join(', ')}${moved ? ` (${moved})` : ''}`,
              `run: lynkeus ${runArgs.slice(0, 2).join(' ')} … ${runArgs.slice(2 + lane.files.length).join(' ')}`,
            ];
          }),
          ...notes,
        ];
        const only = lanes.length === 1 ? lanes[0]! : undefined;
        return {
          text: plan.join('\n'),
          json: {
            files,
            ports,
            ...(only && !declared ? { hostCommand: only.hostCommand, runArgs: argsOf(only) } : {}),
            ...(declared ? { lanes: lanes.map((lane) => ({ ...lane, runArgs: argsOf(lane) })), device: declared.device, missing: declared.missing } : {}),
          },
        };
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
        notes.forEach(say);
        // One target after another: each brings up `jobs` hosts, and two targets' hosts at once would double the memory a runner needs.
        const runs: { lane: CiLane; code: number; report?: string }[] = [];
        for (const lane of lanes) {
          say(`running ${lane.files.length} case file(s)${declared ? ` on ${lane.target}` : ''} on ${jobs} host(s): ${lane.hostCommand}`);
          const run = await runSuite(process.execPath, [self, ...argsOf(lane)], ctx.root, hostsFileOf(path.join(outOf(lane), PROGRESS_FILE)), say);
          if (run.signal) return { text: `stopped by ${run.signal}`, code: run.signal === 'SIGINT' ? 130 : 143 };
          runs.push({ lane, code: run.code, ...(run.report ? { report: run.report } : {}) });
        }
        const several = runs.length > 1;
        const results = runs.flatMap(({ lane }) => resultsOf(outOf(lane)).map((r) => (several ? { ...r, id: `${r.id} (${lane.target})` } : r)));
        const reports = several ? runs.flatMap(({ lane, report }) => (report ? [{ label: lane.target, url: report }] : [])) : runs[0]?.report;
        const local = runs
          .filter(({ lane }) => fs.existsSync(path.join(outOf(lane), REPORT_FILE)))
          .map(({ lane }) => path.relative(out, path.join(outOf(lane), REPORT_FILE)) || REPORT_FILE);
        const summary = summaryOf(results, reports, [picked, ...notes].join('\n\n'), local.length ? local.join('`, `') : undefined);
        if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
        const code = runs.find((r) => r.code !== 0)?.code ?? (declared?.missing.length ? 1 : 0);
        return { text: summary, code };
      } finally {
        down();
      }
    },
  }),
];

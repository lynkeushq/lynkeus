import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { coverageOf, impactOf, readSeen } from '../cases/coverage.js';
import { readCases } from '../cases/format.js';
import { screensAffectedBy } from '../knowledge/query.js';
import { define } from '../registry.js';
import { caseFiles } from './cases.js';
import { changedSources } from './map.js';

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

const waitFor = async (ok: () => boolean | Promise<boolean>, timeoutMs: number, every = 3000): Promise<boolean> => {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (await ok()) return true;
    if (Date.now() > until) return false;
    await sleep(every);
  }
};

export const ciCommands = [
  define({
    name: 'ci',
    group: 'runs',
    summary: 'Run the suite the way a CI job does: bring the backend and N hosts up, run the cases across them, report, tear down',
    details:
      'Reads `ci` in lynkeus.config.json: `backend.up` / `backend.down` (the project’s commands; lynkeus knows no backend) and `backend.ready` (a URL to wait for), `hosts.count` and `hosts.command` (default: a headless host; `{port}` is where it dials), `push`, and extra `run` flags. --affected runs only the cases a branch’s changes reach (as `case impact` finds them). Writes the job summary to $GITHUB_STEP_SUMMARY when it is set. The exit code is the suite’s.',
    flags: {
      affected: { type: 'boolean', help: 'only the cases the changes against --base reach' },
      base: { type: 'string', help: 'git ref --affected diffs against', default: 'origin/main', value: 'ref' },
      jobs: { type: 'number', help: 'how many hosts and jobs (default ci.hosts.count, else 2)', value: 'n' },
      out: { type: 'string', help: 'where the run goes', default: 'lynkeus-run', value: 'dir' },
      'keep-up': { type: 'boolean', help: 'leave the backend and the hosts up afterwards' },
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
      if (ctx.flags.affected) {
        const graphFile = path.join(ctx.root, '.lynkeus', 'graph.json');
        if (!fs.existsSync(graphFile)) spawnSync(process.execPath, [self, 'map', 'build'], { cwd: ctx.root, stdio: 'inherit' });
        const cases = all.flatMap(readCases);
        const graph = ctx.graph();
        const coverage = coverageOf(cases, Object.keys(graph.screens).sort(), readSeen(path.join(ctx.root, '.lynkeus', 'seen')));
        const changed = changedSources(ctx.root, String(ctx.flags.base), ctx.err);
        const impact = impactOf(screensAffectedBy(graph, changed), coverage);
        files = [...new Set(impact.cases.map((c) => c.file))];
        picked = `${files.length} of ${all.length} case files: the ones the ${changed.length} changed source file(s) against ${ctx.flags.base} reach.`;
        if (files.length === 0) {
          if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### lynkeus: no case to run\n\n${picked}\n`);
          return { text: `no case to run: ${picked}`, json: { files } };
        }
      }
      const ports = Array.from({ length: jobs }, (_, i) => 8123 + i);
      const hostCommand = ci.hosts?.command ?? `LYNKEUS_PORT={port} "${process.execPath}" "${self}" headless start`;
      const runArgs = [
        'case',
        'run',
        ...files,
        '--jobs',
        String(jobs),
        '--ports',
        ports.join(','),
        '--out',
        out,
        '--screenshots',
        ...(ci.push ? ['--push'] : []),
        ...(ci.run ?? []),
      ];
      if (ctx.flags['dry-run']) {
        const plan = [
          picked,
          ci.backend ? `backend: \`${ci.backend.up}\`${ci.backend.ready ? `, ready at ${ci.backend.ready}` : ''}` : 'backend: none declared (ci.backend)',
          `hosts: ${jobs} × \`${hostCommand}\` on ${ports.join(', ')}`,
          `run: lynkeus ${runArgs.slice(0, 2).join(' ')} … ${runArgs.slice(2 + files.length).join(' ')}`,
        ];
        return { text: plan.join('\n'), json: { files, ports, hostCommand, runArgs } };
      }

      const hosts: ChildProcess[] = [];
      const down = () => {
        if (ctx.flags['keep-up']) return say('left up (--keep-up)');
        for (const h of hosts)
          if (h.pid)
            try {
              process.kill(-h.pid, 'SIGTERM');
            } catch {}
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
        say(`${jobs} host${jobs === 1 ? '' : 's'}: ${hostCommand}`);
        for (const port of ports)
          hosts.push(
            spawn('/bin/sh', ['-c', hostCommand.replaceAll('{port}', String(port))], { cwd: ctx.root, stdio: ['pipe', 'ignore', 'ignore'], detached: true }),
          );
        // A host compiles the app before it answers: the slow part.
        for (const port of ports) {
          const answered = () =>
            spawnSync(process.execPath, [self, 'screen'], {
              cwd: ctx.root,
              env: { ...process.env, LYNKEUS_PORT: String(port) },
              stdio: 'ignore',
              timeout: 20_000,
            }).status === 0;
          if (!(await waitFor(answered, ci.hosts?.timeoutMs ?? 600_000, 5000))) return { text: `the host on ${port} never attached`, code: 1 };
          say(`host on ${port} ready`);
        }
        say(`running ${files.length} case file(s) on ${jobs} host(s)`);
        const run = spawnSync(process.execPath, [self, ...runArgs], {
          cwd: ctx.root,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'inherit'],
          maxBuffer: 64 * 1024 * 1024,
        });
        process.stdout.write(run.stdout ?? '');
        const report = /report: (https?:\/\/\S+)/.exec(run.stdout ?? '')?.[1];
        const summary = summaryOf(resultsOf(out), report, picked);
        if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
        return { text: summary, code: run.status ?? 1 };
      } finally {
        down();
      }
    },
  }),
];

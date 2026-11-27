/**
 * `case run --on`: the same cases on several targets at once (the attached Simulator or emulator, Lynkeus FastSim,
 * the headless host), each run as `case run` runs on it alone, and answered with one line per case per target. A
 * target this machine cannot run on is said once, with why, and fails nothing.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { FlagValues } from '../args.js';
import type { Ctx, Result } from '../registry.js';
import type { ProgressEvent } from './progress.js';
import { writeLastRun } from './progress.js';
import type { CaseReport } from './runner.js';

export const TARGETS = ['simulator', 'fastsim', 'headless'] as const;
export type TargetName = (typeof TARGETS)[number];

const NAMES: Record<string, TargetName> = { simulator: 'simulator', emulator: 'simulator', device: 'simulator', fastsim: 'fastsim', headless: 'headless' };

/** The targets `--on` names, in the order the answer lists them; a sentence when one is not a target. */
export const parseTargets = (value: string): TargetName[] | string => {
  const words = value
    .split(',')
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);
  const picked = new Set<TargetName>();
  for (const word of words) {
    if (word === 'all') for (const t of TARGETS) picked.add(t);
    else if (NAMES[word]) picked.add(NAMES[word]);
    else return `--on ${word}: not a target. Name ${TARGETS.join(', ')} (emulator and device stand for simulator), comma-separated, or all`;
  }
  if (picked.size === 0) return `--on: name ${TARGETS.join(', ')}, comma-separated, or all`;
  return TARGETS.filter((t) => picked.has(t));
};

export type SuiteReport = CaseReport & { retried?: boolean };
/** What one target's run answers: `reports` is missing when it could not start (its `text` says why). */
export type SuiteResult = Result & { reports?: SuiteReport[]; notes?: string[] };

/** How a target runs here: the flags its run takes over the caller's, or why it cannot. `label` is how the answer names it. */
export type TargetPlan = { flags: FlagValues; jobs: number; label?: string } | { unavailable: string };

export type OnTargetsOptions = {
  targets: TargetName[];
  /** The cases the runs take, in the order the answer lists them. */
  cases: { id: string; title?: string }[];
  plan: (target: TargetName) => Promise<TargetPlan>;
  run: (ctx: Ctx, target: TargetName) => Promise<SuiteResult>;
  /** A failed case in full, for verbose. */
  detail: (report: SuiteReport) => string;
  verbose: boolean;
  /** Where the events of every target go, for case status; none when left out. */
  progressFile?: string;
  /** The events on stdout too (--progress json), the summary then on stderr. */
  jsonProgress?: boolean;
};

const MARK = { passed: '✅', failed: '❌', unsupported: '🚫' } as const;
const STEP_CHARS = 100;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** One case on one target, on one line: the result, and for a case that did not pass the step and the first line of its error. */
export const caseLine = (report: SuiteReport, label: string): string => {
  const head = `${MARK[report.result]} ${label}  ${report.id}`;
  if (report.result === 'passed') return `${head}${report.retried ? '  ⚠ passed on retry' : ''}`;
  const at = report.steps.findIndex((s) => s.status === report.result);
  const step = report.steps[at];
  // The host dying explains the step's error better than the error does.
  const lost = report.diagnosis?.find((d) => d.startsWith('during this case the host'));
  const why = report.result === 'unsupported' ? 'not on this host' : (step?.error?.split('\n')[0] ?? report.diagnosis?.[0] ?? 'failed, with no error given');
  const where = step ? `step ${at + 1}/${report.steps.length} ${clip(step.step, STEP_CHARS)}: ` : '';
  return `${head} — ${where}${why}${lost ? ` (${lost})` : ''}`;
};

const indent = (text: string, by: string) =>
  text
    .split('\n')
    .map((l) => `${by}${l}`)
    .join('\n');

export const runOnTargets = async (ctx: Ctx, o: OnTargetsOptions): Promise<Result> => {
  const startedAt = Date.now();
  const planned = await Promise.all(
    o.targets.map(async (target) => ({
      target,
      plan: await o.plan(target).catch((error: unknown): TargetPlan => ({ unavailable: (error as Error).message.split('\n')[0] ?? 'unknown' })),
    })),
  );
  const missing = planned.flatMap(({ target, plan }) => ('unavailable' in plan ? [`○ ${target} not available: ${plan.unavailable}`] : []));
  let offset = 0;
  // Each target's jobs get their own numbers in the events, after the targets before it.
  const lanes = planned.flatMap(({ target, plan }) => {
    if ('unavailable' in plan) return [];
    const lane = { target, label: plan.label ?? target, flags: plan.flags, jobs: plan.jobs, offset };
    offset += plan.jobs;
    return [lane];
  });
  if (lanes.length === 0) return { text: [...missing, 'no target could run the cases'].join('\n'), code: 1 };

  const halt = new AbortController();
  const stopAll = (why: string) => {
    if (!halt.signal.aborted) halt.abort(why);
  };
  const cancelled = () => stopAll('the caller cancelled case run');
  if (ctx.signal?.aborted) cancelled();
  ctx.signal?.addEventListener('abort', cancelled, { once: true });
  const stopFile = o.progressFile ? `${o.progressFile}.stop` : undefined;
  if (o.progressFile) {
    fs.mkdirSync(path.dirname(o.progressFile), { recursive: true });
    fs.writeFileSync(o.progressFile, '');
    if (stopFile) fs.rmSync(stopFile, { force: true });
    writeLastRun(ctx.root, o.progressFile, stopFile);
  }
  const watching = stopFile
    ? setInterval(() => {
        if (!fs.existsSync(stopFile)) return;
        fs.rmSync(stopFile, { force: true });
        stopAll('stopped with case stop');
      }, 500)
    : undefined;
  watching?.unref();
  const emit = (e: ProgressEvent) => {
    if (o.progressFile) fs.appendFileSync(o.progressFile, `${JSON.stringify(e)}\n`);
    if (o.jsonProgress) process.stdout.write(`${JSON.stringify(e)}\n`);
    ctx.progress?.(e);
  };
  const named = (id: string, target: string) => `${id} (${target})`;
  emit({
    type: 'run-start',
    at: new Date().toISOString(),
    pid: process.pid,
    total: o.cases.length * lanes.length,
    jobs: offset,
    cases: lanes.flatMap((lane) => o.cases.map((c) => ({ id: named(c.id, lane.label), ...(c.title ? { title: c.title } : {}) }))),
  });

  let results: { lane: (typeof lanes)[number]; result: SuiteResult }[];
  try {
    results = await Promise.all(
      lanes.map(async (lane) => {
        const sub: Ctx = {
          ...ctx,
          flags: { ...ctx.flags, on: undefined, bundle: undefined, progress: 'none', ...lane.flags },
          err: (line) => ctx.err(indent(line, `${lane.label}: `)),
          // A target's own start and end are not the run's: the run starts and ends once, for all of them.
          progress: (e) => {
            if (e.type === 'run-start' || e.type === 'run-end') return;
            if (e.type === 'report') return emit(e);
            emit({ ...e, id: named(e.id, lane.label), job: lane.offset + e.job });
          },
          signal: halt.signal,
        };
        const result = await o.run(sub, lane.target).catch((error: unknown): SuiteResult => ({ text: (error as Error).message, code: 1 }));
        return { lane, result };
      }),
    );
  } finally {
    if (watching) clearInterval(watching);
    ctx.signal?.removeEventListener('abort', cancelled);
  }

  const width = Math.max(...lanes.map((l) => l.label.length));
  const lines: string[] = [];
  for (const c of o.cases)
    for (const { lane, result } of results) {
      const report = result.reports?.find((r) => r.id === c.id);
      if (!report) continue;
      lines.push(caseLine(report, lane.label.padEnd(width)));
      if (o.verbose && report.result !== 'passed') lines.push(indent(o.detail(report), '    '));
    }
  for (const { lane, result } of results)
    if (!result.reports) {
      const said = (result.text ?? `exit ${result.code}`).split('\n');
      const shown = o.verbose ? said : said.slice(0, 4);
      lines.push(
        `✖ ${lane.label} could not run: ${shown.join('\n    ')}${shown.length < said.length ? `\n    … ${said.length - shown.length} more lines (verbose)` : ''}`,
      );
    }
  lines.push(...missing);
  for (const { lane, result } of results) {
    const notes = (result.notes ?? []).flatMap((n) => n.split('\n'));
    if (notes.length === 1) lines.push(`${lane.label}: ${notes[0]}`);
    else if (notes.length > 1) lines.push(`${lane.label}:`, ...notes.map((n) => `  ${n}`));
  }
  const count = (reports: SuiteReport[] | undefined, result: CaseReport['result']) => (reports ?? []).filter((r) => r.result === result).length;
  lines.push(
    [
      ...results.map(({ lane, result }) =>
        result.reports ? `${lane.label} ${count(result.reports, 'passed')}/${result.reports.length} passed` : `${lane.label} could not run`,
      ),
      ...planned.flatMap(({ target, plan }) => ('unavailable' in plan ? [`${target} not available`] : [])),
    ].join(' · '),
  );
  const failed = results.some(({ result }) => (result.code ?? 0) !== 0 || !result.reports);
  if (failed && !o.verbose && results.some(({ result }) => count(result.reports, 'failed') > 0))
    lines.push("a failure's screen and requests: run that target again alone, or with verbose");

  // `case stop` in this process stops each target's run itself, not this one.
  const stoppedBy = halt.signal.aborted ? String(halt.signal.reason) : results.some(({ result }) => result.code === 130) ? 'stopped with case stop' : undefined;
  emit({
    type: 'run-end',
    at: new Date().toISOString(),
    passed: results.reduce((n, { result }) => n + count(result.reports, 'passed'), 0),
    failed: results.reduce((n, { result }) => n + count(result.reports, 'failed'), 0),
    unsupported: results.reduce((n, { result }) => n + count(result.reports, 'unsupported'), 0),
    ms: Date.now() - startedAt,
    ...(stoppedBy ? { stopped: stoppedBy } : {}),
  });
  if (stoppedBy) lines.push(`⏹ stopped (${stoppedBy}): no step starts after it, and every host a target started is stopped`);
  const code = stoppedBy ? 130 : failed ? 1 : 0;
  const text = lines.join('\n');
  const json = [
    ...results.map(({ lane, result }) => ({ target: lane.target, label: lane.label, code: result.code ?? 0, reports: result.reports ?? [] })),
    ...planned.flatMap(({ target, plan }) => ('unavailable' in plan ? [{ target, unavailable: plan.unavailable }] : [])),
  ];
  if (o.jsonProgress) {
    ctx.err(text);
    return { code, json };
  }
  return { text, json, code };
};

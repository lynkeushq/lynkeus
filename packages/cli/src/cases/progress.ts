/**
 * Where a run of cases stands, as events: `case run` writes one JSON object per line to `<out>/progress.ndjson`
 * (with `--progress json`, to stdout too), and everything that tells a person or a program how far a run has got
 * reads them back: the live line in a terminal, `case status`, the MCP server's progress notifications. A reader
 * of the file needs nothing else: the first event names every case, with how long each took before when that is
 * known, so the time left can be worked out from the file alone.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { CaseReport, StepProgress } from './runner.js';

type At = { at: string };

export type ProgressEvent =
  | (At & {
      type: 'run-start';
      pid: number;
      total: number;
      jobs: number;
      /** In the order the jobs take them; `expectedMs` is how long the case took when it last passed, where known. */
      cases: { id: string; title?: string; expectedMs?: number }[];
      out?: string;
    })
  /** The report the run fills as it goes, where it is pushed. */
  | (At & { type: 'report'; url: string })
  | (At & { type: 'case-start'; id: string; job: number; attempt: number; steps: number; host?: string })
  | (At & { type: 'step'; id: string; job: number } & StepProgress)
  | (At & { type: 'case-end'; id: string; job: number; attempt: number; result: CaseReport['result']; ms: number; retrying?: boolean })
  | (At & { type: 'run-end'; passed: number; failed: number; unsupported: number; ms: number; report?: string });

export type Running = {
  job: number;
  id: string;
  attempt: number;
  host?: string;
  startedAt: number;
  steps: number;
  step?: { index: number; section: 'setup' | 'steps'; heading?: string; text: string; startedAt: number };
  failedSteps: number;
};

/** A run as its events leave it: `stopped` is a run whose process is gone without saying it ended. */
export type RunStatus = {
  state: 'running' | 'finished' | 'stopped';
  pid?: number;
  startedAt?: string;
  elapsedMs: number;
  total: number;
  jobs: number;
  done: number;
  passed: number;
  failed: number;
  unsupported: number;
  retried: number;
  failures: string[];
  running: (Omit<Running, 'startedAt' | 'step'> & {
    elapsedMs: number;
    step?: { index: number; section: 'setup' | 'steps'; heading?: string; text: string; elapsedMs: number };
  })[];
  /** Time left, from how long each case took before (`history`) or from this run's own cases (`average`). */
  etaMs?: number;
  etaFrom?: 'history' | 'average';
  report?: string;
  out?: string;
};

const ms = (at: string) => Date.parse(at);

export class RunState {
  private startedAt?: number;
  private pid?: number;
  private total = 0;
  private jobs = 1;
  private order: string[] = [];
  private readonly expected = new Map<string, number>();
  private readonly results = new Map<string, CaseReport['result']>();
  private readonly took: number[] = [];
  private readonly retriedIds = new Set<string>();
  private readonly running = new Map<number, Running>();
  private ended?: { at: number };
  private last = 0;
  private report?: string;
  private out?: string;

  apply(e: ProgressEvent): void {
    this.last = Math.max(this.last, ms(e.at) || 0);
    switch (e.type) {
      case 'run-start':
        this.startedAt = ms(e.at);
        this.pid = e.pid;
        this.total = e.total;
        this.jobs = Math.max(1, e.jobs);
        this.order = e.cases.map((c) => c.id);
        for (const c of e.cases) if (c.expectedMs !== undefined) this.expected.set(c.id, c.expectedMs);
        this.out = e.out;
        break;
      case 'report':
        this.report = e.url;
        break;
      case 'case-start':
        if (e.attempt > 1) this.retriedIds.add(e.id);
        this.running.set(e.job, { job: e.job, id: e.id, attempt: e.attempt, host: e.host, startedAt: ms(e.at), steps: e.steps, failedSteps: 0 });
        break;
      case 'step': {
        const r = this.running.get(e.job);
        if (!r || r.id !== e.id) break;
        if (e.status === undefined) r.step = { index: e.index, section: e.section, heading: e.heading, text: e.step, startedAt: ms(e.at) };
        else if (e.status === 'failed') r.failedSteps += 1;
        break;
      }
      case 'case-end':
        if (this.running.get(e.job)?.id === e.id) this.running.delete(e.job);
        if (e.retrying) break;
        this.results.set(e.id, e.result);
        this.took.push(e.ms);
        break;
      case 'run-end':
        this.ended = { at: ms(e.at) };
        if (e.report) this.report = e.report;
        this.running.clear();
        break;
    }
  }

  /** Where the run stands at `now`; `alive` says whether its process is still there (unknown: assumed running). */
  status(now = Date.now(), alive?: boolean): RunStatus {
    const results = [...this.results.values()];
    const count = (r: CaseReport['result']) => results.filter((x) => x === r).length;
    const state = this.ended ? 'finished' : alive === false ? 'stopped' : 'running';
    const running = state === 'running' ? [...this.running.values()].sort((a, b) => a.job - b.job) : [];
    const eta = state === 'running' ? this.eta(now, running) : undefined;
    return {
      state,
      ...(this.pid !== undefined ? { pid: this.pid } : {}),
      ...(this.startedAt !== undefined ? { startedAt: new Date(this.startedAt).toISOString() } : {}),
      // A stopped run went on until the last thing it said.
      elapsedMs: this.startedAt === undefined ? 0 : (this.ended?.at ?? (state === 'stopped' ? this.last : now)) - this.startedAt,
      total: this.total,
      jobs: this.jobs,
      done: results.length,
      passed: count('passed'),
      failed: count('failed'),
      unsupported: count('unsupported'),
      retried: this.retriedIds.size,
      failures: [...this.results.entries()].filter(([, r]) => r === 'failed').map(([id]) => id),
      running: running.map(({ startedAt, step, ...r }) => ({
        ...r,
        elapsedMs: now - startedAt,
        ...(step
          ? {
              step: {
                index: step.index,
                section: step.section,
                ...(step.heading ? { heading: step.heading } : {}),
                text: step.text,
                elapsedMs: now - step.startedAt,
              },
            }
          : {}),
      })),
      ...(eta ? { etaMs: eta.ms, etaFrom: eta.from } : {}),
      ...(this.report ? { report: this.report } : {}),
      ...(this.out ? { out: this.out } : {}),
    };
  }

  /**
   * The work left, spread over the jobs: each case not yet done takes what it took when it last passed, or else
   * what this run's finished cases took on average; a running case has already spent part of it. Nothing to go
   * on (no history, nothing finished): no estimate.
   */
  private eta(now: number, running: Running[]): { ms: number; from: 'history' | 'average' } | undefined {
    const average = this.took.length ? this.took.reduce((a, b) => a + b, 0) / this.took.length : undefined;
    const busy = new Set(running.map((r) => r.id));
    const left = this.order.filter((id) => !this.results.has(id) && !busy.has(id));
    let fromHistory = false;
    const guess = (id: string): number | undefined => {
      const known = this.expected.get(id);
      if (known !== undefined) {
        fromHistory = true;
        return known;
      }
      return average;
    };
    let work = 0;
    let longest = 0;
    for (const id of left) {
      const g = guess(id);
      if (g === undefined) return undefined;
      work += g;
    }
    for (const r of running) {
      const g = guess(r.id);
      if (g === undefined) return undefined;
      const rest = Math.max(g - (now - r.startedAt), 0);
      work += rest;
      longest = Math.max(longest, rest);
    }
    return { ms: Math.max(work / this.jobs, longest), from: fromHistory ? 'history' : 'average' };
  }
}

/** The events of a progress file, in order; a line cut short by a run still writing it is left out. */
export const readEvents = (file: string): ProgressEvent[] =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .flatMap((line) => {
      if (!line.trim()) return [];
      try {
        return [JSON.parse(line) as ProgressEvent];
      } catch {
        return [];
      }
    });

/** Whether a process is still there. */
export const alive = (pid: number | undefined): boolean | undefined => {
  if (pid === undefined) return undefined;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Another user's process answers EPERM: it is there.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

export const statusOf = (file: string, now = Date.now()): RunStatus => {
  const state = new RunState();
  const events = readEvents(file);
  for (const e of events) state.apply(e);
  const start = events.find((e) => e.type === 'run-start');
  return state.status(now, start?.type === 'run-start' ? alive(start.pid) : undefined);
};

export const PROGRESS_FILE = 'progress.ndjson';

/** Where `case status` looks when it is given no run: what the last run of this project wrote. */
export const lastRunFile = (root: string) => path.join(root, '.lynkeus', 'last-run.json');

const clock = (msLeft: number): string => {
  const s = Math.round(msLeft / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
};

const where = (r: RunStatus['running'][number]) => {
  if (!r.step) return 'starting';
  const part = r.step.section === 'setup' ? 'setup' : r.step.heading ? `§${r.step.heading}` : 'steps';
  return `${part} · step ${r.step.index + 1}/${r.steps}`;
};

/** One line, for a terminal's live status: counts, time left, and what each job is on. */
export const statusLine = (s: RunStatus): string => {
  const counts = `${s.done}/${s.total}${s.passed ? ` ✅${s.passed}` : ''}${s.failed ? ` ❌${s.failed}` : ''}${s.unsupported ? ` 🚫${s.unsupported}` : ''}`;
  const time = `${clock(s.elapsedMs)}${s.etaMs !== undefined ? ` · ~${clock(s.etaMs)} left` : ''}`;
  const jobs = s.running.map((r) => `${s.jobs > 1 ? `${r.job + 1}: ` : ''}${r.id}${r.attempt > 1 ? ' (retry)' : ''} ${where(r)}`);
  return [counts, time, ...jobs].join(' │ ');
};

/** Where a run stands, in a few lines a person reads. */
export const describeStatus = (s: RunStatus, file?: string): string => {
  const counts = `${s.done} of ${s.total} cases done (✅ ${s.passed}${s.failed ? `, ❌ ${s.failed}` : ''}${s.unsupported ? `, 🚫 ${s.unsupported}` : ''}${s.retried ? `, ${s.retried} retried` : ''})`;
  const started = s.startedAt ? `, started ${clock(s.elapsedMs)} ago` : '';
  const head = {
    running: `running: ${counts}${started}${s.etaMs !== undefined ? `; about ${clock(s.etaMs)} left (${s.etaFrom === 'history' ? 'from past runs' : 'from this run’s cases'})` : ''}`,
    finished: `finished: ${counts} in ${clock(s.elapsedMs)}`,
    stopped: `stopped: its process (${s.pid}) is gone without finishing; ${counts}`,
  }[s.state];
  return [
    head,
    ...s.running.map(
      (r) =>
        `  ${s.jobs > 1 ? `job ${r.job + 1}: ` : ''}${r.id}${r.attempt > 1 ? ` (attempt ${r.attempt})` : ''}${r.host ? ` on ${r.host}` : ''}, ${clock(r.elapsedMs)} in — ${where(r)}${r.step ? `: ${r.step.text}` : ''}`,
    ),
    ...(s.failures.length ? [`failed: ${s.failures.join(', ')}`] : []),
    ...(s.report ? [`report: ${s.report}`] : []),
    ...(file ? [`progress: ${file}`] : []),
  ].join('\n');
};

/**
 * `case run --on`: the same cases on several targets at once (the app on the iOS Simulator, the app on the Android
 * emulator, Lynkeus FastSim, the headless host), each run as `case run` runs on it alone, and answered with one line
 * per case per target. A target this machine cannot run on is said once, with why, and fails nothing, unless the project
 * declared it (`--on targets`): then the check is incomplete and says so. `simulator` is whichever device's app is
 * attached, as before there were two.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { FlagValues } from '../args.js';
import type { Base, Ctx, Result } from '../registry.js';
import type { ProgressEvent } from './progress.js';
import { writeLastRun } from './progress.js';
import type { CaseReport } from './runner.js';

export const TARGETS = ['simulator', 'ios', 'android', 'fastsim', 'fastsim:ios', 'fastsim:android', 'headless'] as const;
export type TargetName = (typeof TARGETS)[number];
/** The targets that drive an app on a Simulator, emulator or phone, which dials the driver's own port. */
export const DEVICE_TARGETS: readonly TargetName[] = ['simulator', 'ios', 'android'];
/** The targets a CI job can start on its own, with no device: hosts. */
export const CI_TARGETS: readonly TargetName[] = ['headless', 'fastsim', 'fastsim:ios', 'fastsim:android'];
// `all` names each platform's device and FastSim once: `simulator` and `fastsim` would be one of them again.
const ALL: readonly TargetName[] = ['ios', 'android', 'fastsim:ios', 'fastsim:android', 'headless'];

const NAMES: Record<string, TargetName> = {
  simulator: 'simulator',
  emulator: 'simulator',
  device: 'simulator',
  ios: 'ios',
  android: 'android',
  fastsim: 'fastsim',
  'fastsim:ios': 'fastsim:ios',
  'fastsim:android': 'fastsim:android',
  headless: 'headless',
};
const NAMED =
  'headless, fastsim:ios, fastsim:android, ios (the app on the iOS Simulator or an iPhone), android (the app on the Android emulator or a phone), fastsim (the last bundle, either platform), simulator (the attached app on either platform; emulator and device stand for it)';

/** A target as a file or folder name: `fastsim:ios` would not survive every file system. */
export const targetSlug = (t: TargetName): string => t.replace(':', '-');

const wordsOf = (value: string | readonly string[]): string[] =>
  (typeof value === 'string' ? value.split(',') : [...value]).map((w) => String(w).trim().toLowerCase()).filter(Boolean);

/** The targets a list names, in the order answers list them; a sentence starting with `where` when one is not a target. */
export const targetList = (value: string | readonly string[], where: string): TargetName[] | string => {
  const picked = new Set<TargetName>();
  for (const word of wordsOf(value)) {
    if (!NAMES[word]) return `${where}: ${word} is not a target. Name ${NAMED}`;
    picked.add(NAMES[word]);
  }
  if (picked.size === 0) return `${where} is empty: name one or more of ${NAMED}`;
  return TARGETS.filter((t) => picked.has(t));
};

/**
 * What `--on` names: targets, or `declared` for `targets`, each case on its own declared targets (the case's
 * `targets:`, else `cases.targets`). A sentence when it names something else.
 */
export const parseTargets = (value: string): TargetName[] | 'declared' | string => {
  const words = wordsOf(value);
  if (words.includes('targets')) return words.length === 1 ? 'declared' : '--on targets: alone, as each case declares its own (cases.targets)';
  if (words.length === 0) return `--on: name ${NAMED}, comma-separated, all, or targets`;
  const picked = new Set<TargetName>();
  for (const word of words) {
    if (word === 'all') for (const t of ALL) picked.add(t);
    else if (NAMES[word]) picked.add(NAMES[word]);
    else return `--on ${word}: not a target. Name ${NAMED}, comma-separated, all (every one this machine has), or targets (the project's, cases.targets)`;
  }
  return TARGETS.filter((t) => picked.has(t));
};

/**
 * The targets a case must pass on: its own `targets:` frontmatter, else the project's `cases.targets`. Undefined when
 * neither declares any; a sentence when one names something that is not a target.
 */
export const declaredTargets = (meta: Record<string, unknown>, project: readonly string[] | undefined, file?: string): TargetName[] | string | undefined => {
  const own = meta.targets;
  if (own !== undefined) {
    if (typeof own !== 'string' && !(Array.isArray(own) && own.every((t) => typeof t === 'string')))
      return `${file ?? 'a case'}: targets is a list of target names, as cases.targets`;
    return targetList(own as string | string[], `${file ?? 'a case'}: targets`);
  }
  if (project === undefined) return undefined;
  if (!Array.isArray(project)) return 'cases.targets in lynkeus.config.json is a list of target names';
  return targetList(project, 'cases.targets in lynkeus.config.json');
};

/** One line for a case its own `targets:` leave out of `target`, or undefined when it runs there. */
export const skippedOn = (meta: Record<string, unknown>, target: TargetName, label: string = target): string | undefined => {
  const own = declaredTargets(meta, undefined);
  if (!Array.isArray(own) || own.length === 0) return undefined;
  const hit = own.some(
    (t) => t === target || (target === 'simulator' && (t === 'ios' || t === 'android')) || (target === 'fastsim' && t.startsWith('fastsim')),
  );
  return hit ? undefined : `skipped on ${label}: its targets are ${own.join(', ')}`;
};

export type SuiteReport = CaseReport & { retried?: boolean };
/** What one target's run answers: `reports` is missing when it could not start (its `text` says why). */
export type SuiteResult = Result & { reports?: SuiteReport[]; notes?: string[] };

/**
 * How a target runs here: the flags its run takes over the caller's, or why it cannot. `label` is how the answer names
 * it; `base`, the connection its run drives instead of the caller's, stopped with `stop` when the run ends.
 */
export type TargetPlan = { flags: FlagValues; jobs: number; label?: string; base?: Base; stop?: () => Promise<void> } | { unavailable: string };

export type OnTargetsOptions = {
  targets: TargetName[];
  /**
   * The cases the runs take, in the order the answer lists them. A case with `targets` runs only on those (its file
   * is what that target's run is given); one without, on every target.
   */
  cases: { id: string; title?: string; file?: string; targets?: readonly TargetName[] }[];
  /**
   * The targets are the ones the project declared (`--on targets`): one this machine cannot run on leaves the check
   * incomplete, and the run fails, instead of being named and passed over.
   */
  declared?: boolean;
  plan: (target: TargetName) => Promise<TargetPlan>;
  run: (ctx: Ctx, target: TargetName) => Promise<SuiteResult>;
  /** A failed case in full, for verbose. */
  detail: (report: SuiteReport) => string;
  verbose: boolean;
  /**
   * Only what needs reading: the cases that did not pass (or passed on retry), each target's count, and each target's
   * notes cut to their first line. For a suite on several targets, where all-green is thirty lines that say nothing.
   */
  brief?: boolean;
  /** Where the events of every target go, for case status; none when left out. */
  progressFile?: string;
  /** The events on stdout too (--progress json), the summary then on stderr. */
  jsonProgress?: boolean;
  /** The whole run's time: past `ms` every target stops, with `stop` as the reason. */
  budget?: { ms: number; stop: string };
};

/** What to do about the cases a run held to a budget did not reach. */
export const budgetAdvice = (left: string[]): string =>
  left.length
    ? `not run: ${left.slice(0, 8).join(', ')}${left.length > 8 ? ` and ${left.length - 8} more` : ''}; run them in another call (name their files), or give budget more seconds`
    : 'every case ran; give budget more seconds if its last one was cut short';

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

const stopPlans = (planned: { plan: TargetPlan }[]) =>
  Promise.all(planned.map(({ plan }) => ('stop' in plan && plan.stop ? plan.stop().catch(() => undefined) : undefined)));

const wants = (c: OnTargetsOptions['cases'][number], t: TargetName) => !c.targets || c.targets.includes(t);

export const runOnTargets = async (ctx: Ctx, o: OnTargetsOptions): Promise<Result> => {
  const startedAt = Date.now();
  const casesOn = (t: TargetName) => o.cases.filter((c) => wants(c, t));
  const skipped = (o.declared ? [] : o.targets).flatMap((t) =>
    o.cases.filter((c) => !wants(c, t) && c.targets).map((c) => `skipped on ${t}: ${c.id}, its targets are ${c.targets!.join(', ')}`),
  );
  // A target no case asks for is not even planned: planning one can start a connection or ask for a grant.
  const asked = o.targets.filter((t) => casesOn(t).length > 0);
  const planned = await Promise.all(
    asked.map(async (target) => ({
      target,
      plan: await o.plan(target).catch((error: unknown): TargetPlan => ({ unavailable: (error as Error).message.split('\n')[0] ?? 'unknown' })),
    })),
  );
  const missing = planned.flatMap(({ target, plan }) =>
    'unavailable' in plan ? [`${o.declared ? '✖' : '○'} ${target} not available: ${plan.unavailable}`] : [],
  );
  const unchecked = planned.flatMap(({ target, plan }) => ('unavailable' in plan ? [`${target} (${casesOn(target).length} case(s))`] : []));
  const incomplete =
    o.declared && unchecked.length > 0
      ? `⚠ check incomplete: ${unchecked.join(', ')} declared but not available here, so not checked there; run on a machine that has ${unchecked.length === 1 ? 'it' : 'them'}, or change the declared targets`
      : undefined;
  let offset = 0;
  // Each target's jobs get their own numbers in the events, after the targets before it.
  const lanes = planned.flatMap(({ target, plan }) => {
    if ('unavailable' in plan) return [];
    const own = casesOn(target);
    // Only the files of the cases this target takes; every case wanting it leaves the caller's arguments alone.
    const files = own.length < o.cases.length && own.every((c) => c.file) ? [...new Set(own.map((c) => c.file as string))] : undefined;
    const lane = { target, label: plan.label ?? target, flags: plan.flags, jobs: plan.jobs, offset, base: plan.base, cases: own, files };
    offset += plan.jobs;
    return [lane];
  });
  if (lanes.length === 0) {
    await stopPlans(planned);
    return { text: [...skipped, ...missing, incomplete ?? 'no target could run the cases'].join('\n'), code: 1 };
  }

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
  const budget = o.budget ? setTimeout(() => stopAll(o.budget!.stop), o.budget.ms) : undefined;
  budget?.unref();
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
    total: lanes.reduce((n, lane) => n + lane.cases.length, 0),
    jobs: offset,
    cases: lanes.flatMap((lane) => lane.cases.map((c) => ({ id: named(c.id, lane.label), ...(c.title ? { title: c.title } : {}) }))),
  });

  let results: { lane: (typeof lanes)[number]; result: SuiteResult }[];
  try {
    results = await Promise.all(
      lanes.map(async (lane) => {
        const sub: Ctx = {
          ...ctx,
          ...(lane.base ? { device: lane.base.device, forPort: lane.base.forPort, forApp: lane.base.forApp, shares: lane.base.shares } : {}),
          ...(lane.files ? { args: lane.files } : {}),
          // The run's budget is kept here, for every target at once.
          flags: { ...ctx.flags, on: undefined, bundle: undefined, budget: undefined, progress: 'none', ...lane.flags },
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
    clearTimeout(budget);
    ctx.signal?.removeEventListener('abort', cancelled);
    await stopPlans(planned);
  }

  const width = Math.max(...lanes.map((l) => l.label.length));
  const lines: string[] = [];
  for (const c of o.cases)
    for (const { lane, result } of results) {
      const report = result.reports?.find((r) => r.id === c.id);
      if (!report) continue;
      if (o.brief && report.result === 'passed' && !report.retried) continue;
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
  lines.push(...skipped, ...missing);
  for (const { lane, result } of results) {
    const all = (result.notes ?? []).flatMap((n) => n.split('\n'));
    const notes = o.brief ? (result.notes ?? []).flatMap((n) => n.split('\n').slice(0, 1)) : all;
    if (notes.length === 1) lines.push(`${lane.label}: ${notes[0]}`);
    else if (notes.length > 1) lines.push(`${lane.label}:`, ...notes.map((n) => `  ${n}`));
  }
  const count = (reports: SuiteReport[] | undefined, result: CaseReport['result']) => (reports ?? []).filter((r) => r.result === result).length;
  lines.push(
    [
      ...results.map(({ lane, result }) =>
        result.reports
          ? `${lane.label} ${count(result.reports, 'passed')}/${result.reports.length} passed${result.reports.length < lane.cases.length ? `, ${lane.cases.length - result.reports.length} not run` : ''}`
          : `${lane.label} could not run`,
      ),
      ...planned.flatMap(({ target, plan }) => ('unavailable' in plan ? [`${target} not available`] : [])),
    ].join(' · '),
  );
  if (incomplete) lines.push(incomplete);
  const failed = results.some(({ result }) => (result.code ?? 0) !== 0 || !result.reports) || incomplete !== undefined;
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
  if (stoppedBy && stoppedBy === o.budget?.stop) {
    const left = results.flatMap(({ lane, result }) =>
      lane.cases.filter((c) => !result.reports?.some((r) => r.id === c.id)).map((c) => `${c.id} (${lane.label})`),
    );
    lines.push(budgetAdvice(left));
  }
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

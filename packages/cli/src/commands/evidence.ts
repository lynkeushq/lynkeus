/**
 * `evidence`: a suite run with everything a person reviews (a frame per step, a film per case, report.html), answered
 * with only what the caller needs to point at: where the report is, how each case did on each target, and the frames
 * that look wrong. The run's own answer, with its notes and failures in full, stays in a file beside it.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { REPORT_FILE } from './localReport.js';
import { runsDir } from '../config.js';
import { type CaseReport, FRAME_MOVING, FRAME_NOT_APP, NO_FILM } from '../cases/runner.js';
import { targetSlug, type TargetName } from '../cases/onTargets.js';
import { define } from '../registry.js';
import { execute } from '../runtime.js';

const MARK = { passed: '✅', failed: '❌', unsupported: '🚫' } as const;
// A step that should change what is on screen; one whose frame is the same as the step before's did nothing visible.
const ACTS = /^app\.(press|type|swipe|back|nav|deeplink)\b/;
const MAX_SUSPECTS = 8;

export type TargetRun = { label: string; reports: CaseReport[]; unavailable?: string; dir: string };

const digest = (file: string): string | undefined => {
  try {
    return createHash('sha1').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return undefined;
  }
};

/**
 * The frames that look wrong: an action's frame identical to the step before's (the press landed nowhere, or the
 * frame was taken before the screen changed), frames the run said are not of the app (a system view in front), and
 * frames a host took while its screen still moved.
 */
export const suspectFrames = (runs: TargetRun[], hash: (file: string) => string | undefined = digest): string[] => {
  const out: string[] = [];
  for (const run of runs)
    for (const report of run.reports) {
      let before: string | undefined;
      report.steps.forEach((step, i) => {
        const now = step.screenshot ? hash(step.screenshot) : undefined;
        if (now && before && now === before && ACTS.test(step.step))
          out.push(
            `${run.label} ${report.id} step ${i + 1} (${step.step.slice(0, 60)}): same frame as the step before, the action changed nothing on screen (${step.screenshot})`,
          );
        if (now) before = now;
      });
      for (const w of report.warnings ?? []) if (w.startsWith(FRAME_NOT_APP) || w.startsWith(FRAME_MOVING)) out.push(`${run.label} ${report.id}: ${w}`);
    }
  return out;
};

/**
 * Whether each case kept a film that plays: one line, naming the cases without one and why the first has none. A film
 * the recorder never finished (0 bytes, no index) is not a film.
 */
export const filmLine = (runs: TargetRun[]): string | undefined => {
  const all = runs.flatMap((run) => run.reports.map((c) => ({ label: run.label, c })));
  if (all.length === 0) return undefined;
  const without = all.filter(({ c }) => !c.video);
  if (without.length === 0) return `film: every case has one (${all.length})`;
  const why = without.flatMap(({ c }) => c.warnings ?? []).find((w) => w.startsWith(NO_FILM));
  const names = without.slice(0, 5).map(({ label, c }) => (runs.length > 1 ? `${c.id} (${label})` : c.id));
  return `⚠ film missing for ${without.length} of ${all.length} case(s): ${names.join(', ')}${without.length > 5 ? ', …' : ''}${why ? ` — ${why.slice(NO_FILM.length + 2)}` : ' — the host or device does not film'}`;
};

/** A line per case: its result on each target, and for one that failed, where. */
export const caseResults = (runs: TargetRun[]): string[] => {
  const ids = [...new Set(runs.flatMap((r) => r.reports.map((c) => c.id)))];
  return ids.map((id) => {
    const on = runs.flatMap((r) => {
      const c = r.reports.find((x) => x.id === id);
      return c ? [{ label: r.label, c }] : [];
    });
    const marks = on.map(({ label, c }) => `${label} ${MARK[c.result]}`).join(' · ');
    const failed = on.find(({ c }) => c.result === 'failed');
    const at = failed ? failed.c.steps.findIndex((s) => s.status === 'failed') : -1;
    const where = failed && at >= 0 ? ` — ${failed.label} step ${at + 1}: ${(failed.c.steps[at]!.error ?? '').split('\n')[0]!.slice(0, 120)}` : '';
    return `${id}: ${marks}${where}`;
  });
};

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');

export const evidenceCommands = [
  define({
    name: 'evidence',
    group: 'runs',
    summary: 'Run cases with a frame per step, a film per case and report.html; answer with the report, each case per target and the frames that look wrong',
    details:
      "The evidence a person reviews, in one call: `case run` with `--out`, `--screenshots` and `--video` (unless `--no-video`), on the targets `--on` names (as `case run --on`), the attached app, or headless with `--host`. The answer is short: the report's path per target, a line per case with its result on each target, and the frames that look wrong: an action whose frame is identical to the step before's (it changed nothing on screen), a frame taken while a system view or another app was in front, and one a host took while its screen still moved. The run's whole answer is in answer.txt beside the report.",
    positionals: [{ name: 'files', help: 'case files (default: every case in cases.dir)', rest: true }],
    flags: {
      on: { type: 'string', help: 'as case run --on (default: the attached app)', value: 'targets' },
      host: { type: 'boolean', help: 'headless, in Node' },
      out: { type: 'string', help: 'the run folder (default .lynkeus/runs/evidence/<time>)', value: 'dir' },
      'no-video': { type: 'boolean', help: 'no film' },
      push: { type: 'boolean', help: 'upload to the reports service' },
      budget: { type: 'number', help: 'as case run --budget: stop the run after this many seconds (over MCP 1500 unless given; 0: none)', value: 's' },
    },
    needs: 'nothing',
    session: false,
    mcp: 'core',
    mcpDefaults: { budget: 1500 },
    mcpDetails:
      'case_run with frames, film and report.html. Answers only the report path, a line per case with its result per target, and frames that look wrong (an action that changed nothing on screen, a system view in front).',
    run: async (ctx) => {
      const out = path.resolve(ctx.root, typeof ctx.flags.out === 'string' ? ctx.flags.out : path.join(runsDir(ctx.root), 'evidence', stamp()));
      const on = typeof ctx.flags.on === 'string' ? ctx.flags.on : undefined;
      if (on && ctx.flags.host) return { text: 'evidence: on starts each target itself; leave out host', code: 2 };
      const argv = [
        'case',
        'run',
        ...ctx.args,
        '--out',
        out,
        '--screenshots',
        ...(ctx.flags['no-video'] ? [] : ['--video']),
        ...(on ? ['--on', on] : []),
        ...(ctx.flags.host ? ['--host'] : []),
        ...(ctx.flags.push ? ['--push'] : []),
        ...(ctx.flags.budget !== undefined ? ['--budget', String(ctx.flags.budget)] : []),
      ];
      const r = await execute(argv, ctx);
      fs.mkdirSync(out, { recursive: true });
      const answer = path.join(out, 'answer.txt');
      fs.writeFileSync(answer, r.error ? `${r.error}\n${r.why ?? ''}` : (r.text ?? ''));
      if (r.error) return { text: `✗ evidence: ${r.error.split('\n')[0]} (whole answer: ${answer})`, code: 1 };
      const runs: TargetRun[] = on
        ? ((r.json ?? []) as { target: TargetName; label?: string; reports?: CaseReport[]; unavailable?: string }[]).map((t) => ({
            label: t.label ?? t.target,
            reports: t.reports ?? [],
            ...(t.unavailable ? { unavailable: t.unavailable } : {}),
            dir: path.join(out, targetSlug(t.target)),
          }))
        : [{ label: 'run', reports: (r.json ?? []) as CaseReport[], dir: out }];
      const reports = runs
        .map((run) => ({ run, file: path.join(run.dir, REPORT_FILE) }))
        .filter(({ file }) => fs.existsSync(file))
        .map(({ run, file }) => `report${on ? ` ${run.label}` : ''}: ${file}`);
      const suspects = suspectFrames(runs);
      const pushed = (r.text ?? '')
        .split('\n')
        .filter((l) => /https?:\/\/\S+/.test(l) && /report/i.test(l))
        .slice(0, 2);
      const lines = [
        ...(reports.length ? reports : [`no report.html was written (whole answer: ${answer})`]),
        ...pushed,
        ...caseResults(runs.filter((run) => !run.unavailable)),
        ...runs.filter((run) => run.unavailable).map((run) => `○ ${run.label} not available: ${run.unavailable}`),
        ...(ctx.flags['no-video'] ? [] : [filmLine(runs.filter((run) => !run.unavailable))].filter((line): line is string => !!line)),
        ...(suspects.length
          ? [
              `frames that look wrong (${suspects.length}):`,
              ...suspects.slice(0, MAX_SUSPECTS).map((s) => `  ${s}`),
              ...(suspects.length > MAX_SUSPECTS ? [`  … ${suspects.length - MAX_SUSPECTS} more`] : []),
            ]
          : ['frames: none looks wrong (no action left the screen unchanged, none shows a system view, none was taken while the screen moved)']),
        `whole answer: ${answer}`,
      ];
      // A recorder that ran and left nothing that plays makes the evidence incomplete, however the cases did.
      const filmFailed = runs.some((run) => run.reports.some((c) => !c.video && c.warnings?.some((w) => w.startsWith(NO_FILM))));
      return { text: lines.join('\n'), json: { out, reports, suspects }, code: r.code || (filmFailed ? 1 : 0) };
    },
  }),
];

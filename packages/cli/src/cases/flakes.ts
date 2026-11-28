/**
 * How each case has done across runs, kept in one JSON file: the last results,
 * how often it needed its second chance, the step it last died on. A case that
 * passes and fails without anything changing is the one to look at first.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { Case } from './format.js';
import type { CaseReport } from './runner.js';

const KEPT = 20;

/**
 * `where`: what ran the app (`ios`, `android`, `fastsim:ios`, `host:android`…), and `app`: the app's source when it ran
 * (`appStamp`). Runs are only compared with runs of the same both: a case may pass on one target and fail on another,
 * and fail for good after an app change, without being flaky.
 */
export type Outcome = {
  at: string;
  result: CaseReport['result'];
  retried: boolean;
  ms?: number;
  step?: string;
  error?: string;
  where?: string;
  app?: string;
};

/** What ran the app, from what it said when it attached: a phone's platform, FastSim's or a host's. */
export const whereOf = (hello: { platform?: string; native?: boolean; commands?: string[] } | undefined): string | undefined => {
  if (!hello?.platform) return undefined;
  if (!hello.native) return `host:${hello.platform}`;
  return hello.commands?.includes('clock') ? `fastsim:${hello.platform}` : hello.platform;
};

/**
 * The app's source as a short hash: the commit and what the working tree changed on top of it, leaving out `excluded`
 * (the cases and Lynkeus's own files, which `caseVersion` already follows). Undefined outside git.
 */
export const appStamp = (root: string, excluded: string[] = []): string | undefined => {
  const git = (...args: string[]) => {
    try {
      return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
    } catch {
      return undefined;
    }
  };
  const head = git('rev-parse', 'HEAD')?.trim();
  if (!head) return undefined;
  const diff = git('diff', 'HEAD', '--no-ext-diff', '--', '.', ...excluded.map((p) => `:(exclude)${p}`)) ?? '';
  return createHash('sha1').update(head).update(diff).digest('hex').slice(0, 12);
};
/** `version`: what the case ran when these runs were kept (`caseVersion`); another version starts the history again. */
export type Ledger = Record<string, { runs: number; failed: number; retried: number; last: Outcome[]; version?: string }>;

/**
 * What a case runs, as a hash: its steps and the macros they call (from the project's config, which changes without the
 * case file changing), not its prose, so a reworded description keeps its history.
 */
export const caseVersion = (c: Pick<Case, 'setup' | 'steps' | 'teardown'>, macros: Record<string, unknown[]> = {}): string => {
  const used = new Map<string, unknown[]>();
  const visit = (verb: string) => {
    const body = macros[verb];
    if (!body || used.has(verb)) return;
    used.set(verb, body);
    // A macro's steps are `verb: value` objects, or `do` blocks of them; any key that names a macro is one it calls.
    JSON.stringify(body, (key, value) => {
      if (key in macros) visit(key);
      return value;
    });
  };
  for (const step of [...c.setup, ...c.steps, ...c.teardown]) visit(step.verb);
  return createHash('sha1')
    .update(JSON.stringify([c.setup, c.steps, c.teardown, [...used].sort(([a], [b]) => a.localeCompare(b))]))
    .digest('hex')
    .slice(0, 12);
};

// Failures that fail the same way every time until someone changes something: no app to drive, or a case or project
// that cannot run as written. They say nothing about whether the case passes and fails on its own.
const STEADY = [
  /^No app attached/,
  /^Port \d+ is already taken/,
  /is not a step/,
  /\bneeds an? /,
  /^no alias /,
  /declares no fixtures/,
  /declares none/,
  /^no command \S+ registered/,
];

export const countsForFlakiness = (o: Outcome): boolean => !(o.result === 'failed' && o.error && STEADY.some((p) => p.test(o.error!)));

export class Flakes {
  private readonly ledger: Ledger;

  constructor(private readonly file: string) {
    let read: Ledger = {};
    try {
      read = JSON.parse(fs.readFileSync(file, 'utf8')) as Ledger;
    } catch {
      // No ledger yet, or one this cannot read: start a new one.
    }
    this.ledger = read;
  }

  note(report: CaseReport & { retried?: boolean }, at = new Date(), version?: string, ran: { where?: string; app?: string } = {}): void {
    const kept = this.ledger[report.id];
    // Runs of another version of the case (or of a ledger that kept no version) are not this case's history.
    const entry = kept && (version === undefined || kept.version === version) ? kept : { runs: 0, failed: 0, retried: 0, last: [] };
    if (version !== undefined) entry.version = version;
    this.ledger[report.id] = entry;
    const broke = report.steps.find((s) => s.status === 'failed');
    entry.runs += 1;
    if (report.result === 'failed') entry.failed += 1;
    if (report.retried) entry.retried += 1;
    entry.last = [
      ...entry.last,
      {
        at: at.toISOString(),
        result: report.result,
        retried: !!report.retried,
        ms: report.ms,
        ...(broke ? { step: broke.step, error: broke.error?.split('\n')[0] } : {}),
        ...(ran.where ? { where: ran.where } : {}),
        ...(ran.app ? { app: ran.app } : {}),
      },
    ].slice(-KEPT);
  }

  /** How long a case took when it last passed, if the ledger has seen it pass. */
  lastMs(id: string): number | undefined {
    return [...(this.ledger[id]?.last ?? [])].reverse().find((o) => o.result === 'passed' && o.ms !== undefined)?.ms;
  }

  /**
   * The cases among `ids` whose recent runs disagree with each other, worded for a summary. Only runs on the same
   * target with the same app source are compared. A failure that reproduced (it failed again on its second chance, or
   * another kept run failed at the same step with the same error) is a break, not a flake: it counts on neither side.
   */
  flaky(ids: string[]): string[] {
    return ids.flatMap((id) => {
      const groups = new Map<string, Outcome[]>();
      for (const o of (this.ledger[id]?.last ?? []).filter(countsForFlakiness)) {
        const key = `${o.where ?? ''}|${o.app ?? ''}`;
        groups.set(key, [...(groups.get(key) ?? []), o]);
      }
      const verdicts = [...groups.values()].flatMap((kept) => {
        const same = (a: Outcome, b: Outcome) => a.step === b.step && a.error === b.error;
        const reproduced = (o: Outcome) =>
          o.result === 'failed' && (o.retried || kept.some((other) => other !== o && other.result === 'failed' && same(other, o)));
        const last = kept.filter((o) => !reproduced(o));
        const shaky = last.filter((o) => o.result === 'failed' || o.retried).length;
        return shaky === 0 || shaky === last.length ? [] : [{ shaky, of: last.length, where: kept[0]?.where }];
      });
      const worst = verdicts.sort((a, b) => b.shaky / b.of - a.shaky / a.of)[0];
      if (!worst) return [];
      return [`⚠ ${id} is flaky${worst.where ? ` on ${worst.where}` : ''}: ${worst.shaky} of its last ${worst.of} runs failed or needed a second chance`];
    });
  }

  save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, `${JSON.stringify(this.ledger, null, 2)}\n`);
  }
}

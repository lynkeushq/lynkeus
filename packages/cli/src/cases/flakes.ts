/**
 * How each case has done across runs, kept in one JSON file: the last results,
 * how often it needed its second chance, the step it last died on. A case that
 * passes and fails without anything changing is the one to look at first.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { Case } from './format.js';
import type { CaseReport } from './runner.js';

const KEPT = 20;

export type Outcome = { at: string; result: CaseReport['result']; retried: boolean; ms?: number; step?: string; error?: string };
/** `version`: what the case ran when these runs were kept (`caseVersion`); another version starts the history again. */
export type Ledger = Record<string, { runs: number; failed: number; retried: number; last: Outcome[]; version?: string }>;

/** What a case runs, as a hash: its steps, not its prose, so a reworded description keeps its history. */
export const caseVersion = (c: Pick<Case, 'setup' | 'steps' | 'teardown'>): string =>
  createHash('sha1')
    .update(JSON.stringify([c.setup, c.steps, c.teardown]))
    .digest('hex')
    .slice(0, 12);

// Failures that fail the same way every time until someone changes something: no app to drive, or a case or project
// that cannot run as written. They say nothing about whether the case passes and fails on its own.
const STEADY = [/^No app attached/, /is not a step/, /\bneeds an? /, /^no alias /, /declares no fixtures/, /declares none/, /^no command \S+ registered/];

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

  note(report: CaseReport & { retried?: boolean }, at = new Date(), version?: string): void {
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
      },
    ].slice(-KEPT);
  }

  /** How long a case took when it last passed, if the ledger has seen it pass. */
  lastMs(id: string): number | undefined {
    return [...(this.ledger[id]?.last ?? [])].reverse().find((o) => o.result === 'passed' && o.ms !== undefined)?.ms;
  }

  /** The cases among `ids` whose recent runs disagree with each other, worded for a summary. */
  flaky(ids: string[]): string[] {
    return ids.flatMap((id) => {
      const last = (this.ledger[id]?.last ?? []).filter(countsForFlakiness);
      const shaky = last.filter((o) => o.result === 'failed' || o.retried).length;
      if (shaky === 0 || shaky === last.length) return [];
      return [`⚠ ${id} is flaky: ${shaky} of its last ${last.length} runs failed or needed a second chance`];
    });
  }

  save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, `${JSON.stringify(this.ledger, null, 2)}\n`);
  }
}

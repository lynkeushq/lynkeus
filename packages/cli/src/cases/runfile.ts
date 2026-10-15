/**
 * Writes a run of cases as the directory `lynkeus-protocol` describes: run.json
 * and cases.jsonl. The manifest is written at the start and again at the end,
 * so a run that was cut short still says when it began and what it ran on.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { RUN_SCHEMA, type RunCase, type RunManifest, type RunStep } from 'lynkeus-protocol';

import type { Case } from './format.js';
import type { CaseReport } from './runner.js';

export type Attempt = { report: CaseReport; attempt: number; startedAt: Date };

/** Paths in the run file are relative to its directory, so the directory can move. */
const within = (dir: string | undefined, file: string | undefined) => (file ? (dir ? path.relative(dir, file) : file) : undefined);

export const toRunCase = (c: Case, { report, attempt, startedAt }: Attempt, root: string, dir?: string): RunCase => {
  const steps: RunStep[] = report.steps.map((s, index) => {
    // The runner numbers an event's step from 1, in the order the steps ran.
    const told = (report.events ?? [])
      .filter((e) => e.step === index + 1)
      .map((e) => ({
        origin: 'app' as const,
        ...(e.provider ? { provider: e.provider } : {}),
        name: e.name,
        ...(e.props ? { props: e.props } : {}),
        ...(e.route ? { route: e.route } : {}),
      }));
    const sent = (s.sent ?? []).map((e) => ({
      origin: e.via === 'server' ? ('server' as const) : ('app' as const),
      provider: e.provider,
      name: e.name,
      ...(e.props ? { props: e.props } : {}),
    }));
    const events = [...told, ...sent];
    const screenshot = within(dir, s.screenshot);
    return {
      step: s.step,
      status: s.status,
      ms: s.ms,
      ...(s.error ? { error: s.error } : {}),
      section: index < c.setup.length ? 'setup' : 'steps',
      ...(events.length > 0 ? { events } : {}),
      ...(screenshot ? { screenshot } : {}),
      ...(s.videoS !== undefined ? { videoS: s.videoS } : {}),
      ...(s.backend?.length ? { backend: s.backend } : {}),
      ...(s.requests?.length ? { requests: s.requests } : {}),
    };
  });
  const description = typeof c.meta.description === 'string' ? c.meta.description : undefined;
  const video = within(dir, report.video);
  return {
    id: report.id,
    ...(report.title ? { title: report.title } : {}),
    ...(description ? { description } : {}),
    ...(report.about ? { about: report.about } : {}),
    file: path.relative(root, path.resolve(root, report.file)),
    attempt,
    result: report.result,
    startedAt: startedAt.toISOString(),
    ms: report.ms,
    steps,
    ...(report.diagnosis ? { diagnosis: report.diagnosis } : {}),
    ...(report.evidence ? { evidence: report.evidence } : {}),
    ...(video ? { video } : {}),
  };
};

/** The branch and commit the run was made from, so a report can say which code it tested. */
const gitOf = (root: string): RunManifest['git'] => {
  const ask = (...args: string[]) => {
    try {
      return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
    } catch {
      return undefined;
    }
  };
  const commit = ask('rev-parse', '--short', 'HEAD');
  if (!commit) return undefined;
  const branch = process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || ask('rev-parse', '--abbrev-ref', 'HEAD');
  const remote = webOf(ask('remote', 'get-url', 'origin'));
  // What the run had that no commit has: a report says the app was not exactly the commit it names.
  const changed = (ask('status', '--porcelain', '--untracked-files=no') ?? '')
    .split('\n')
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
  return {
    commit,
    ...(branch && branch !== 'HEAD' ? { branch } : {}),
    ...(remote ? { remote } : {}),
    ...(changed.length ? { changed: changed.slice(0, 20), changedCount: changed.length } : {}),
  };
};

/** A remote as a web address a report can link commits to, without any credentials it carried. */
export const webOf = (url: string | undefined): string | undefined => {
  if (!url) return undefined;
  const ssh = url.match(/^[\w.-]+@([\w.-]+):(.+?)(\.git)?$/);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:' && u.protocol !== 'ssh:') return undefined;
    return `https://${u.hostname}${u.pathname.replace(/\.git$/, '')}`;
  } catch {
    return undefined;
  }
};

export class RunFile {
  private readonly manifest: RunManifest;
  private readonly last = new Map<string, { result: RunCase['result']; attempt: number }>();

  constructor(
    private readonly dir: string,
    private readonly root: string,
    startedAt = new Date(),
  ) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'cases.jsonl'), '');
    const git = gitOf(root);
    this.manifest = { schema: RUN_SCHEMA, startedAt: startedAt.toISOString(), ...(git ? { git } : {}) };
    this.save();
  }

  /** Where a case's frames and film go: one folder per attempt. */
  evidenceDir(id: string, attempt: number): string {
    return path.join(this.dir, `${id.replace(/[^\w.=-]+/g, '_')}${attempt > 1 ? `.${attempt}` : ''}`);
  }

  add(c: Case, attempt: Attempt): void {
    const line = toRunCase(c, attempt, this.root, this.dir);
    fs.appendFileSync(path.join(this.dir, 'cases.jsonl'), `${JSON.stringify(line)}\n`);
    this.last.set(line.id, { result: line.result, attempt: line.attempt });
  }

  finish(app: { platform?: string; native?: boolean } = {}, finishedAt = new Date()): void {
    const cases = [...this.last.values()];
    this.manifest.finishedAt = finishedAt.toISOString();
    if (app.platform) this.manifest.platform = app.platform;
    if (app.native !== undefined) this.manifest.native = app.native;
    this.manifest.totals = {
      cases: cases.length,
      passed: cases.filter((c) => c.result === 'passed').length,
      failed: cases.filter((c) => c.result === 'failed').length,
      unsupported: cases.filter((c) => c.result === 'unsupported').length,
      retried: cases.filter((c) => c.attempt > 1).length,
    };
    this.save();
  }

  private save(): void {
    fs.writeFileSync(path.join(this.dir, 'run.json'), `${JSON.stringify(this.manifest, null, 2)}\n`);
  }
}

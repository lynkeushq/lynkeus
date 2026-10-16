import fs from 'node:fs';
import path from 'node:path';

import { define } from '../registry.js';

type Fetch = typeof fetch;

export type Pushed = { url: string; files: number; refused: string[]; changes?: { newFailures: string[]; fixed: string[] } };

/** What a run changed against the one before, in a line or two for a terminal or a pull request comment. */
export const describeChanges = (changes: Pushed['changes']): string[] =>
  changes
    ? [
        ...(changes.newFailures.length ? [`newly failing (${changes.newFailures.length}): ${changes.newFailures.join(', ')}`] : []),
        ...(changes.fixed.length ? [`fixed since the run before (${changes.fixed.length}): ${changes.fixed.join(', ')}`] : []),
      ]
    : [];

const answer = async (response: Response, doing: string) => {
  if (response.ok) return response.json() as Promise<Record<string, unknown>>;
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  throw new Error(`${doing}: ${body.error ?? `the service answered ${response.status}`}`);
};

const UPLOADS_AT_ONCE = 8;
const UPLOAD_ATTEMPTS = 3;

/**
 * Uploads a run directory (`case run --out`) to the reports service: the run, its cases, then every frame and
 * film the cases name. A file the organization's plan does not keep (a film on Free) is left out and listed.
 */
export const pushRun = async (dir: string, o: { url: string; key: string; project: string; fetch?: Fetch }): Promise<Pushed> => {
  const call = o.fetch ?? fetch;
  const auth = { authorization: `Bearer ${o.key}` };
  const base = o.url.replace(/\/+$/, '');
  const run = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8')) as unknown;
  const cases = fs.readFileSync(path.join(dir, 'cases.jsonl'), 'utf8');

  const created = await answer(
    await call(`${base}/v1/runs`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ project: o.project, run }),
    }),
    'creating the run',
  );
  const id = String(created.id);
  await answer(await call(`${base}/v1/runs/${id}/cases`, { method: 'PUT', headers: auth, body: cases }), 'sending its cases');

  const named = new Set<string>();
  for (const line of cases.split('\n')) {
    if (!line.trim()) continue;
    const c = JSON.parse(line) as { video?: string; steps?: { screenshot?: string }[] };
    for (const p of [c.video, ...(c.steps ?? []).map((s) => s.screenshot)]) if (p) named.add(p);
  }
  let files = 0;
  const refused: string[] = [];
  // A run with screenshots is thousands of frames: one at a time, each waiting out its round trip, a suite took
  // over 20 minutes to send. A file that fails on the way (a dropped connection, a 5xx, a 429) is sent again.
  const send = async (file: string) => {
    const local = path.join(dir, file);
    if (!fs.existsSync(local)) return;
    const body = fs.readFileSync(local);
    const target = `${base}/v1/runs/${id}/files/${file.split('/').map(encodeURIComponent).join('/')}`;
    for (let attempt = 1; ; attempt++) {
      const response = await call(target, { method: 'PUT', headers: auth, body }).catch((error: unknown) => {
        if (attempt >= UPLOAD_ATTEMPTS) throw new Error(`sending ${file}: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      });
      if (response && (response.ok || response.status === 402 || (response.status < 500 && response.status !== 429) || attempt >= UPLOAD_ATTEMPTS)) {
        if (response.status === 402) refused.push(file);
        else {
          await answer(response, `sending ${file}`);
          files += 1;
        }
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
    }
  };
  const queue = [...named];
  await Promise.all(
    Array.from({ length: Math.min(UPLOADS_AT_ONCE, queue.length) }, async () => {
      for (let file = queue.shift(); file !== undefined; file = queue.shift()) await send(file);
    }),
  );
  const finished = await answer(await call(`${base}/v1/runs/${id}/finish`, { method: 'POST', headers: auth }), 'finishing the run');
  const changes = finished.changes as Pushed['changes'] | undefined;
  return { url: String(finished.url), files, refused, ...(changes ? { changes } : {}) };
};

type Service = { url: string; key: string; fetch?: Fetch };

const ask = async (o: Service, method: string, route: string, doing: string) =>
  answer(await (o.fetch ?? fetch)(`${o.url.replace(/\/+$/, '')}${route}`, { method, headers: { authorization: `Bearer ${o.key}` } }), doing);

export type ListedRun = { project: string; platform: string | null; totals: Record<string, number>; createdAt: string; url: string };

export const listRuns = async (o: Service & { limit?: number }) =>
  (await ask(o, 'GET', `/v1/runs?limit=${o.limit ?? 20}`, 'listing the runs')).runs as ListedRun[];

export type Flaky = {
  id: string;
  title: string;
  runs: number;
  firstTryRate: number;
  state: 'flaky' | 'broken';
  recent: ('passed' | 'retried' | 'failed')[];
  lastFailure: string | null;
};

export const flakes = async (o: Service & { project: string; runs?: number }) =>
  (await ask(o, 'GET', `/v1/flakes?project=${encodeURIComponent(o.project)}&runs=${o.runs ?? 30}`, 'reading flake trends')) as {
    runs: number;
    cases: Flaky[];
  };

export type CaseRun = { at: string; outcome: 'passed' | 'retried' | 'failed'; ms: number | null; branch?: string | null; commit?: string | null; url: string };

export const caseHistory = async (o: Service & { project: string; id: string; runs?: number }) =>
  (await ask(
    o,
    'GET',
    `/v1/cases/history?project=${encodeURIComponent(o.project)}&case=${encodeURIComponent(o.id)}&runs=${o.runs ?? 50}`,
    'reading the case’s history',
  )) as { title: string; runs: CaseRun[] };

export type Plan = { name: string; plan: string; days: number; projects: number | null; film: boolean };

/** The organization's plan, and with `upgrade` or `manage` the Stripe page that changes it. */
export const plan = async (o: Service & { go?: 'upgrade' | 'manage' }) => {
  const now = (await ask(o, 'GET', '/v1/billing', 'reading the plan')) as Plan;
  if (!o.go) return { ...now, url: null };
  const route = o.go === 'upgrade' ? '/v1/billing/checkout' : '/v1/billing/portal';
  return { ...now, url: String((await ask(o, 'POST', route, o.go === 'upgrade' ? 'opening checkout' : 'opening the billing portal')).url) };
};

export const service = (): Service | string => {
  const url = process.env.LYNKEUS_REPORTS_URL || 'https://lynkeus.io';
  const key = process.env.LYNKEUS_REPORTS_KEY;
  return key ? { url, key } : 'set LYNKEUS_REPORTS_KEY to an API key of your organization (lynkeus.io, API keys); LYNKEUS_REPORTS_URL names another service';
};

export const reportCommands = [
  define({
    name: 'report push',
    group: 'runs',
    summary: 'Upload a run to the reports service and print the report’s address',
    details:
      'Uploads what `case run --out <dir>` wrote: the run, its cases, and every frame and film they name. The report shows the film in step with the steps, the events each step sent, and why a case failed. The service and the organization’s key come from LYNKEUS_REPORTS_URL and LYNKEUS_REPORTS_KEY; a film the organization’s plan does not keep is left out and said so.',
    positionals: [{ name: 'dir', help: 'the run directory `case run --out` wrote', required: true }],
    flags: {
      project: { type: 'string', help: 'the project the run is filed under (default: the app’s folder name)', value: 'name' },
    },
    needs: 'nothing',
    session: false,
    mcp: false,
    run: async (ctx) => {
      const dir = path.resolve(ctx.args[0]!);
      if (!fs.existsSync(path.join(dir, 'cases.jsonl')))
        return { text: `${ctx.args[0]}: no cases.jsonl; pass the directory \`case run --out\` wrote`, code: 2 };
      const to = service();
      if (typeof to === 'string') return { text: to, code: 2 };
      const project = typeof ctx.flags.project === 'string' ? ctx.flags.project : path.basename(ctx.root);
      try {
        const pushed = await pushRun(dir, { ...to, project });
        const notes = [...describeChanges(pushed.changes), ...(pushed.refused.length ? [`not kept on this plan: ${pushed.refused.join(', ')}`] : [])];
        return { text: [pushed.url, ...notes].join('\n'), json: pushed };
      } catch (error) {
        return { text: (error as Error).message, code: 1 };
      }
    },
  }),
  define({
    name: 'report list',
    group: 'runs',
    summary: 'List the organization’s reports, newest first',
    details: 'Each line is when the run started, its project and platform, how many cases passed, and the report’s address.',
    flags: { limit: { type: 'string', help: 'how many runs (default 20, at most 100)', value: 'n' } },
    needs: 'nothing',
    session: false,
    mcp: false,
    run: async (ctx) => {
      const to = service();
      if (typeof to === 'string') return { text: to, code: 2 };
      try {
        const runs = await listRuns({ ...to, limit: Number(ctx.flags.limit) || 20 });
        if (runs.length === 0) return { text: 'no reports yet: `lynkeus report push <dir>` uploads one', json: runs };
        const lines = runs.map(
          (r) =>
            `${r.createdAt.slice(0, 16).replace('T', ' ')}  ${r.project}${r.platform ? ` ${r.platform}` : ''}  ${r.totals.passed ?? 0}/${r.totals.cases ?? 0} passed  ${r.url}`,
        );
        return { text: lines.join('\n'), json: runs };
      } catch (error) {
        return { text: (error as Error).message, code: 1 };
      }
    },
  }),
  define({
    name: 'report plan',
    group: 'runs',
    summary: 'Show the organization’s plan, or open the page that changes it',
    details:
      'Free keeps frames for 7 days and one project; Team keeps films too, for 90 days, and any number of projects. `--upgrade` prints the Stripe checkout for Team; `--manage` prints Stripe’s portal for the card, the invoices and cancelling.',
    flags: {
      upgrade: { type: 'boolean', help: 'print the Stripe checkout address for the Team plan' },
      manage: { type: 'boolean', help: 'print the Stripe portal address for a paying organization' },
    },
    needs: 'nothing',
    session: false,
    mcp: false,
    run: async (ctx) => {
      const to = service();
      if (typeof to === 'string') return { text: to, code: 2 };
      const go = ctx.flags.upgrade ? 'upgrade' : ctx.flags.manage ? 'manage' : undefined;
      try {
        const now = await plan({ ...to, go });
        const keeps = `${now.film ? 'films and frames' : 'frames'} for ${now.days} days, ${now.projects ?? 'any number of'} project${now.projects === 1 ? '' : 's'}`;
        return { text: `${now.name}: ${now.plan} (${keeps})${now.url ? `\n${now.url}` : ''}`, json: now };
      } catch (error) {
        return { text: (error as Error).message, code: 1 };
      }
    },
  }),
  define({
    name: 'report flakes',
    group: 'runs',
    summary: 'List the cases that do not always pass at the first try, across the project’s last runs',
    details:
      'Reads the reports pushed for the project and ranks its cases by how often they passed at the first try, the least reliable first. Each line shows the recent runs newest first (✓ passed, ↻ passed on a retry, ✗ failed) and the last report where it went wrong. A case that failed its last three runs is broken rather than flaky. On the Team plan.',
    flags: {
      project: { type: 'string', help: 'the project (default: the app’s folder name)', value: 'name' },
      runs: { type: 'string', help: 'how many of the latest runs to read (default 30)', value: 'n' },
    },
    needs: 'nothing',
    session: false,
    mcp: false,
    run: async (ctx) => {
      const to = service();
      if (typeof to === 'string') return { text: to, code: 2 };
      const project = typeof ctx.flags.project === 'string' ? ctx.flags.project : path.basename(ctx.root);
      try {
        const found = await flakes({ ...to, project, runs: Number(ctx.flags.runs) || 30 });
        if (found.cases.length === 0) return { text: `${project}: every case passed at the first try in the last ${found.runs} runs`, json: found };
        const mark = { passed: '✓', retried: '↻', failed: '✗' } as const;
        const lines = found.cases.map(
          (c) =>
            `${c.state === 'broken' ? 'broken' : 'flaky '}  ${Math.round(c.firstTryRate * 100)
              .toString()
              .padStart(3)}%  ${c.recent.map((r) => mark[r]).join('')}  ${c.id}${c.lastFailure ? `  ${c.lastFailure}` : ''}`,
        );
        return { text: [`${project}: ${found.runs} runs`, ...lines].join('\n'), json: found };
      } catch (error) {
        return { text: (error as Error).message, code: 1 };
      }
    },
  }),
  define({
    name: 'report history',
    group: 'runs',
    summary: 'Show how one case came out in each of the project’s last runs',
    details:
      'Newest first: ✓ passed, ↻ passed on a retry, ✗ failed, with how long it took, the branch and commit the run was made from, and the report to open. What tells a case that fails now and then from one a commit broke.',
    positionals: [{ name: 'case', help: 'the case id', required: true }],
    flags: {
      project: { type: 'string', help: 'the project (default: the app’s folder name)', value: 'name' },
      runs: { type: 'string', help: 'how many of the latest runs to read (default 50)', value: 'n' },
    },
    needs: 'nothing',
    session: false,
    mcp: false,
    run: async (ctx) => {
      const to = service();
      if (typeof to === 'string') return { text: to, code: 2 };
      const project = typeof ctx.flags.project === 'string' ? ctx.flags.project : path.basename(ctx.root);
      try {
        const found = await caseHistory({ ...to, project, id: ctx.args[0]!, runs: Number(ctx.flags.runs) || 50 });
        if (found.runs.length === 0) return { text: `${ctx.args[0]} is in none of ${project}'s recent runs`, json: found };
        const mark = { passed: '✓', retried: '↻', failed: '✗' } as const;
        const lines = found.runs.map(
          (r) =>
            `${mark[r.outcome]}  ${r.at.slice(0, 16).replace('T', ' ')}  ${(r.ms === null ? '—' : `${(r.ms / 1000).toFixed(1)}s`).padStart(6)}  ${[r.branch, r.commit].filter(Boolean).join(' @ ') || '—'}  ${r.url}`,
        );
        return { text: [`${found.title} (${project})`, ...lines].join('\n'), json: found };
      } catch (error) {
        return { text: (error as Error).message, code: 1 };
      }
    },
  }),
];

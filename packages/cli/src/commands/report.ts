import fs from 'node:fs';
import path from 'node:path';

import { define } from '../registry.js';
import { ageOf, megabytes, pruneRuns } from '../cases/runDirs.js';
import { keptOrDeleted } from './cases.js';

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

const UPLOADS_AT_ONCE = 4;
const CASES_PART = 256 * 1024;
const UPLOAD_ATTEMPTS = 3;

// A ustar header holds a name of up to 100 bytes and a folder of up to 155 before it.
const fitsTar = (file: string) => {
  const cut = file.lastIndexOf('/');
  return Buffer.byteLength(file.slice(cut + 1)) <= 100 && Buffer.byteLength(cut > 0 ? file.slice(0, cut) : '') <= 155;
};

/** An uncompressed tar: frames are PNG or AVIF, already compressed, and a tar is read as it arrives. */
export const tarOf = (entries: [string, Uint8Array][]): Uint8Array => {
  const blocks: Uint8Array[] = [];
  for (const [file, data] of entries) {
    const header = Buffer.alloc(512);
    const cut = file.lastIndexOf('/');
    header.write(file.slice(cut + 1), 0, 'utf8');
    header.write('0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write(
      `${Math.floor(Date.now() / 1000)
        .toString(8)
        .padStart(11, '0')}\0`,
      136,
    );
    header.write('0', 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    if (cut > 0) header.write(file.slice(0, cut), 345, 'utf8');
    header.fill(' ', 148, 156);
    const sum = header.reduce((n, b) => n + b, 0);
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
};

type Target = { url: string; key: string; fetch?: Fetch };

const serviceBase = (url: string): string => {
  const parsed = new URL(url);
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !loopback) throw new Error('the reports service must use HTTPS outside loopback');
  if (parsed.username || parsed.password) throw new Error('the reports URL must not embed credentials');
  return parsed.toString().replace(/\/+$/, '');
};

const insideRun = (dir: string, file: string): string => {
  const root = path.resolve(dir);
  const candidate = path.resolve(root, file);
  if (candidate === root || !candidate.startsWith(`${root}${path.sep}`)) throw new Error(`file path escapes the run directory: ${file}`);
  if (!fs.existsSync(candidate)) return candidate;
  const realRoot = fs.realpathSync(root);
  const realCandidate = fs.realpathSync(candidate);
  if (realCandidate === realRoot || !realCandidate.startsWith(`${realRoot}${path.sep}`)) {
    throw new Error(`file path escapes the run directory: ${file}`);
  }
  return realCandidate;
};

/**
 * What a run's upload sends besides its cases, shared by a push at the end and a report filled as the run goes:
 * a case's frames as one tar, its film on its own, each tried again on a dropped connection, a 5xx or a 429. A
 * file the organization's plan does not keep (a film on Free) is left out and listed.
 */
const uploader = (o: Target, id: string, dir: string) => {
  const call = o.fetch ?? fetch;
  const auth = { authorization: `Bearer ${o.key}` };
  const base = serviceBase(o.url);
  const sendWithRetries = async (target: string, body: Uint8Array, doing: string): Promise<Response> => {
    for (let attempt = 1; ; attempt++) {
      const response = await call(target, { method: 'PUT', headers: auth, body, redirect: 'manual' }).catch((error: unknown) => {
        if (attempt >= UPLOAD_ATTEMPTS) throw new Error(`${doing}: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      });
      if (response && ((response.status < 500 && response.status !== 429) || attempt >= UPLOAD_ATTEMPTS)) return response;
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
    }
  };
  const done = { files: 0, refused: [] as string[] };
  const sendFile = async (file: string) => {
    const target = `${base}/v1/runs/${id}/files/${file.split('/').map(encodeURIComponent).join('/')}`;
    const response = await sendWithRetries(target, fs.readFileSync(insideRun(dir, file)), `sending ${file}`);
    if (response.status === 402) done.refused.push(file);
    else {
      await answer(response, `sending ${file}`);
      done.files += 1;
    }
  };
  // A suite with screenshots is thousands of frames: a request per frame took one over 20 minutes to send. A
  // service from before bundles answers 404, and the frames then go one by one, as they used to.
  let bundles = true;
  const sendFrames = async (frames: string[]) => {
    const fits = frames.filter(fitsTar);
    if (bundles && fits.length > 0) {
      const response = await sendWithRetries(
        `${base}/v1/runs/${id}/bundle`,
        tarOf(fits.map((f) => [f, fs.readFileSync(insideRun(dir, f))])),
        `sending ${fits.length} frames`,
      );
      if (response.status === 404 || response.status === 405) bundles = false;
      else {
        await answer(response, `sending ${fits.length} frames`);
        done.files += fits.length;
        for (const f of frames.filter((f) => !fitsTar(f))) await sendFile(f);
        return;
      }
    }
    for (const f of frames) await sendFile(f);
  };
  /** What a case's line names that is on disk: its frames, once each, and its film. */
  const filesOf = (c: { video?: string; steps?: { screenshot?: string }[] }) => {
    const frames = (c.steps ?? []).map((s) => s.screenshot).filter((p): p is string => !!p && fs.existsSync(insideRun(dir, p)));
    const film = c.video && fs.existsSync(insideRun(dir, c.video)) ? c.video : undefined;
    return { frames: [...new Set(frames)], ...(film ? { film } : {}) };
  };
  const sendCase = async (c: { frames: string[]; film?: string }) => {
    await sendFrames(c.frames);
    if (c.film) await sendFile(c.film);
  };
  /** One part of the run file; false when the service takes the file only whole (one from before parts). */
  const sendPart = async (n: number, text: string): Promise<boolean> => {
    const sent = await answer(await sendWithRetries(`${base}/v1/runs/${id}/cases?part=${n}`, Buffer.from(text), 'sending its cases'), 'sending its cases');
    return sent.part !== undefined;
  };
  const sendWhole = async (text: string) =>
    answer(await call(`${base}/v1/runs/${id}/cases`, { method: 'PUT', headers: auth, body: text, redirect: 'manual' }), 'sending its cases');
  /** The run closed, with its manifest as it ended (a service from before reads none and keeps the first). */
  const finish = async (manifest?: unknown) =>
    answer(
      await call(`${base}/v1/runs/${id}/finish`, {
        method: 'POST',
        redirect: 'manual',
        headers: manifest ? { ...auth, 'content-type': 'application/json' } : auth,
        ...(manifest ? { body: JSON.stringify({ run: manifest }) } : {}),
      }),
      'finishing the run',
    );
  return { done, filesOf, sendCase, sendPart, sendWhole, finish };
};

const createRun = async (o: Target & { project: string }, run: unknown, live?: { planned: number }) =>
  answer(
    await (o.fetch ?? fetch)(`${serviceBase(o.url)}/v1/runs`, {
      method: 'POST',
      redirect: 'manual',
      headers: { authorization: `Bearer ${o.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ project: o.project, run, ...(live ? { live: true, planned: live.planned } : {}) }),
    }),
    'creating the run',
  );

/**
 * Uploads a run directory (`case run --out`) to the reports service: the run, its cases, then every frame and
 * film the cases name. A file the organization's plan does not keep (a film on Free) is left out and listed.
 */
export const pushRun = async (
  dir: string,
  o: Target & { project: string; onReady?: (url: string) => void; onProgress?: (line: string) => void },
): Promise<Pushed> => {
  const run = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8')) as unknown;
  const cases = fs.readFileSync(path.join(dir, 'cases.jsonl'), 'utf8');
  const id = String((await createRun(o, run)).id);
  const up = uploader(o, id, dir);
  // The run file in parts of about 256 KB: with every request's headers and bodies it runs to megabytes, more
  // than the service reads in one request. A service from before parts answers without `part`, and then
  // takes the whole file in one.
  const parts: string[] = [];
  for (const line of cases.split('\n').filter((l) => l.trim())) {
    const last = parts.length - 1;
    if (last >= 0 && Buffer.byteLength(parts[last]!) + Buffer.byteLength(line) < CASES_PART) parts[last] += `\n${line}`;
    else parts.push(line);
  }
  for (const [n, part] of parts.entries()) {
    if (!(await up.sendPart(n, part))) {
      await up.sendWhole(cases);
      break;
    }
  }
  // The report opens as soon as its cases are in: their steps, results and requests show at once, and each
  // frame as it arrives.
  const finished = await up.finish();
  o.onReady?.(String(finished.url));

  // Per case: its frames, sent as one tar, and its film, sent on its own (a film can be bigger than a request).
  const work = cases
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => up.filesOf(JSON.parse(line) as { video?: string; steps?: { screenshot?: string }[] }));
  const queue = [...work];
  const total = work.length;
  let sent = 0;
  let bytes = 0;
  const started = Date.now();
  const sizeOf = (c: { frames: string[]; film?: string }) =>
    [...c.frames, ...(c.film ? [c.film] : [])].reduce((n, f) => n + fs.statSync(insideRun(dir, f)).size, 0);
  await Promise.all(
    Array.from({ length: Math.min(UPLOADS_AT_ONCE, queue.length) }, async () => {
      for (let c = queue.shift(); c !== undefined; c = queue.shift()) {
        await up.sendCase(c);
        sent += 1;
        bytes += sizeOf(c);
        if (sent === total || sent % Math.max(1, Math.ceil(total / 10)) === 0)
          o.onProgress?.(`frames: ${sent}/${total} cases, ${(bytes / 1024 / 1024).toFixed(1)} MB in ${((Date.now() - started) / 1000).toFixed(0)} s`);
      }
    }),
  );
  const changes = finished.changes as Pushed['changes'] | undefined;
  return { url: String(finished.url), files: up.done.files, refused: up.done.refused, ...(changes ? { changes } : {}) };
};

export type LiveRun = {
  /** The report's address, open from the start. */
  url: string;
  /** An attempt's line and what it names, sent behind the run: the run never waits for it. */
  add: (line: { video?: string; steps?: { screenshot?: string }[] }) => void;
  /** Everything sent, the run closed with its final manifest: the report as `pushRun` leaves it. */
  finish: (manifest: unknown) => Promise<Pushed>;
};

/**
 * A report that fills as the run goes: made when the run starts, each attempt's line and files sent as it ends
 * (one part of the run file each), and closed when the run ends. A send that fails is tried again at the end,
 * so a moment without network costs the live view, not the report. A service from before parts gets the
 * whole run file at the end, and shows the report only then.
 */
export const startLiveRun = async (dir: string, o: Target & { project: string; planned: number; onError?: (line: string) => void }): Promise<LiveRun> => {
  const run = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8')) as unknown;
  const created = await createRun(o, run, { planned: o.planned });
  const id = String(created.id);
  const up = uploader(o, id, dir);
  let next = 0;
  let parts = true;
  const lines: string[] = [];
  const unsent = new Map<number, string>();
  const filesLeft: { frames: string[]; film?: string }[] = [];
  let chain: Promise<void> = Promise.resolve();
  const add: LiveRun['add'] = (line) => {
    const text = JSON.stringify(line);
    const n = next++;
    lines.push(text);
    const files = up.filesOf(line);
    chain = chain.then(async () => {
      if (parts) {
        try {
          parts = await up.sendPart(n, text);
        } catch (error) {
          unsent.set(n, text);
          o.onError?.(`report: case ${n + 1} kept for the end (${(error as Error).message})`);
        }
      }
      try {
        await up.sendCase(files);
      } catch (error) {
        filesLeft.push(files);
        o.onError?.(`report: its files kept for the end (${(error as Error).message})`);
      }
    });
  };
  const finish: LiveRun['finish'] = async (manifest) => {
    await chain;
    if (!parts) await up.sendWhole(lines.join('\n'));
    else for (const [n, text] of unsent) await up.sendPart(n, text);
    for (const files of filesLeft) await up.sendCase(files);
    const finished = await up.finish(manifest);
    const changes = finished.changes as Pushed['changes'] | undefined;
    return { url: String(finished.url ?? created.url), files: up.done.files, refused: up.done.refused, ...(changes ? { changes } : {}) };
  };
  return { url: String(created.url), add, finish };
};

type Service = Target;

const ask = async (o: Service, method: string, route: string, doing: string) =>
  answer(await (o.fetch ?? fetch)(`${serviceBase(o.url)}${route}`, { method, redirect: 'manual', headers: { authorization: `Bearer ${o.key}` } }), doing);

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
    name: 'report prune',
    group: 'runs',
    summary: 'Delete the runs `case run --out` left in a folder that ended more than a while ago',
    details:
      'Looks at the folder given, or each folder right under it, and deletes the ones that hold a run (`run.json` and `cases.jsonl`) older than --older. Nothing else is touched. Pushed reports stay on the service; this only frees the disk.',
    positionals: [{ name: 'dir', help: 'a run folder, or the folder that holds them' }],
    flags: {
      older: { type: 'string', help: 'how old a run must be: 7d, 12h, 30m', value: 'age', default: '7d' },
      'dry-run': { type: 'boolean', help: 'list what would go, delete nothing' },
    },
    needs: 'nothing',
    session: false,
    mcp: false,
    run: async (ctx) => {
      const root = path.resolve(ctx.args[0] ?? '.');
      if (!fs.existsSync(root)) return { text: `${ctx.args[0]}: no such folder`, code: 2 };
      const older = ageOf(String(ctx.flags.older ?? '7d'));
      if (older === undefined) return { text: `--older ${ctx.flags.older}: give it as 7d, 12h or 30m`, code: 2 };
      const dry = !!ctx.flags['dry-run'];
      const { removed, bytes } = pruneRuns(root, older, dry);
      if (removed.length === 0) return { text: 'no run old enough to delete', json: { removed, bytes } };
      return {
        text: [...removed.map((d) => `${dry ? 'would delete' : 'deleted'} ${d}`), `${dry ? 'would free' : 'freed'} ${megabytes(bytes)}`].join('\n'),
        json: { removed, bytes },
      };
    },
  }),
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
        const pushed = await pushRun(dir, { ...to, project, onReady: (url) => ctx.err(`report: ${url} (its frames are on their way)`), onProgress: ctx.err });
        const notes = [
          ...describeChanges(pushed.changes),
          ...(pushed.refused.length ? [`not kept on this plan: ${pushed.refused.join(', ')}`] : []),
          keptOrDeleted(dir, ctx.config.report?.afterPush === 'delete' ? 'delete' : 'keep', pushed.refused.length === 0),
        ];
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

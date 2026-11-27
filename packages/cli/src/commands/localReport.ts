/**
 * A report of a run folder as one HTML page beside it: no service, no network, nothing to install. It reads only
 * what lynkeus-protocol's run.ts describes (run.json and cases.jsonl), so it shows any engine's run, and links the
 * frames and films by their paths in the folder (or carries them inside with `embed`).
 */
import fs from 'node:fs';
import path from 'node:path';

import { RUN_SCHEMA, type RequestRecord, type RunCase, type RunManifest, type RunStep } from 'lynkeus-protocol';

export const REPORT_FILE = 'report.html';

const esc = (value: unknown): string =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const seconds = (ms: number | undefined) => (ms === undefined ? '' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

// A step this slow has its phases written out, as the run's console does.
const SLOW_STEP_MS = 500;
const phaseParts = (s: RunStep) => Object.entries(s.phases ?? {}).map(([phase, ms]) => `${phase} ${seconds(ms)}`);

/** Where a step's time went: on hover over any step's duration, and written out beside a slow one's. */
const phaseTitle = (s: RunStep) => (phaseParts(s).length > 0 ? ` title="${esc(phaseParts(s).join(' · '))}"` : '');
const phaseText = (s: RunStep) => (s.ms >= SLOW_STEP_MS && phaseParts(s).length > 0 ? ` <span class="ms">(${esc(phaseParts(s).join(' · '))})</span>` : '');

const MIME: Record<string, string> = {
  '.avif': 'image/avif',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
};

export type RunRead = { manifest: RunManifest; cases: RunCase[] };

/** The run in a folder `case run --out` wrote; a string says why it is not one. */
export const readRun = (dir: string): RunRead | string => {
  const manifestFile = path.join(dir, 'run.json');
  const casesFile = path.join(dir, 'cases.jsonl');
  if (!fs.existsSync(casesFile)) return `${dir}: no cases.jsonl; pass the folder \`case run --out\` wrote`;
  let manifest: RunManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as RunManifest;
  } catch {
    return `${dir}: no readable run.json; pass the folder \`case run --out\` wrote`;
  }
  if (manifest.schema !== RUN_SCHEMA) return `${dir}: run.json is schema ${manifest.schema}, and this lynkeus reads ${RUN_SCHEMA}`;
  const cases = fs
    .readFileSync(casesFile, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as RunCase];
      } catch {
        // A line cut short by a run that was killed mid-write.
        return [];
      }
    });
  return { manifest, cases };
};

/** A file of the run as the page refers to it: its path inside the folder, or its bytes when the page carries them. */
const source = (dir: string, file: string | undefined, embed: boolean): string | undefined => {
  if (!file) return undefined;
  const at = path.resolve(dir, file);
  // A path in cases.jsonl that leads out of the folder is not the run's: the page never points there.
  if (!at.startsWith(`${path.resolve(dir)}${path.sep}`) || !fs.existsSync(at)) return undefined;
  if (!embed) return file.split(path.sep).map(encodeURIComponent).join('/');
  const mime = MIME[path.extname(at).toLowerCase()] ?? 'application/octet-stream';
  return `data:${mime};base64,${fs.readFileSync(at).toString('base64')}`;
};

const status = (s: string) => ({ passed: '✓', failed: '✗', skipped: '–', unsupported: '⊘' })[s] ?? '·';

const exchange = (title: string, x: RequestRecord['request']) =>
  x && (x.body || (x.headers && Object.keys(x.headers).length))
    ? `<div class="x"><b>${title}</b>${
        x.headers && Object.keys(x.headers).length
          ? `<pre>${esc(
              Object.entries(x.headers)
                .map(([k, v]) => `${k}: ${v}`)
                .join('\n'),
            )}</pre>`
          : ''
      }${x.body ? `<pre>${esc(x.body)}${x.truncated ? '\n…' : ''}</pre>` : ''}</div>`
    : '';

const requestRow = (r: RequestRecord) => {
  const bad = r.error || (r.status !== undefined && r.status >= 400);
  return `<details class="req${bad ? ' bad' : ''}"><summary><code>${esc(r.method)}</code> ${esc(r.url)} <span>${esc(r.error ?? r.status ?? 'no answer')}</span>${r.ms !== undefined ? ` <span>${seconds(r.ms)}</span>` : ''}${r.mocked ? ' <span class="tag">mocked</span>' : ''}</summary>${exchange('request', r.request)}${exchange('response', r.response)}</details>`;
};

const stepExtras = (s: RunStep) => {
  const parts: string[] = [];
  if (s.requests?.length) parts.push(`<div class="sub"><b>Requests</b>${s.requests.map(requestRow).join('')}</div>`);
  if (s.events?.length)
    parts.push(
      `<div class="sub"><b>Events</b><ul>${s.events.map((e) => `<li><code>${esc(e.name)}</code> ${esc(e.origin)}${e.provider ? ` · ${esc(e.provider)}` : ''}${e.props ? ` <code>${esc(JSON.stringify(e.props))}</code>` : ''}</li>`).join('')}</ul></div>`,
    );
  if (s.logs?.length)
    parts.push(
      `<div class="sub"><b>Logs</b><pre>${esc(s.logs.map((l) => `${l.level.padEnd(5)} ${l.source.padEnd(6)} ${l.text}${l.stack ? `\n${l.stack}` : ''}`).join('\n'))}</pre></div>`,
    );
  if (s.backend?.length)
    parts.push(
      `<div class="sub"><b>Backend</b><pre>${esc(s.backend.map((b) => `${'  '.repeat(b.depth)}${b.name} ${seconds(b.ms)}${b.error ? ` ✗ ${b.error}` : ''}`).join('\n'))}</pre></div>`,
    );
  if (s.looked) parts.push(`<div class="sub"><b>What the step saw</b><pre>${esc(s.looked.listing)}</pre></div>`);
  return parts.length ? `<details class="more"><summary>details</summary>${parts.join('')}</details>` : '';
};

const caseSection = (dir: string, attempts: RunCase[], embed: { frames: boolean; film: boolean }, index: number) => {
  const c = attempts.at(-1)!;
  const video = source(dir, c.video, embed.film);
  const about = c.about ?? (c.description ? { description: c.description } : undefined);
  const id = `case-${index}`;
  let heading: string | undefined;
  const rows = c.steps
    .map((s, i) => {
      const frame = source(dir, s.screenshot, embed.frames);
      const group = s.section === 'setup' ? 'Setup' : (s.heading ?? 'Steps');
      const head = group !== heading ? `<li class="group">${esc(group)}</li>` : '';
      heading = group;
      return `${head}<li class="step ${esc(s.status)}"${s.videoS !== undefined ? ` data-at="${s.videoS}"` : ''}>
  <div class="frame">${frame ? `<a href="${frame}" data-zoom><img loading="lazy" src="${frame}" alt="frame after step ${i + 1}"></a>` : '<span class="none">no frame</span>'}</div>
  <div class="what"><span class="mark">${status(s.status)}</span> <span class="n">${i + 1}</span> <code>${esc(s.step)}</code> <span class="ms"${phaseTitle(s)}>${seconds(s.ms)}</span>${phaseText(s)}${s.videoS !== undefined && video ? ` <button class="seek" data-at="${s.videoS}">▶ ${s.videoS.toFixed(1)} s</button>` : ''}
  ${s.error ? `<pre class="err">${esc(s.error)}</pre>` : ''}${stepExtras(s)}</div>
</li>`;
    })
    .join('\n');
  const earlier = attempts.slice(0, -1);
  return `<section class="case ${esc(c.result)}" id="${id}" data-result="${esc(c.result)}">
<h2><span class="badge ${esc(c.result)}">${esc(c.result)}</span> ${esc(c.title ?? c.id)}</h2>
<p class="meta"><code>${esc(c.id)}</code> · ${esc(c.file)} · ${seconds(c.ms)}${c.attempt > 1 ? ` · attempt ${c.attempt}` : ''}${earlier.length ? ` · earlier: ${earlier.map((a) => `attempt ${a.attempt} ${esc(a.result)}`).join(', ')}` : ''}</p>
${about ? `<dl class="about">${(['description', 'why', 'given', 'expected', 'ticket'] as const).map((k) => (about[k] ? `<dt>${k}</dt><dd>${esc(about[k])}</dd>` : '')).join('')}</dl>` : ''}
${c.diagnosis?.length ? `<div class="diag"><b>Why it failed</b><ul>${c.diagnosis.map((d) => `<li>${esc(d)}</li>`).join('')}</ul></div>` : ''}
${c.evidence?.why ? `<div class="diag"><b>Evidence</b><pre>${esc(c.evidence.why)}</pre></div>` : ''}
${c.evidence?.screen ? `<details class="more"><summary>screen at the failure</summary><pre>${esc(c.evidence.screen)}</pre></details>` : ''}
${video ? `<video controls preload="metadata" src="${video}"></video>` : ''}
<ol class="steps">${rows}</ol>
</section>`;
};

const STYLE = `
:root{--bg:#fff;--fg:#1d1d1f;--muted:#6e6e73;--line:#e3e3e8;--card:#f6f6f8;--ok:#1a7f37;--bad:#c62828;--warn:#9a6700;--code:#f0f0f3}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--fg:#ececf0;--muted:#9a9aa3;--line:#2c2c31;--card:#1c1c20;--ok:#4cc26d;--bad:#ff6b6b;--warn:#e3b341;--code:#26262b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px 64px}h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:0 0 4px}
code,pre{font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}code{background:var(--code);padding:1px 4px;border-radius:4px;word-break:break-word}
pre{background:var(--code);padding:8px;border-radius:6px;overflow:auto;white-space:pre-wrap;word-break:break-word;margin:6px 0}
.meta,.ms,.none,.n{color:var(--muted)}.summary{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0}
.summary button{font:inherit;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:999px;padding:4px 12px;cursor:pointer}
.summary button[aria-pressed=true]{border-color:var(--fg)}
.toc{columns:2 280px;padding-left:18px}.toc a{color:inherit}
.case{border:1px solid var(--line);border-radius:10px;padding:16px;margin:16px 0;background:var(--card)}
.badge{font-size:12px;border-radius:4px;padding:1px 6px;color:#fff;vertical-align:2px}.badge.passed{background:var(--ok)}.badge.failed{background:var(--bad)}.badge.unsupported{background:var(--warn)}
.about{display:grid;grid-template-columns:max-content 1fr;gap:2px 12px;margin:8px 0}.about dt{color:var(--muted)}.about dd{margin:0}
.diag{border-left:3px solid var(--bad);padding:4px 10px;margin:8px 0}.diag ul{margin:4px 0;padding-left:18px}
video{max-width:100%;max-height:480px;margin:8px 0;border-radius:8px;background:#000}
.steps{list-style:none;padding:0;margin:8px 0 0;display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:14px 12px}
.group{grid-column:1/-1;font-weight:600;margin:6px 0 -6px;padding-top:6px;border-top:1px solid var(--line)}
.step{display:flex;flex-direction:column;gap:6px;min-width:0}.step.failed,.step:has(details[open]){grid-column:1/-1;flex-direction:row}
.step.failed .frame,.step:has(details[open]) .frame{flex:0 0 160px}.what{min-width:0;font-size:13px}
.frame img{width:100%;border-radius:6px;border:1px solid var(--line);display:block}.frame .none{display:block;font-size:12px;border:1px dashed var(--line);border-radius:6px;padding:24px 8px;text-align:center}
.step.failed .mark{color:var(--bad)}.step.passed .mark{color:var(--ok)}.step.unsupported .mark{color:var(--warn)}.err{color:var(--bad)}
.err{background:transparent;border:1px solid var(--bad)}.seek{font:inherit;font-size:12px;border:1px solid var(--line);background:var(--bg);color:var(--fg);border-radius:4px;cursor:pointer}
.more summary{cursor:pointer;color:var(--muted);font-size:12px;margin-top:4px}.sub{margin:6px 0}.sub ul{margin:2px 0;padding-left:18px}
.req summary{cursor:pointer;font-size:12px;word-break:break-all}.req.bad summary{color:var(--bad)}.req span{color:var(--muted)}.tag{border:1px solid var(--line);border-radius:4px;padding:0 4px}
.x{margin-left:12px}dialog{border:none;padding:0;background:transparent;max-width:95vw;max-height:95vh}dialog img{max-width:95vw;max-height:95vh;display:block}dialog::backdrop{background:rgba(0,0,0,.8)}
@media (max-width:600px){.steps{grid-template-columns:repeat(2,1fr)}.step.failed,.step:has(details[open]){flex-direction:column}}
`;

const SCRIPT = `
const show=(r)=>{document.querySelectorAll('.case').forEach(c=>{c.hidden=r!=='all'&&c.dataset.result!==r});document.querySelectorAll('.summary button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.show===r)))};
document.querySelectorAll('.summary button').forEach(b=>b.addEventListener('click',()=>show(b.dataset.show)));
document.querySelectorAll('.seek').forEach(b=>b.addEventListener('click',()=>{const v=b.closest('.case').querySelector('video');if(v){v.currentTime=Number(b.dataset.at);v.play();v.scrollIntoView({block:'nearest'})}}));
const d=document.querySelector('dialog');document.querySelectorAll('[data-zoom]').forEach(a=>a.addEventListener('click',e=>{e.preventDefault();d.querySelector('img').src=a.getAttribute('href');d.showModal()}));d.addEventListener('click',()=>d.close());
`;

/** The page for a run: its cases by their last attempt, in the order they ran, each with its steps and what they kept. */
export const renderRunReport = (dir: string, run: RunRead, o: { project?: string; embed?: boolean; embedFilm?: boolean } = {}): string => {
  const { manifest } = run;
  const byId = new Map<string, RunCase[]>();
  for (const c of run.cases) byId.set(c.id, [...(byId.get(c.id) ?? []), c]);
  const groups = [...byId.values()];
  const last = groups.map((g) => g.at(-1)!);
  const count = (r: RunCase['result']) => last.filter((c) => c.result === r).length;
  const totals = { passed: count('passed'), failed: count('failed'), unsupported: count('unsupported') };
  const git = manifest.git;
  const commit = git?.commit
    ? git.remote && git.pushed?.commit
      ? `<a href="${esc(`${git.remote}/commit/${git.commit}`)}">${esc(git.commit)}</a>`
      : esc(git.commit)
    : undefined;
  const started = new Date(manifest.startedAt);
  const took = manifest.finishedAt ? new Date(manifest.finishedAt).getTime() - started.getTime() : undefined;
  const facts = [
    manifest.platform ? `${esc(manifest.platform)}${manifest.native === false ? ', hosted' : manifest.native ? ', on a simulator or device' : ''}` : undefined,
    git?.branch ? `branch ${esc(git.branch)}` : undefined,
    commit ? `commit ${commit}${git?.changedCount ? ` + ${git.changedCount} uncommitted change(s)` : ''}` : undefined,
    took !== undefined ? seconds(took) : manifest.finishedAt ? undefined : 'cut short',
    ...(manifest.launch
      ? Object.entries(manifest.launch)
          .filter(([k]) => k !== 'unsupported')
          .map(([k, v]) => `${esc(k)} ${esc(v)}`)
      : []),
  ].filter(Boolean);
  const title = `${o.project ? `${o.project}: ` : ''}${totals.passed}/${last.length} passed`;
  const native = manifest.nativeValues?.length
    ? `<details class="more"><summary>${manifest.nativeValues.length} native value(s) the host did not answer</summary><ul>${manifest.nativeValues.map((v) => `<li><code>${esc(v.module)}${v.property ? `.${esc(v.property)}` : ''}</code> ${esc(v.platform)} · ${esc(v.host)} read it as ${esc(v.readAs)}</li>`).join('')}</ul></details>`
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; media-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>${esc(title)}</title><style>${STYLE}</style></head>
<body><main>
<h1>${esc(o.project ?? 'Lynkeus run')}</h1>
<p class="meta">${esc(started.toISOString().replace('T', ' ').slice(0, 19))} UTC${facts.length ? ` · ${facts.join(' · ')}` : ''}</p>
<div class="summary">
<button data-show="all" aria-pressed="true">all ${last.length}</button>
<button data-show="passed" aria-pressed="false">passed ${totals.passed}</button>
<button data-show="failed" aria-pressed="false">failed ${totals.failed}</button>
${totals.unsupported ? `<button data-show="unsupported" aria-pressed="false">cannot run here ${totals.unsupported}</button>` : ''}
</div>
${native}
<ul class="toc">${last.map((c, i) => `<li><a href="#case-${i}">${status(c.result)} ${esc(c.title ?? c.id)}</a></li>`).join('')}</ul>
${groups.map((g, i) => caseSection(dir, g, { frames: !!o.embed || !!o.embedFilm, film: !!o.embedFilm }, i)).join('\n')}
<dialog><img alt=""></dialog>
</main><script>${SCRIPT}</script></body></html>
`;
};

/** Writes the page into the run folder and answers its path; a string in `error` says why there is none. */
export const writeRunReport = (dir: string, o: { project?: string; embed?: boolean; embedFilm?: boolean } = {}): { file: string } | { error: string } => {
  const run = readRun(dir);
  if (typeof run === 'string') return { error: run };
  const file = path.join(dir, REPORT_FILE);
  fs.writeFileSync(file, renderRunReport(dir, run, o));
  return { file };
};

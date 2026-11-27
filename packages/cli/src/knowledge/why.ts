/**
 * The screen, the last requests and the trace after a failure, read the way a
 * person would: a dead navigator, a gone session, a 5xx, a covered target, a
 * wording difference, a screen still loading. Each rule names what to do next.
 */
import type { Element, RequestRecord, Screen, TraceEvent } from 'lynkeus-protocol';

import { pathOf } from './problems.js';

export type Evidence = {
  screen: Screen;
  requests: RequestRecord[];
  inFlight: number;
  /** The unanswered requests themselves, which may have started before the failed command (and so be missing from `requests`). */
  pending?: RequestRecord[];
  /** When the evidence was read, on the clock of the requests' startedAt. */
  now?: number;
  trace?: TraceEvent[];
  /** What the failed command was looking for. */
  target?: { testId?: string; text?: string; route?: string };
  /** Whether the app made any request before `requests` begins: `requests` may be only those of the failed command. */
  fetchedBefore?: boolean;
  /** The app's uncommitted source changes as `git diff -U0` prints them, to find where a sought text was rewritten. */
  sourceDiff?: string;
};

export type Finding = { rule: string; message: string };

const fold = (t: string): string =>
  t
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

const distance = (a: string, b: string): number => {
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n]!;
};
const words = (t: string) => new Set(t.split(/[^\p{L}\p{N}]+/u).filter(Boolean));

/**
 * How close a text on screen is to the one sought, 0 when not close enough to name: a few edits away (a typo, an
 * accent), one inside the other (a title that grew words), or sharing most of their words (a title reworded).
 */
const closeness = (a: string, b: string): number => {
  const short = a.length <= b.length ? a : b;
  const long = short === a ? b : a;
  const edits = a.length > 200 || b.length > 200 ? Infinity : distance(a, b);
  // Two edits turn most short words into others ("ok" into "book"): a short text gets one.
  const allowed = long.length <= 4 ? 1 : Math.max(2, Math.floor(long.length * 0.25));
  const byEdits = edits <= allowed ? 1 - edits / Math.max(long.length, 1) : 0;
  const inside = short.length >= 3 && long.includes(short) ? 0.5 + short.length / long.length / 2 : 0;
  const wa = words(a);
  const wb = words(b);
  const shared = [...wa].filter((w) => wb.has(w)).length;
  const union = new Set([...wa, ...wb]).size;
  const byWords = shared >= 2 && shared / union >= 0.5 ? shared / union : 0;
  return Math.max(byEdits, inside, byWords);
};

/** The text on screen closest to the one sought, when one is close enough. */
const closestText = (sought: string, texts: string[]): string | undefined => {
  const want = fold(sought);
  let best: { text: string; score: number } | undefined;
  for (const t of new Set(texts)) {
    if (t === sought) continue;
    const score = closeness(fold(t), want);
    if (score > 0 && (!best || score > best.score)) best = { text: t, score };
  }
  return best?.text;
};

const clip = (line: string) => {
  const t = line.trim();
  return t.length > 80 ? `${t.slice(0, 77)}…` : t;
};

/**
 * Where a diff took a text out: the file and line it was on, and the line that replaced it. Read from `git diff -U0`,
 * so each hunk's removed lines are followed by the lines put in their place.
 */
export const textChangeIn = (diff: string, text: string): { file: string; line: number; before: string; after?: string } | undefined => {
  if (!text.trim()) return undefined;
  let file = '';
  let removed: string[] = [];
  let added: string[] = [];
  let at = 0;
  const found = () => {
    const i = removed.findIndex((l) => l.includes(text));
    if (i < 0 || added.some((l) => l.includes(text))) return undefined;
    const after = added[i] ?? added[0];
    return { file, line: at + Math.min(i, Math.max(added.length - 1, 0)), before: clip(removed[i]!), ...(after !== undefined ? { after: clip(after) } : {}) };
  };
  for (const line of diff.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (line.startsWith('+++ ') || hunk || line.startsWith('diff --git')) {
      const hit = found();
      if (hit) return hit;
      removed = [];
      added = [];
      if (line.startsWith('+++ ')) file = line.slice(4).replace(/^b\//, '');
      if (hunk) at = Number(hunk[1]);
      continue;
    }
    if (line.startsWith('-') && !line.startsWith('---')) removed.push(line.slice(1));
    else if (line.startsWith('+')) added.push(line.slice(1));
  }
  return found();
};

const isTarget = (el: Element, { testId, text }: NonNullable<Evidence['target']>): boolean =>
  !!((testId && el.testId === testId) || (text && (el.text === text || el.accessibilityLabel === text)));

const refusedByHost = (r: RequestRecord) => r.status === 0 && !!r.error && /networkHosts|is off/.test(r.error);

const describeRequest = (r: RequestRecord) => `${r.method} ${pathOf(r.url)} ${r.status ? r.status : (r.error ?? 'failed')}${r.mocked ? ' (mocked)' : ''}`;

export const explain = (e: Evidence): Finding[] => {
  const out: Finding[] = [];
  const els = e.screen.elements;
  const done = e.requests.filter((r) => r.status !== undefined || r.error);
  // An answer the case mocked (`app.mock`) is the case's doing: only what the server answered speaks for the backend.
  const served = done.filter((r) => !r.mocked);
  const status = (n: number) => served.filter((r) => r.status === n);

  if (!e.screen.route && els.length === 0) {
    const crash = e.trace
      ?.slice()
      .reverse()
      .find((t) => t.kind === 'crash');
    out.push(
      crash && crash.kind === 'crash'
        ? {
            rule: 'dead-navigator',
            message: `the screen is empty and has no route: a component threw and took the tree with it — ${crash.message}${crash.stack ? `\n    ${crash.stack.split('\n').slice(1, 4).join('\n    ')}` : ''}`,
          }
        : {
            rule: 'dead-navigator',
            message: 'the screen is empty and has no route: a component threw while rendering. Reset the app and look for the render error in the host log.',
          },
    );
  }

  if (served.length && served.every((r) => r.status === 401))
    out.push({
      rule: 'session-gone',
      message: 'every request answered 401: the session is gone (a logout, a reset, or a key revoked elsewhere). Log in again.',
    });

  const forbidden = status(403);
  if (forbidden.length >= 2)
    out.push({
      rule: 'forbidden',
      message: `the backend refuses ${[...new Set(forbidden.map((r) => pathOf(r.url)))].slice(0, 3).join(', ')} with 403: an account state or a permission, not the screen. Check what the case expects of this user.`,
    });

  const five = served.find((r) => (r.status ?? 0) >= 500);
  if (five)
    out.push({
      rule: 'backend-error',
      message: `the backend answered ${five.status} on ${five.method} ${pathOf(five.url)}: a server error, not the app. Reproduce it with curl before touching the case.`,
    });

  if (status(429).length)
    out.push({
      rule: 'rate-limited',
      message: 'a request answered 429: the backend is rate limiting this client. Space the runs out or raise the limit locally.',
    });

  const stall = e.trace
    ?.slice()
    .reverse()
    .find((t) => t.kind === 'stall');
  if (stall && stall.kind === 'stall')
    out.push({
      rule: 'render-loop',
      message: `the host broke a render loop${stall.component ? ` in ${stall.component}` : ''} (${stall.renders} updates in ${stall.windowMs}ms): the screen is dead until a reset. A component whose effect and store feed each other.`,
    });

  const sought = e.target ? els.find((el) => isTarget(el, e.target!)) : undefined;
  const missing = !sought || (sought.hidden !== undefined && sought.hidden !== 'inert');
  const target = e.target?.testId ? `#${e.target.testId}` : e.target?.text !== undefined ? JSON.stringify(e.target.text) : undefined;

  if (e.target) {
    const { testId, text, route } = e.target;
    if (sought?.hidden) {
      out.push({
        rule: 'hidden',
        message: `${testId ? `#${testId}` : JSON.stringify(text)} is in the tree but not presented (${sought.hidden}): it belongs to a screen the app is not showing. Close what is open, or target something inside it.`,
      });
    }
    if (sought?.covered)
      out.push({
        rule: 'covered',
        message: `${testId ? `#${testId}` : JSON.stringify(text)} is on the screen but covered: a sheet or overlay is over it. Close it, or press what covers it.`,
      });
    if (sought && !sought.enabled)
      out.push({
        rule: 'disabled',
        message: `${testId ? `#${testId}` : JSON.stringify(text)} is on the screen but disabled: a form is not valid yet, or a request it depends on is in flight.`,
      });
    if (!sought && text) {
      const want = fold(text);
      const near = closestText(
        text,
        els.map((el) => el.text ?? el.accessibilityLabel).filter((t): t is string => !!t),
      );
      const change = e.sourceDiff ? textChangeIn(e.sourceDiff, text) : undefined;
      const where = change && `${change.file}:${change.line} changed it in the working tree: ${change.before}${change.after ? ` → ${change.after}` : ''}`;
      if (near)
        out.push({
          rule: 'near-match',
          message: `${JSON.stringify(text)} is not on screen; ${JSON.stringify(near)} is (the text may have changed)${where ? `\n    ${where}` : ''}`,
        });
      else if (where) out.push({ rule: 'text-changed', message: `${JSON.stringify(text)} is not on screen; ${where}` });
      const listed = els.filter((el) => el.testId && /-\d+-item$/.test(el.testId));
      const prefix = want.slice(0, 4);
      if (listed.length >= 10 && prefix && listed.filter((el) => fold(el.text ?? '').includes(prefix)).length >= listed.length / 2)
        out.push({
          rule: 'capped-list',
          message: `the list shows ${listed.length} near matches and yours is not among them: the data has accumulated look-alikes and the list is capped. Search by something unique, or reset the data.`,
        });
    }
    // A screen shows its empty or error state when its data did not come: a missing row next to a failed request is
    // that request's doing, whoever answered it.
    if (missing && target) {
      const failed = done.filter((r) => (r.status ?? 0) >= 400 || (r.error && !refusedByHost(r)));
      if (failed.length)
        out.push({
          rule: 'request-failed',
          message: `${target} is not on screen and ${failed
            .slice(-3)
            .map(describeRequest)
            .join(
              ', ',
            )} failed: the screen is likely showing its empty or error state instead.${failed.some((r) => r.mocked) ? ' A mocked answer is the case’s own (app.mock): check the case wants it here.' : ''}`,
        });
    }
    if (route && e.screen.route && e.screen.route !== route) {
      const recent =
        e.trace
          ?.filter((t) => t.kind === 'route')
          .slice(-3)
          .map((t) => (t.kind === 'route' ? t.route : undefined))
          .filter(Boolean) ?? [];
      if (recent.includes(route))
        out.push({
          rule: 'route-left',
          message: `the app was on ${route} and moved to ${e.screen.route}: something navigated after the step (a redirect, a gate, a modal). The trace shows the order.`,
        });
    }
  }

  if (e.inFlight > 0) {
    // Named, so a request that never comes back (a backend thread stuck, a dropped connection) is told from a slow screen.
    const named = (e.pending ?? []).slice(-3).map((r) => {
      // A host on a clock of its own (fastsim's virtual time) stamps requests on that clock: no age then.
      const age = e.now === undefined ? undefined : e.now - r.startedAt;
      const open = age !== undefined && age >= 0 && age < 86_400_000 ? ` (open ${(age / 1000).toFixed(1)} s)` : '';
      return `${r.method} ${pathOf(r.url)}${open}`;
    });
    out.push({
      rule: 'in-flight',
      message: `${e.inFlight} request(s) still in flight when the command gave up${named.length ? ` (${named.join(', ')})` : ''}: the screen had not finished loading. A longer timeout, or wait for the request it needs.`,
    });
  }

  if (done.length === 0 && e.inFlight === 0 && e.target?.route && !e.fetchedBefore)
    out.push({
      rule: 'no-requests',
      message: 'no request left the app while this ran: nothing was fetched. Is the user logged in, and is the app talking to the backend it should?',
    });

  // Hosts the sandbox refuses are usually third parties nobody needs: named only when nothing else explains it.
  const refused = done.filter(refusedByHost);
  if (refused.length && e.target && out.length === 0)
    out.push({
      rule: 'host-refused',
      message: `${refused.length} request(s) were refused by the host (${[...new Set(refused.map((r) => r.url.replace(/^https?:\/\//, '').split('/')[0]))].slice(0, 3).join(', ')}): if the screen needs one of them, allow the host in networkHosts or mock it.`,
    });

  const lastCommand = e.trace
    ?.slice()
    .reverse()
    .find((t) => t.kind === 'command' && t.error);
  if (lastCommand && lastCommand.kind === 'command' && out.length === 0)
    out.push({ rule: 'last-error', message: `the last command that failed was ${lastCommand.method}: ${lastCommand.error}` });

  // Said only when nothing else is: that the data came is worth knowing, and no reason by itself.
  const answered = served.filter((r) => r.status !== undefined && r.status >= 200 && r.status < 400);
  if (out.length === 0 && target && missing && answered.length && e.inFlight === 0)
    out.push({
      rule: 'requests-ok',
      message: `${target} is not on screen, though the screen's requests answered (${answered
        .slice(-3)
        .map(describeRequest)
        .join(
          ', ',
        )}${answered.length > 3 ? `, ${answered.length - 3} more` : ''}): the data came, so look at what the screen made of it (an empty list from the backend, a filter, a wording).`,
    });

  return out;
};

export const describeWhy = (findings: Finding[]): string =>
  findings.length
    ? findings.map((f) => `  • ${f.message}`).join('\n')
    : '  (nothing in the evidence explains it: the screen, requests and trace look ordinary)';

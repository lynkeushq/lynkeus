import fs from 'node:fs';
import path from 'node:path';

import type { Affected } from '../knowledge/query.js';
import type { Case, Step } from './format.js';

const ROUTE = /^[A-Z][\w.]+$/;

// A step names a route when it goes there, waits for it or checks it is on screen.
const routeOf = (step: Step): string | undefined => {
  const v = step.value;
  const named = (x: unknown) => (typeof x === 'string' && ROUTE.test(x) ? x : undefined);
  if (step.verb === 'app.nav' || step.verb === 'app.wait')
    return (
      named(v) ??
      (v && typeof v === 'object' && !Array.isArray(v) ? named((v as Record<string, unknown>).route ?? (v as Record<string, unknown>).what) : undefined)
    );
  if (step.verb === 'app.see') return v && typeof v === 'object' && !Array.isArray(v) ? named((v as Record<string, unknown>).route) : undefined;
  return undefined;
};

/** The routes a case names in its steps. */
export const routesNamed = (c: Case): string[] => [...new Set([...c.setup, ...c.steps].map(routeOf).filter((r): r is string => !!r))];

/** What `case run --seen <dir>` kept: each passing case's screens, by case id. */
export const readSeen = (dir: string | undefined): Record<string, string[]> => {
  if (!dir || !fs.existsSync(dir)) return {};
  const seen: Record<string, string[]> = {};
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as { id?: string; routes?: unknown };
      if (typeof s.id === 'string' && Array.isArray(s.routes)) seen[s.id] = s.routes.filter((r): r is string => typeof r === 'string');
    } catch {}
  }
  return seen;
};

export type Coverage = {
  routes: number;
  covered: string[];
  uncovered: string[];
  /** Routes a case names that the graph does not know: renamed, or a typo. */
  unknown: string[];
  byRoute: Record<string, string[]>;
  files: Record<string, string>;
};

/** Which cases touch which of the app's routes, by what they name and what they went through last time they passed. */
export const coverageOf = (cases: Case[], graphRoutes: string[], seen: Record<string, string[]> = {}): Coverage => {
  const byRoute: Record<string, string[]> = {};
  const files: Record<string, string> = {};
  const add = (route: string, id: string) => {
    byRoute[route] ??= [];
    if (!byRoute[route].includes(id)) byRoute[route].push(id);
  };
  for (const c of cases) {
    files[c.id] = c.file;
    for (const r of routesNamed(c)) add(r, c.id);
    for (const r of seen[c.id] ?? []) add(r, c.id);
  }
  const known = new Set(graphRoutes);
  const covered = graphRoutes.filter((r) => byRoute[r]?.length);
  return {
    routes: graphRoutes.length,
    covered,
    uncovered: graphRoutes.filter((r) => !byRoute[r]?.length),
    unknown: Object.keys(byRoute)
      .filter((r) => !known.has(r))
      .sort(),
    byRoute,
    files,
  };
};

export type Impact = {
  /** Each case to run, with the reached routes it touches, nearest first. */
  cases: { id: string; file: string; routes: string[]; distance: number; via: string }[];
  /** Routes the change reaches that no case touches. */
  untested: string[];
};

/** The cases a change reaches: the screens it touches or imports, crossed with what each case covers. */
export const impactOf = (affected: Affected[], coverage: Coverage): Impact => {
  const nearest = new Map<string, Affected>();
  for (const a of affected) if (!nearest.has(a.route) || nearest.get(a.route)!.distance > a.distance) nearest.set(a.route, a);
  const byCase = new Map<string, Impact['cases'][number]>();
  const untested: string[] = [];
  for (const [route, hit] of nearest) {
    const ids = coverage.byRoute[route] ?? [];
    if (!ids.length) untested.push(route);
    for (const id of ids) {
      const c = byCase.get(id) ?? { id, file: coverage.files[id] ?? '', routes: [], distance: hit.distance, via: hit.via };
      c.routes.push(route);
      if (hit.distance < c.distance) Object.assign(c, { distance: hit.distance, via: hit.via });
      byCase.set(id, c);
    }
  }
  return { cases: [...byCase.values()].sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id)), untested: untested.sort() };
};

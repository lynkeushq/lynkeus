/**
 * What the project's cases already know, offered back to whoever writes the next one: the way an existing case takes
 * to a screen, and the opening steps several cases repeat. Lynkeus only finds and says; the author decides.
 */
import { stringify } from 'yaml';

import { routeOf, type Seen } from './coverage.js';
import { type Case, type Step, stepOf } from './format.js';
import { label } from './runner.js';

export type Way = {
  /** The case the way comes from. */
  source: string;
  /** `ran`: its last passing run was on the screen after these steps; `named`: its last step goes to, waits for or checks the screen. */
  how: 'ran' | 'named';
  /** From the start of the case: its setup up to the screen, then its steps up to it. From another screen, only steps. */
  setup: Step[];
  steps: Step[];
  /** The project's macros the way calls. */
  macros: string[];
};

type Reach = { at: number; how: Way['how'] };

// A run kept for a case that has changed since says nothing about its steps now.
const reachIn = (all: Step[], seen: Seen | undefined, route: string): Reach | undefined => {
  const walked = seen?.steps;
  if (walked && walked.length === all.length && walked.every((w, i) => w.step === label(all[i]!))) {
    const at = walked.findIndex((w) => w.route === route);
    if (at !== -1) return { at, how: 'ran' };
  }
  const at = all.findIndex((s) => routeOf(s) === route);
  return at === -1 ? undefined : { at, how: 'named' };
};

/**
 * The shortest way a case already takes to `to`: from the start of the case, or from `from` when one is given (a case
 * that is on `from` first). A way a passing run walked beats one a case only names, at the same length.
 */
export const wayTo = (cases: Case[], seen: Record<string, Seen>, to: string, o: { from?: string; skip?: string; macros?: string[] } = {}): Way | undefined => {
  const ways: Way[] = [];
  for (const c of cases) {
    if (c.id === o.skip) continue;
    const all = [...c.setup, ...c.steps];
    const reach = reachIn(all, seen[c.id], to);
    if (!reach) continue;
    let way: Step[] | undefined;
    let setup: Step[] = [];
    if (o.from) {
      const start = reachIn(all, seen[c.id], o.from);
      if (start && start.at < reach.at) way = all.slice(start.at + 1, reach.at + 1);
    } else {
      setup = all.slice(0, Math.min(reach.at + 1, c.setup.length));
      way = all.slice(c.setup.length, reach.at + 1);
    }
    if (!way || way.length + setup.length === 0) continue;
    const macros = [...new Set([...setup, ...way].filter((s) => o.macros?.includes(s.verb)).map((s) => s.verb))];
    ways.push({ source: c.id, how: reach.how, setup, steps: way, macros });
  }
  const length = (w: Way) => w.setup.length + w.steps.length;
  return ways.sort((a, b) => length(a) - length(b) || (a.how === b.how ? 0 : a.how === 'ran' ? -1 : 1) || a.source.localeCompare(b.source))[0];
};

const flow = (value: unknown) => stringify(value, { collectionStyle: 'flow', lineWidth: 0 }).trimEnd();

/** A step as a line of a case's YAML list, without its indent. */
export const stepLine = (step: Step): string => {
  const one = step.value === null ? step.verb : `${step.verb}: ${flow(step.value)}`;
  if (!step.on) return `- ${one}`;
  return `- ${flow({ on: step.on, do: step.value === null ? step.verb : { [step.verb]: step.value } })}`;
};

const MIN_CASES = 3;
const MIN_STEPS = 2;

/** Steps several cases open with, the same in each, and the macro that would say them once. */
export type Repeated = { cases: string[]; steps: Step[]; macro: string; declared?: string };

const sorted = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sorted((value as Record<string, unknown>)[k])]),
    );
  return typeof value === 'string' ? value.trim() : value;
};

// Two steps are the same when only their key order, spacing or own timeout differ.
const keyOf = (step: Step): string => {
  const value = step.value && typeof step.value === 'object' && !Array.isArray(step.value) ? { ...step.value, timeoutMs: undefined } : step.value;
  return `${step.verb}\u0000${JSON.stringify(sorted(value))}`;
};

// The app steps a section opens with: from its first app step to the first one that is not (a fixture, an assert).
const openingOf = (section: Step[], drives: (s: Step) => boolean): Step[] => {
  const start = section.findIndex(drives);
  if (start === -1) return [];
  const end = section.findIndex((s, i) => i > start && !drives(s));
  return section.slice(start, end === -1 ? undefined : end);
};

type Node = { files: Map<string, string>; step?: Step; next: Map<string, Node> };

/**
 * The longest run of app steps that at least three case files open their setup or their steps with, chosen by the
 * steps a macro would save. Matrix variants of one file count once.
 */
export const repeatedOpening = (cases: Case[], macros: Record<string, unknown[]> = {}): Repeated | undefined => {
  const drives = (s: Step) => !s.on && (s.verb.startsWith('app.') || s.verb in macros);
  let best: { node: Node; depth: number; steps: Step[]; score: number } | undefined;
  for (const section of ['setup', 'steps'] as const) {
    const root: Node = { files: new Map(), next: new Map() };
    for (const c of cases) {
      let node = root;
      for (const step of openingOf(c[section], drives)) {
        const key = keyOf(step);
        const child = node.next.get(key) ?? { files: new Map(), step, next: new Map() };
        node.next.set(key, child);
        if (!child.files.has(c.file)) child.files.set(c.file, c.id);
        node = child;
      }
    }
    const walk = (node: Node, steps: Step[]) => {
      for (const child of node.next.values()) {
        if (child.files.size < MIN_CASES) continue;
        const path = [...steps, child.step!];
        const score = child.files.size * (path.length - 1);
        if (path.length >= MIN_STEPS && (!best || score > best.score || (score === best.score && path.length > best.depth)))
          best = { node: child, depth: path.length, steps: path, score };
        walk(child, path);
      }
    };
    walk(root, []);
  }
  if (!best) return undefined;
  const reached = best.steps.map(routeOf).filter((r): r is string => !!r);
  const macro = reached.length ? `app.goTo${reached.at(-1)!.replace(/[^A-Za-z0-9]/g, '')}` : 'app.openCase';
  const wanted = best.steps.map(keyOf).join('\n');
  const declared = Object.entries(macros).find(([, items]) => {
    try {
      return items.map((item) => keyOf(stepOf(item))).join('\n') === wanted;
    } catch {
      return false;
    }
  })?.[0];
  return { cases: [...best.node.files.values()], steps: best.steps, macro, ...(declared ? { declared } : {}) };
};

/** The steps as a macro's entry in lynkeus.config.json, on one line. */
export const macroSnippet = (r: Repeated): string =>
  `${JSON.stringify(r.macro)}: ${JSON.stringify(r.steps.map((s) => (s.value === null ? s.verb : { [s.verb]: s.value })))}`;

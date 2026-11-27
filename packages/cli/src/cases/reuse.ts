/**
 * What the project's cases already know, offered back to whoever writes the next one: the way an existing case takes
 * to a screen. Lynkeus only finds and says; the author decides.
 */
import { stringify } from 'yaml';

import { routeOf, type Seen } from './coverage.js';
import type { Case, Step } from './format.js';
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

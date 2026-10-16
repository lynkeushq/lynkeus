import type { FixtureCommand } from 'lynkeus-protocol';

import type { PlanStep } from '../knowledge/plan.js';

export type DraftInput = {
  id: string;
  title?: string;
  from: string;
  to: string;
  /** The way from `from` to `to`, as `map plan` finds it; undefined when no path is known. */
  path: PlanStep[] | undefined;
  /** What the project's fixtures server says it can do, offered as the setup to pick from. */
  fixtures?: FixtureCommand[];
  /** The project's macros (`app.login`…), offered too. */
  macros?: string[];
  /** The project declares a fixtures server that did not describe itself. */
  fixturesSilent?: boolean;
};

const quote = (s: string) => JSON.stringify(s);

const paramsHint = (c: FixtureCommand) => {
  const params = Object.entries(c.params ?? {}).map(([k, p]) => `${k}${p.values ? ` (${p.values.join('|')})` : ''}`);
  return params.length ? ` — ${params.join(', ')}` : '';
};

/**
 * A case to finish: its frontmatter with the questions a reader needs answered, the backend's setup offered (never
 * chosen: what state the case needs is the author's call), the way to the screen, and the checks left to write.
 */
export const draftCase = (d: DraftInput): string => {
  const lines = [
    '---',
    `id: ${d.id}`,
    `title: ${quote(d.title ?? `[What a person can do on ${d.to}]`)}`,
    'description: >',
    '  [What this case proves, in a sentence or two.]',
    'why: >',
    '  [What breaks for a person if it fails.]',
    'given: >',
    `  [Who the user is and what is true when it starts, on ${d.from}.]`,
    '---',
    'setup:',
  ];
  if (d.fixtures?.length) {
    lines.push('  # Pick what the case needs; the backend answers these (lynkeus fixtures describe):');
    for (const c of d.fixtures) {
      const example = c.example ? ` ${JSON.stringify(c.example).replace(/"(\w+)":/g, '$1: ')}` : ' {}';
      lines.push(`  # - ${c.name}:${example}${c.summary ? `    # ${c.summary}` : ''}${paramsHint(c)}`);
    }
  } else if (d.fixturesSilent)
    lines.push('  # The fixtures server did not answer lynkeus.describe (lynkeus fixtures check says why): the setup options are not listed.');
  else lines.push('  # The state the case needs, through the project’s fixtures (cases.fixtures).');
  lines.push('', 'steps:');
  if (d.macros?.length) lines.push(`  # The project's own steps: ${d.macros.join(', ')}`);
  if (!d.path) {
    lines.push(`  # No known way from ${d.from} to ${d.to}: \`lynkeus crawl --to ${d.to}\` learns one.`);
    lines.push(`  - app.nav: ${d.to}`);
  } else {
    for (const s of d.path) {
      if (s.press) lines.push(`  - app.press: ${quote(`#${s.press}`)}${s.source === 'static' ? '    # from the source: confirm it on screen' : ''}`);
      else lines.push(`  # ${s.from} → ${s.to}: ${s.hint ?? 'find the control that leads here'}`);
      lines.push(`  - app.wait: { what: ${s.opens ? quote(s.opens) : s.to}, timeoutMs: 10000 }`);
    }
  }
  lines.push(
    `  - app.see: { route: ${d.to} }`,
    '  # [What the person does here, and what must be on screen after.]',
    '',
    'expected: |',
    '  [What must be true when it ends, on screen and in the backend.]',
    '',
  );
  return lines.join('\n');
};

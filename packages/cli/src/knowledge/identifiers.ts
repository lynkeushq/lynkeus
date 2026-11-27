/**
 * A change that only renames or removes testIDs (or rewrites an accessibility label) reaches every screen that shows
 * the file, yet only a case that names one of those IDs or labels can notice it. This narrows such a file to those
 * cases, as stringTables.ts does for a changed string, and keeps the whole import reach whenever it cannot tell.
 */
import type { SourcePath } from './types.js';

/** The values that went or came, when a file changed only in the identifiers and labels of its elements. */
export type IdentifierChange = { ids: string[]; labels: string[] };

export type IdentifierNarrowing = {
  /** The changed files still traced through imports: every file whose change was more than identifiers. */
  files: SourcePath[];
  /** Each testID that went or came, with the file that changed it. */
  ids: { id: string; file: SourcePath }[];
  /** Each label that went or came, for the cases that find an element by its text. */
  labels: { text: string; file: SourcePath }[];
  notes: string[];
};

export type IdentifierSources = {
  now: (file: SourcePath) => string | undefined;
  before: (file: SourcePath) => string | undefined;
  /** The runtime's reader: what changed between two versions, or undefined when more than identifiers did. */
  change: (before: string, after: string, file: SourcePath) => Promise<IdentifierChange | undefined>;
};

const listed = (values: string[]) => `${values.slice(0, 3).join(', ')}${values.length > 3 ? `, ${values.length - 3} more` : ''}`;

export const narrowIdentifierChanges = async (changed: SourcePath[], read: IdentifierSources): Promise<IdentifierNarrowing> => {
  const out: IdentifierNarrowing = { files: [], ids: [], labels: [], notes: [] };
  for (const file of changed) {
    const now = read.now(file);
    const was = now === undefined ? undefined : read.before(file);
    const change = now === undefined || was === undefined || was === now ? undefined : await read.change(was, now, file).catch(() => undefined);
    if (!change) {
      out.files.push(file);
      continue;
    }
    for (const id of change.ids) out.ids.push({ id, file });
    for (const text of change.labels) if (text.trim()) out.labels.push({ text, file });
    const what = [
      ...(change.ids.length ? [`testIDs (${listed(change.ids)})`] : []),
      ...(change.labels.length ? [`labels (${listed(change.labels.map((l) => JSON.stringify(l)))})`] : []),
    ];
    out.notes.push(
      what.length
        ? `${file}: only ${what.join(' and ')} changed, so it reaches the cases whose steps name them, not every screen that shows it`
        : `${file}: only comments or formatting changed, so it reaches no screen`,
    );
  }
  return out;
};

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A step string that names the testID: `#id`, `#id[2]`, `#id` inside a longer value, or the bare id of a `testId:` field. */
const namesId = (value: string, id: string): boolean => {
  // A template's `${…}` matches any text there: `item-${…}` is named by `#item-3`.
  const pattern = id.split('${…}').map(escapeRegex).join('[^\\s"\'\\]]*');
  return new RegExp(`(?:^|[^\\w.:/-])#${pattern}(?![\\w.:/-])`).test(value) || new RegExp(`^${pattern}$`).test(value);
};

/** Every string under a step's value, and the steps of the macros it calls, through macros that call macros. */
const stringsOf = (value: unknown, macros: Record<string, unknown[]>, seen: Set<string>): string[] => {
  if (typeof value === 'string') return [value, ...(macros[value] && !seen.has(value) ? stringsOf(macros[value], macros, seen.add(value)) : [])];
  if (Array.isArray(value)) return value.flatMap((v) => stringsOf(v, macros, seen));
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, v]) => [
    ...(macros[key] && !seen.has(key) ? stringsOf(macros[key], macros, seen.add(key)) : []),
    ...stringsOf(v, macros, seen),
  ]);
};

type Step = { verb: string; value: unknown };

/** The cases a step of which (or of a macro it calls) names one of `ids`, with the first it names. */
export const casesNamingIds = <C extends { setup: Step[]; steps: Step[]; teardown?: Step[] }>(
  cases: C[],
  ids: IdentifierNarrowing['ids'],
  macros: Record<string, unknown[]> = {},
): { case: C; id: string; file: SourcePath }[] => {
  const out: { case: C; id: string; file: SourcePath }[] = [];
  for (const c of cases) {
    const strings = [...c.setup, ...c.steps, ...(c.teardown ?? [])].flatMap((s) => stringsOf({ [s.verb]: s.value }, macros, new Set()));
    const hit = ids.find((i) => strings.some((s) => namesId(s, i.id)));
    if (hit) out.push({ case: c, ...hit });
  }
  return out;
};

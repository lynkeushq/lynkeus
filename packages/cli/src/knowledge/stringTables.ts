/**
 * A change to a string table (an app's translations, its copy) reaches every screen that imports the table, which is
 * usually every screen. What it changes is a few strings: the screens that show them are the ones that name their
 * keys, and the cases that check them are the ones that name their text. This narrows such a change to those, and
 * keeps the whole import reach whenever it cannot tell.
 */
import type { ScreenGraph, SourcePath } from './types.js';

/** One string of a table: the table it sits in (its variable, or `default`), its key path and its text. */
export type StringEntry = { table: string; key: string[]; value: string };

/** A string a change added, removed or rewrote. */
export type StringChange = { key: string[]; before?: string; after?: string };

/** The strings added, removed or rewritten between two readings of a table. */
export const diffStringTables = (before: StringEntry[], after: StringEntry[]): StringChange[] => {
  const id = (e: StringEntry) => `${e.table}\u0000${e.key.join('\u0000')}`;
  const old = new Map(before.map((e) => [id(e), e]));
  const now = new Map(after.map((e) => [id(e), e]));
  const changes: StringChange[] = [];
  for (const [k, e] of now) {
    const was = old.get(k);
    if (was?.value !== e.value) changes.push({ key: e.key, ...(was ? { before: was.value } : {}), after: e.value });
  }
  for (const [k, e] of old) if (!now.has(k)) changes.push({ key: e.key, before: e.value });
  return changes;
};

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether a source names a key: as a string (`t('a.b')`, `tx="a:b"`, a key path `'a/b'`), as a member chain
 * (`strings.a.b`), or as a key built from a literal prefix of it (`` t(`a.${x}`) ``, `'a.' + x`), which may be any key under it.
 */
export const namesKey = (source: string, key: string[]): boolean => {
  const parts = key.map(escapeRegex);
  const sep = '[.:/]';
  if (new RegExp(`(['"\`])${parts.join(sep)}\\1`).test(source)) return true;
  if (new RegExp(`[\\w$\\])]\\??\\.${parts.join('\\??\\.')}(?![\\w$])`).test(source)) return true;
  for (let n = 1; n < parts.length; n++) {
    const prefix = parts.slice(0, n).join(sep);
    if (new RegExp(`\`${prefix}${sep}\\$\\{`).test(source) || new RegExp(`(['"])${prefix}${sep}\\1\\s*\\+`).test(source)) return true;
  }
  return false;
};

/** The files that import `file`, directly or through others, at any distance. */
const importersOf = (graph: Pick<ScreenGraph, 'files'>, file: SourcePath): Set<SourcePath> => {
  const importedBy = new Map<SourcePath, SourcePath[]>();
  for (const [f, facts] of Object.entries(graph.files))
    for (const target of [...facts.imports, ...(facts.barrels ?? [])]) importedBy.set(target, [...(importedBy.get(target) ?? []), f]);
  const seen = new Set<SourcePath>();
  const queue = [file];
  while (queue.length) {
    for (const next of importedBy.get(queue.shift()!) ?? []) {
      if (seen.has(next) || next === file) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
};

export type StringNarrowing = {
  /** The changed files to trace through imports instead: each narrowed table replaced by the files that name its changed keys. */
  files: SourcePath[];
  /** The old and new text of every changed string, for the cases that check one. */
  texts: { text: string; file: SourcePath }[];
  /** One line per string table: what it was narrowed to, or why it was not. */
  notes: string[];
};

export type StringSources = {
  /** The file as it is now, or undefined when it is gone. */
  now: (file: SourcePath) => string | undefined;
  /** The file at the base of the diff, or undefined when it is new. */
  before: (file: SourcePath) => string | undefined;
  /** The runtime's string table reader. */
  table: (source: string, file: SourcePath) => Promise<StringEntry[] | undefined>;
};

const shown = (key: string[]) => key.join('.');

/** Narrows each changed string table to the files that name its changed keys; any other changed file stays as it is. */
export const narrowStringTables = async (
  changed: SourcePath[],
  graph: Pick<ScreenGraph, 'files' | 'screens'>,
  read: StringSources,
): Promise<StringNarrowing> => {
  const screenFiles = new Set(Object.values(graph.screens).map((s) => s.file));
  const files = new Set<SourcePath>();
  const texts: StringNarrowing['texts'] = [];
  const notes: string[] = [];
  const contents = new Map<SourcePath, string | undefined>();
  const contentOf = (f: SourcePath) => {
    if (!contents.has(f)) contents.set(f, read.now(f));
    return contents.get(f);
  };
  for (const file of changed) {
    const now = screenFiles.has(file) ? undefined : contentOf(file);
    const was = now === undefined ? undefined : read.before(file);
    const after = now === undefined || was === undefined || was === now ? undefined : await read.table(now, file);
    if (!after) {
      files.add(file);
      continue;
    }
    const before = await read.table(was!, file);
    if (!before) {
      files.add(file);
      notes.push(`${file}: a string table now, but not at the base, so every importer counts`);
      continue;
    }
    const changes = diffStringTables(before, after);
    if (!changes.length) {
      notes.push(`${file}: a string table, and none of its strings changed`);
      continue;
    }
    const importers = [...importersOf(graph, file)];
    const users = new Set<SourcePath>();
    let unnamed: StringChange | undefined;
    for (const change of changes) {
      const naming = importers.filter((f) => {
        const source = contentOf(f);
        return source !== undefined && namesKey(source, change.key);
      });
      for (const f of naming) users.add(f);
      // A string no file names by its key may still be shown (a key built at runtime, a prefix bound elsewhere); one only added is shown nowhere yet.
      if (!naming.length && change.before !== undefined) unnamed ??= change;
    }
    if (unnamed) {
      files.add(file);
      notes.push(`${file}: a string table, but no file names \`${shown(unnamed.key)}\` by its whole key, so every importer counts`);
      continue;
    }
    for (const f of users) files.add(f);
    for (const c of changes) for (const t of [c.before, c.after]) if (t?.trim()) texts.push({ text: t, file });
    const keys = changes.map((c) => shown(c.key));
    notes.push(
      `${file}: only strings changed (${keys.slice(0, 3).join(', ')}${keys.length > 3 ? `, ${keys.length - 3} more` : ''}), so it reaches the ${users.size} file(s) that name them and the cases that check their text, not every importer`,
    );
  }
  return { files: [...files], texts, notes };
};

const normalize = (t: string) => t.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

const stringsIn = (value: unknown): string[] =>
  typeof value === 'string'
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(stringsIn)
      : value && typeof value === 'object'
        ? Object.values(value).flatMap(stringsIn)
        : [];

/**
 * Whether a string a step names is that text or part of it: `app.see: Community` checks "Community", and so may a
 * step naming "community" when the text is "Meet the community". Placeholders (`{{name}}`, `%{n}`) split a text into the parts a screen shows as written.
 */
export const mentionsText = (stepString: string, text: string): boolean => {
  const s = normalize(stepString.replace(/^["']|["']$/g, ''));
  if (s.length < 2) return false;
  const parts = normalize(text)
    .split(/\{\{[^}]*\}\}|%\{[^}]*\}|\{[\w.]+\}|%[sd@]/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 2);
  return parts.some((p) => p === s || (s.length >= 4 && p.includes(s)) || (p.length >= 4 && s.includes(p)));
};

/** The cases a step of which names one of `texts`, with the first text it names. */
export const casesNamingText = <C extends { id: string; file: string; setup: { value: unknown }[]; steps: { value: unknown }[] }>(
  cases: C[],
  texts: StringNarrowing['texts'],
): { case: C; text: string; file: SourcePath }[] => {
  const out: { case: C; text: string; file: SourcePath }[] = [];
  for (const c of cases) {
    const strings = [...c.setup, ...c.steps].flatMap((s) => stringsIn(s.value));
    const hit = texts.find((t) => strings.some((s) => normalize(s) === normalize(t.text))) ?? texts.find((t) => strings.some((s) => mentionsText(s, t.text)));
    if (hit) out.push({ case: c, ...hit });
  }
  return out;
};

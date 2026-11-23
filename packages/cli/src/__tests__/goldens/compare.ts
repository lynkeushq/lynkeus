/**
 * Goldens against what the CLI does now, key by key. A key may differ from its golden only when allowed.json names it,
 * with why and a hash of what it is now: a difference nobody wrote down by hand fails, and so does one that changed
 * again after it was written down.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type Allowed = Record<string, { why: string; now: string }>;

const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );

export const hashOf = (value: unknown): string => crypto.createHash('sha256').update(stable(value)).digest('hex').slice(0, 16);

const linesOf = (value: unknown): string[] => (typeof value === 'string' ? value.split('\n') : (JSON.stringify(value, null, 2) ?? 'undefined').split('\n'));

/** A line diff, with a few lines of context around each change. */
export const diff = (before: unknown, after: unknown): string => {
  const a = linesOf(before);
  const b = linesOf(after);
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: { mark: ' ' | '-' | '+'; line: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ mark: ' ', line: a[i]! });
      i++;
      j++;
    } else if (j < b.length && (i === a.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) out.push({ mark: '+', line: b[j++]! });
    else out.push({ mark: '-', line: a[i++]! });
  }
  const near = (k: number) => out.slice(Math.max(0, k - 3), k + 4).some((o) => o.mark !== ' ');
  return out
    .map((o, k) => (near(k) ? `${o.mark} ${o.line}` : undefined))
    .filter((l, k, all) => l !== undefined || all[k - 1] !== undefined)
    .map((l) => l ?? '  …')
    .join('\n');
};

export const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, 'utf8')) as T;

/** Every key of one section that differs from its golden without leave, and every leave no longer needed. */
export const differences = (section: string, golden: Record<string, unknown>, now: Record<string, unknown>, allowed: Allowed): string[] => {
  const problems: string[] = [];
  for (const key of [...new Set([...Object.keys(golden), ...Object.keys(now)])].sort()) {
    const id = `${section}/${key}`;
    const same = stable(golden[key]) === stable(now[key]);
    const leave = allowed[id];
    if (same) {
      if (leave) problems.push(`${id}: allowed.json lets it differ, but it is as on main again; remove the entry`);
      continue;
    }
    const hash = hashOf(now[key]);
    if (leave?.now === hash) continue;
    const told = leave
      ? `it differs from main as allowed.json says, but not as it said (now ${hash}); check the change and update "now"`
      : `it differs from main. If React Native should behave this way, add to src/__tests__/goldens/rn/allowed.json:\n  "${id}": { "why": "<what changed for React Native and why>", "now": "${hash}" }`;
    problems.push(`${id}: ${told}\n${diff(golden[key], now[key])}`);
  }
  return problems;
};

export const sectionFile = (dir: string, section: string) => path.join(dir, `${section}.json`);

import fs from 'node:fs';
import path from 'node:path';

/** Bytes under a directory, its files and their subfolders'. */
export const sizeOf = (dir: string): number => {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const at = path.join(dir, entry.name);
    if (entry.isDirectory()) total += sizeOf(at);
    else if (entry.isFile()) total += fs.statSync(at).size;
  }
  return total;
};

export const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;

/** `7d`, `12h`, `30m` as milliseconds; anything else is refused. */
export const ageOf = (text: string): number | undefined => {
  const m = /^(\d+)([dhm])$/.exec(text.trim());
  if (!m) return undefined;
  return Number(m[1]) * { d: 86_400_000, h: 3_600_000, m: 60_000 }[m[2] as 'd' | 'h' | 'm'];
};

/** A directory `case run --out` wrote: it holds the run's manifest and its cases. */
const isRun = (dir: string) => fs.existsSync(path.join(dir, 'run.json')) && fs.existsSync(path.join(dir, 'cases.jsonl'));

/**
 * The runs `case run --out` left, at `root` itself or one level under it, that ended longer than `olderMs` ago.
 * Only folders that hold a run are touched; `dry` lists them without removing anything.
 */
export const pruneRuns = (root: string, olderMs: number, dry = false, now = Date.now()): { removed: string[]; bytes: number } => {
  const candidates = isRun(root)
    ? [root]
    : fs
        .readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => path.join(root, e.name))
        .filter(isRun);
  const removed: string[] = [];
  let bytes = 0;
  for (const dir of candidates) {
    if (now - fs.statSync(path.join(dir, 'run.json')).mtimeMs < olderMs) continue;
    bytes += sizeOf(dir);
    removed.push(dir);
    if (!dry) fs.rmSync(dir, { recursive: true, force: true });
  }
  return { removed, bytes };
};

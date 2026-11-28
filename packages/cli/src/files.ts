import fs from 'node:fs';
import path from 'node:path';

export const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, 'utf8')) as T;

export const writeJson = (file: string, value: unknown): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

export const readJsonl = <T>(file: string): T[] => {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as T);
};

export const appendJsonl = (file: string, row: unknown): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
};

// Through a temporary file and a rename, so a reader never sees half a file.
export const writeJsonl = (file: string, rows: unknown[]): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, rows.map((row) => `${JSON.stringify(row)}\n`).join(''));
  fs.renameSync(tmp, file);
};

/*
 * A store several processes add to at once (case runs side by side, a crawl beside them): each process appends only
 * to its own part file in `<file>.parts/`, so no two writers share a file, and folds its part into the store under a
 * lock when it is done. Reading takes the store and every part, so a process killed before folding loses nothing; the
 * next fold takes the parts of processes that are gone.
 */
const partsDir = (file: string) => `${file}.parts`;
const ownPart = (file: string) => path.join(partsDir(file), `${process.pid}.jsonl`);

const parts = (file: string): string[] => {
  try {
    return fs
      .readdirSync(partsDir(file))
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => path.join(partsDir(file), name));
  } catch {
    return [];
  }
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

// Another writer may be halfway through its last line.
const readRows = <T>(file: string): T[] => {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const rows: T[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as T);
    } catch {
      // A torn line is read whole next time.
    }
  }
  return rows;
};

export const appendShared = (file: string, row: unknown): void => appendJsonl(ownPart(file), row);

export const readShared = <T>(file: string): T[] => [...readRows<T>(file), ...parts(file).flatMap((part) => readRows<T>(part))];

const LOCK_STALE_MS = 10_000;
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Runs `fn` holding `<file>.lock`; false when another process held it the whole time. */
const withLock = (file: string, fn: () => void, waitMs = 2000): boolean => {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // A holder that died leaves its lock behind; a fold takes milliseconds, so an old one is nobody's.
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmSync(lock, { force: true });
      } catch {
        // Released meanwhile.
      }
      if (Date.now() > until) return false;
      pause(20);
    }
  }
  try {
    fn();
    return true;
  } finally {
    fs.rmSync(lock, { force: true });
  }
};

/**
 * Rewrites the store as `compact` makes it of the store, this process's part and the parts of processes that are
 * gone, and drops those parts; with nothing to fold it writes nothing unless `always`. A part still being written is
 * left for its writer to fold. False when the lock could not be had: nothing is lost, the parts are still read.
 */
export const foldShared = <T>(file: string, compact: (rows: T[]) => T[], always = false): boolean => {
  const mine = ownPart(file);
  const finished = () => parts(file).filter((part) => part === mine || !alive(Number(path.basename(part, '.jsonl'))));
  if (!always && finished().length === 0) return true;
  return withLock(file, () => {
    const done = finished();
    writeJsonl(file, compact([...readRows<T>(file), ...done.flatMap((part) => readRows<T>(part))]));
    for (const part of done) fs.rmSync(part, { force: true });
  });
};

export const today = () => new Date().toISOString().slice(0, 10);

export const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

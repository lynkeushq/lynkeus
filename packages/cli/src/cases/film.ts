/**
 * Whether a case's film can be played: an MP4 needs its index (the `moov` box) and a duration in its movie header
 * (`mvhd`). A recorder stopped before it finished leaves a file without them (`moov atom not found`), often 0 bytes,
 * and sometimes its temporary file beside it.
 */
import fs from 'node:fs';
import path from 'node:path';

type Box = { type: string; start: number; size: number; header: number };

const boxAt = (fd: number, at: number, end: number): Box | undefined => {
  if (end - at < 8) return undefined;
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, at);
  let size = head.readUInt32BE(0);
  let header = 8;
  if (size === 1) {
    size = Number(head.readBigUInt64BE(8));
    header = 16;
  } else if (size === 0) size = end - at;
  if (size < header || at + size > end) return undefined;
  return { type: head.toString('latin1', 4, 8), start: at, size, header };
};

/** How many seconds an MP4 plays, from its movie header; undefined when it has no index a player can read. */
export const filmSeconds = (file: string): number | undefined => {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return undefined;
  }
  try {
    const end = fs.fstatSync(fd).size;
    for (let at = 0, box = boxAt(fd, at, end); box; at += box.size, box = boxAt(fd, at, end)) {
      if (box.type !== 'moov') continue;
      for (let inner = box.start + box.header, child = boxAt(fd, inner, box.start + box.size); child; ) {
        if (child.type === 'mvhd') {
          const body = Buffer.alloc(Math.min(child.size - child.header, 32));
          fs.readSync(fd, body, 0, body.length, child.start + child.header);
          const v1 = body[0] === 1;
          const timescale = v1 ? body.readUInt32BE(20) : body.readUInt32BE(12);
          const duration = v1 ? Number(body.readBigUInt64BE(24)) : body.readUInt32BE(16);
          return timescale > 0 ? duration / timescale : undefined;
        }
        inner += child.size;
        child = boxAt(fd, inner, box.start + box.size);
      }
      return undefined;
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    fs.closeSync(fd);
  }
};

/** A film that plays, with its size and length, or why there is none, said to stand alone. */
export const checkFilm = (file: string): { bytes: number; seconds: number } | { missing: string } => {
  const bytes = fs.statSync(file, { throwIfNoEntry: false })?.size;
  if (bytes === undefined) return { missing: 'the recorder wrote no file' };
  if (bytes === 0) return { missing: 'the file is empty: the recorder never finished it' };
  const seconds = filmSeconds(file);
  if (seconds === undefined)
    return { missing: `the file (${bytes} bytes) has no index (moov), so nothing can play it: the recorder was stopped before it finished` };
  if (seconds <= 0) return { missing: 'the film holds no frames' };
  return { bytes, seconds };
};

/**
 * Removes what a recorder leaves beside a film it did not finish: macOS's safe-save copy (`video.mp4.sb-…`, from
 * AVFoundation and simctl) and a transfer's `.part`. Answers how many it removed.
 */
export const clearFilmLeftovers = (file: string): number => {
  const dir = path.dirname(file);
  const base = path.basename(file);
  let removed = 0;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names)
    if (name.startsWith(`${base}.sb-`) || name === `${base}.part`) {
      fs.rmSync(path.join(dir, name), { force: true, recursive: true });
      removed++;
    }
  return removed;
};

/** Waits up to `ms` for a recorder that has exited to leave a film that plays (simctl writes its index as it ends). */
export const settledFilm = async (file: string, ms = 3000): Promise<ReturnType<typeof checkFilm>> => {
  const until = Date.now() + ms;
  let checked = checkFilm(file);
  while ('missing' in checked && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 200));
    checked = checkFilm(file);
  }
  return checked;
};

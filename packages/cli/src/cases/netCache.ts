import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/*
 * The folder `case run --net-cache` names: remote fetches a reference run recorded, which a host answers from while
 * it stays off the internet. Its layout is the React Native host's --net_cache: one file per URL, named by the first
 * 16 bytes of the URL's SHA-256 in hex, holding the body; `<name>.json` beside it keeps the URL, status and headers.
 */

export type NetCacheEntry = { url: string; status: number; headers: Record<string, string>; body: string };

/** The file a URL is kept in. */
export const netCacheName = (url: string): string => crypto.createHash('sha256').update(url).digest('hex').slice(0, 32);

/** Writes recorded fetches (bodies in base64) into the folder; returns how many and how many bytes of body. */
export const writeNetCache = (dir: string, entries: NetCacheEntry[]): { files: number; bytes: number } => {
  fs.mkdirSync(dir, { recursive: true });
  let bytes = 0;
  for (const e of entries) {
    const name = netCacheName(e.url);
    const body = Buffer.from(e.body, 'base64');
    fs.writeFileSync(path.join(dir, name), body);
    fs.writeFileSync(path.join(dir, `${name}.json`), `${JSON.stringify({ url: e.url, status: e.status, headers: e.headers }, null, 2)}\n`);
    bytes += body.length;
  }
  return { files: entries.length, bytes };
};

type Commands = { command: (name: string, params?: unknown) => Promise<unknown> };

/** Asks the app's agent to record (or stop recording) its remote fetches; false when this agent cannot. */
export const startNetRecord = async (device: Commands, credentials: boolean): Promise<boolean> =>
  device.command('netcache', { record: true, credentials }).then(
    () => true,
    () => false,
  );

/** Takes what the agent recorded, a piece at a time, into the folder. */
export const takeNetRecord = async (device: Commands, dir: string): Promise<{ files: number; bytes: number }> => {
  const total = { files: 0, bytes: 0 };
  for (let pieces = 0; pieces < 100; pieces++) {
    const got = (await device.command('netcache', { take: true })) as { entries?: NetCacheEntry[]; left?: number };
    const written = writeNetCache(dir, got.entries ?? []);
    total.files += written.files;
    total.bytes += written.bytes;
    if (!got.left) break;
  }
  return total;
};

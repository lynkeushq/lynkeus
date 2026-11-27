import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The launch arguments Lynkeus last started an app with on a Simulator (`os language` passes `-AppleLanguages`), kept
 * per Simulator and app. A Simulator forgets launch arguments with the process: every later launch Lynkeus makes
 * (`app.relaunch`, the relaunch before a case, bringing the app back to the front) passes them again, or the app would
 * come back in the Simulator's own language. Android keeps an app's locale itself (`cmd locale set-app-locales`).
 */
export const launchArgsDir = (): string =>
  process.env.LYNKEUS_LAUNCH_ARGS_DIR ?? path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), 'lynkeus', 'launch-args');

const fileOf = (deviceId: string) => path.join(launchArgsDir(), `${deviceId.replace(/[^\w.-]/g, '_')}.json`);

const readAll = (deviceId: string): Record<string, string[]> => {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(fileOf(deviceId), 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string[]>) : {};
  } catch {
    return {};
  }
};

export const keptLaunchArgs = (deviceId: string, appId: string): string[] => {
  const args = readAll(deviceId)[appId];
  return Array.isArray(args) && args.every((a) => typeof a === 'string') ? args : [];
};

/** Keeps `args` for every later launch of `appId` on `deviceId`; an empty list forgets them. */
export const keepLaunchArgs = (deviceId: string, appId: string, args: string[]): void => {
  const all = readAll(deviceId);
  if (args.length > 0) all[appId] = args;
  else delete all[appId];
  try {
    fs.mkdirSync(launchArgsDir(), { recursive: true });
    fs.writeFileSync(fileOf(deviceId), `${JSON.stringify(all, null, 2)}\n`);
  } catch {
    // A cache that cannot be written only loses the arguments for later relaunches, as before.
  }
};

/** What iOS reads for an app's language and region at launch. */
export const iosLanguageArgs = (tag: string): string[] => ['-AppleLanguages', `(${tag})`, '-AppleLocale', tag.replace('-', '_')];

/** `simctl launch` for an app, with the launch arguments kept for it. */
export const iosLaunchArgv = (deviceId: string, appId: string, fresh: boolean): string[] => [
  'simctl',
  'launch',
  ...(fresh ? ['--terminate-running-process'] : []),
  deviceId,
  appId,
  ...keptLaunchArgs(deviceId, appId),
];

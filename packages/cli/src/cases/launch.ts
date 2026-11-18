import type { RunLaunch, RunLaunchFact } from 'lynkeus-protocol';

import type { LynkeusConfig } from '../config.js';

type Flags = Record<string, unknown>;

/**
 * The seed, locale, time zone and epoch a run launches with: the flag, else `launch` in lynkeus.config.json, else the
 * environment (`LYNKEUS_SEED` has always been one) and, for the locale, the one the config says the app speaks.
 * Returns the problem as text when a value cannot be used, so a typo stops the run before it starts.
 */
export const resolveLaunch = (flags: Flags, config: LynkeusConfig, env: NodeJS.ProcessEnv = process.env): RunLaunch | string => {
  const text = (value: unknown): string | undefined => {
    if (typeof value === 'number') return String(value);
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  };
  const launch: RunLaunch = {};
  const seed = text(flags.seed) ?? text(config.launch?.seed) ?? text(env.LYNKEUS_SEED);
  if (seed) launch.seed = seed;
  const locale = text(flags.locale) ?? text(config.launch?.locale) ?? text(env.LYNKEUS_LOCALE);
  if (locale) {
    try {
      launch.locale = Intl.getCanonicalLocales(locale)[0];
    } catch {
      return `--locale ${locale}: not a language tag (es-AR, de-DE, en-US)`;
    }
  }
  const timeZone = text(flags['time-zone']) ?? text(config.launch?.timeZone) ?? text(env.LYNKEUS_TIME_ZONE);
  if (timeZone) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone });
    } catch {
      return `--time-zone ${timeZone}: not an IANA time zone (America/Argentina/Buenos_Aires, Europe/Madrid, UTC)`;
    }
    launch.timeZone = timeZone;
  }
  const epoch = text(flags.epoch) ?? text(config.launch?.epoch) ?? text(env.LYNKEUS_EPOCH);
  if (epoch) {
    const ms = /^\d+$/.test(epoch) ? Number(epoch) : Date.parse(epoch);
    if (Number.isNaN(ms) || Number.isNaN(new Date(ms).getTime())) return `--epoch ${epoch}: not an instant (2026-03-01T09:00:00Z, or milliseconds since 1970)`;
    launch.epoch = new Date(ms).toISOString();
  }
  return launch;
};

/**
 * What a host the run starts reads at launch (`TZ` too, which Node and Hermes read from the process).
 */
export const launchEnv = (launch: RunLaunch | undefined): Record<string, string> => ({
  ...(launch?.seed ? { LYNKEUS_SEED: launch.seed } : {}),
  ...(launch?.locale ? { LYNKEUS_LOCALE: launch.locale } : {}),
  ...(launch?.timeZone ? { LYNKEUS_TIME_ZONE: launch.timeZone, TZ: launch.timeZone } : {}),
  ...(launch?.epoch ? { LYNKEUS_EPOCH: launch.epoch } : {}),
});

/** `{seed}`, `{locale}`, `{time-zone}` and `{epoch}` in a `--host-command`, empty when the run did not set them. */
export const fillLaunch = (command: string, launch: RunLaunch | undefined): string =>
  command
    .replaceAll('{seed}', launch?.seed ?? '')
    .replaceAll('{locale}', launch?.locale ?? '')
    .replaceAll('{time-zone}', launch?.timeZone ?? '')
    .replaceAll('{epoch}', launch?.epoch ?? '');

/**
 * What the manifest records. With a host the run started (`--host`, `--host-command`) every fact is passed on; on an
 * app that was attached, only the seed, which the CLI applies to the values it draws itself. A simulator or emulator
 * keeps the Mac's time zone and clock and its own language, so the rest is listed as `unsupported`.
 */
export const recordLaunch = (launch: RunLaunch | undefined, startedHost: boolean): RunLaunch | undefined => {
  if (!launch || Object.keys(launch).length === 0) return undefined;
  if (startedHost) return launch;
  const unsupported = (['locale', 'timeZone', 'epoch'] as RunLaunchFact[]).filter((fact) => launch[fact] !== undefined);
  return unsupported.length ? { ...launch, unsupported } : launch;
};

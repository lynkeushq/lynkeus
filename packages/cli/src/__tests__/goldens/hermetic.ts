/**
 * A fresh machine for the goldens: an empty home and XDG folders, no Lynkeus or CI variables, UTC, a C locale and no
 * network. What the CLI reads from the machine it runs on (a FastSim install, a cloud key, the time zone) would make
 * a golden made on a Mac fail on CI's Linux runner, so every probe runs under this.
 *
 * Copied into a checkout of another ref by scripts/goldens-rn.mjs, so it imports nothing from the CLI.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DROPPED = /^(LYNKEUS_|EXPO_|GITHUB_|RUNNER_|XDG_)|^(CI|NO_COLOR|FORCE_COLOR|TZ|LANG|LANGUAGE)$|^LC_/;

let home: string | undefined;

/** Makes this process (and what it spawns) a fresh machine; idempotent. Returns the temporary home. */
export const hermetic = (): string => {
  if (home) return home;
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-goldens-home-')));
  for (const key of Object.keys(process.env)) if (DROPPED.test(key)) delete process.env[key];
  Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    LYNKEUS_FASTSIM_DIR: path.join(home, 'no-fastsim'),
    TZ: 'UTC',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
  });
  // A command that reaches for the network fails the same way on every machine instead of depending on it.
  globalThis.fetch = (async (input: unknown) => {
    throw new Error(`no network in the goldens (${input instanceof Request ? input.url : String(input)})`);
  }) as typeof fetch;
  const made = home;
  process.on('exit', () => fs.rmSync(made, { recursive: true, force: true }));
  return home;
};

import NativeLynkeus from './NativeLynkeus';
import { countHeldFrom } from './netmock';
import { host, qa } from './registry';

/**
 * What a host that runs the app's bundle itself (Lynkeus FastSim) is handed to add the commands only it can answer
 * (screenshots, film, its own clock) to the same registry the app's commands are in. The host defines
 * `globalThis.__lynkeusHostControls` before the app's code runs; the agent calls it once, when it starts.
 */
export type HostControls = {
  qa: typeof qa;
  host: typeof host;
  countHeldFrom: typeof countHeldFrom;
  /** React Native's `Lynkeus` native module as this process has it: a host answers methods of its own there (`advanceBy`). */
  native: unknown;
};

type Install = (controls: HostControls) => void;

let installed = false;

export const installHostControls = (): void => {
  const install = (globalThis as { __lynkeusHostControls?: unknown }).__lynkeusHostControls;
  if (installed || typeof install !== 'function') return;
  installed = true;
  try {
    (install as Install)({ qa, host, countHeldFrom, native: NativeLynkeus ?? null });
  } catch (error) {
    // The app and the driver still work without them: only what the host would have added is missing.
    console.warn(`lynkeus: the host's controls did not install: ${error instanceof Error ? error.message : String(error)}`);
  }
};

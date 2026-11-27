/**
 * The core's way to a runtime: `loadRuntime` is the only code outside runtimes/<id>/ that names a runtime's module, and
 * it loads it only when asked, so a run never loads another runtime than its own. Which runtime a folder is comes from
 * detect.ts, which needs no runtime loaded.
 */
import type { RuntimeAdapter } from './api.js';
import { type RuntimeId, runtimeOf } from './detect.js';

export type { BuildDevice, RuntimeAdapter } from './api.js';
export { RUNTIMES, type RuntimeId, runtimeOf } from './detect.js';

export const loadRuntime = async (id: RuntimeId): Promise<RuntimeAdapter> => {
  switch (id) {
    case 'react-native':
      return (await import('./react-native/index.js')).reactNative;
  }
};

/** The runtime of the app at `root`. */
export const runtimeAt = (root: string): Promise<RuntimeAdapter> => loadRuntime(runtimeOf(root));

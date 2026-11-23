/**
 * The core's way to a runtime: `loadRuntime` is the only code outside runtimes/<id>/ that names a runtime's module, and
 * it loads it only when asked, so a React Native run never loads another runtime. Which runtime a folder is comes from
 * detect.ts, which needs no runtime loaded.
 */
import type { RuntimeAdapter } from './api.js';
import { type RuntimeId, runtimeOf } from './detect.js';

export type { RuntimeAdapter } from './api.js';
export { chooseRuntime, RUNTIMES, type RuntimeId, runtimeFlag, runtimeOf } from './detect.js';

export const loadRuntime = async (id: RuntimeId): Promise<RuntimeAdapter> => {
  switch (id) {
    case 'react-native':
      return (await import('./react-native/index.js')).reactNative;
    case 'flutter':
      return (await import('./flutter/index.js')).flutter;
  }
};

/** The runtime of the app at `root`. */
export const runtimeAt = (root: string): Promise<RuntimeAdapter> => loadRuntime(runtimeOf(root));

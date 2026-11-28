import { DevSettings } from 'react-native';

import type { JsAge } from './protocol';

// When this module ran, which is when the bundle loaded: the agent is part of it, and a full reload runs it again.
const loadedAt = Date.now();
let refreshedAt: number | undefined;
let watched = false;

/**
 * Notes each Fast Refresh. React Native calls `DevSettings.onFastRefresh` once it has applied an edit; an edit it did
 * not apply (Fast Refresh off, Metro unreachable) leaves the app on older code, which only these times can tell.
 */
export const watchFastRefresh = (settings: unknown = DevSettings): void => {
  if (watched) return;
  watched = true;
  const target = settings as { onFastRefresh?: (...args: unknown[]) => unknown } | null | undefined;
  const original = target?.onFastRefresh;
  if (!target || typeof original !== 'function') return;
  try {
    target.onFastRefresh = (...args: unknown[]) => {
      refreshedAt = Date.now();
      return original.apply(target, args);
    };
  } catch {
    // A frozen DevSettings: the load time alone still tells a reload.
  }
};

export const jsAge = (now: number = Date.now()): JsAge => ({
  loadedMs: now - loadedAt,
  ...(refreshedAt !== undefined ? { refreshedMs: now - refreshedAt } : {}),
});

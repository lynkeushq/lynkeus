import { useEffect } from 'react';

import type { ClientOptions } from './client';
import { type NavigationAdapter, noNavigation } from './navigation';
import { host, qa } from './registry';

export type LynkeusProps = Omit<ClientOptions, 'navigation'> & {
  navigation?: NavigationAdapter;
  /**
   * Whether the agent runs at all. Default: in a dev build, and on a Lynkeus
   * FastSim host. Gate it further on your environment: a debug build talking
   * to production is not a QA surface.
   */
  enabled?: boolean;
};

/**
 * FastSim runs release bundles (`__DEV__` false), so its host marks itself with a global it sets before the app's
 * code runs; no device or store build has it.
 */
export const enabledByDefault = (): boolean => __DEV__ || typeof (globalThis as { __fastsimDevice?: unknown }).__fastsimDevice === 'object';

/**
 * Mount once, anywhere under your navigation container. Renders nothing.
 * The client is required lazily, so release bundles never evaluate it.
 */
export const Lynkeus = ({ enabled = enabledByDefault(), navigation, ...options }: LynkeusProps) => {
  useEffect(() => {
    qa.setNavigation(navigation);
    if (!enabled || host.claimed() || !host.start()) return;
    const { start } = require('./client') as typeof import('./client');
    const stop = start({ ...options, navigation: navigation ?? noNavigation });
    return () => {
      host.stop();
      stop();
    };
    // Options are read once; reconnecting on every render would drop the driver.
  }, [enabled, navigation]);

  return null;
};

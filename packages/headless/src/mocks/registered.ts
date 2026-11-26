import type { ComponentType } from 'react';

type Registry = { registerComponent: (key: string, provider: () => ComponentType, section?: boolean) => string };

/**
 * Runs the app's own entry as a device does (its polyfills, services, the agent's commands) and hands back the root
 * component it registers with `AppRegistry.registerComponent` or Expo's `registerRootComponent`, instead of mounting it.
 */
export const registeredApp = (load: () => unknown): ComponentType => {
  const { AppRegistry } = require('react-native') as { AppRegistry: Registry };
  const original = AppRegistry.registerComponent;
  let provider: (() => ComponentType) | undefined;
  // The last one wins, as when the app runs: Expo registers a placeholder ("App entry not found") before the app's own.
  AppRegistry.registerComponent = (key, componentProvider) => {
    provider = componentProvider;
    return key;
  };
  try {
    load();
  } finally {
    AppRegistry.registerComponent = original;
  }
  if (!provider)
    throw new Error(
      "the app's entry registered no component (AppRegistry.registerComponent or registerRootComponent); require the root component in the headless entry instead",
    );
  return provider();
};

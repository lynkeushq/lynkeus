/**
 * Which runtime a folder's app is built with, read from its files alone: no runtime's code is loaded to decide. The one
 * place outside a runtime's directory that knows what each runtime's project looks like.
 */
export const RUNTIMES = ['react-native'] as const;
export type RuntimeId = (typeof RUNTIMES)[number];

/**
 * Every folder is a React Native app (bare or Expo), as it always was: a second runtime adds here how its folder is
 * told apart, and a folder that is both stays React Native.
 */
export const runtimeOf = (_root: string): RuntimeId => 'react-native';

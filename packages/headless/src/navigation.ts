import { type NavigationAdapter, reactNavigationAdapter } from 'lynkeus-agent';

import type { Fiber } from './tree.js';

type ContainerRef = Parameters<typeof reactNavigationAdapter>[0];

const looksLikeContainer = (value: unknown): value is ContainerRef => {
  const v = value as Partial<ContainerRef> | null;
  return !!v && typeof v.getRootState === 'function' && typeof v.getCurrentRoute === 'function' && typeof v.addListener === 'function';
};

// React Navigation (and Expo Router over it) provides the container's ref as a context value below the root, so an
// app that never mentions it to Lynkeus is still found: the same search `auto()` does on a device.
export const findContainer = (root: Fiber | null, budget = 20000): ContainerRef | undefined => {
  const stack: Fiber[] = root ? [root] : [];
  while (stack.length && budget-- > 0) {
    const fiber = stack.pop()!;
    const value = fiber.memoizedProps?.value;
    if (looksLikeContainer(value)) return value;
    if (fiber.sibling) stack.push(fiber.sibling);
    if (fiber.child) stack.push(fiber.child);
  }
  return undefined;
};

/** An adapter over the container found under `root`, found again when a remount makes a new one. */
export const discoveredNavigation = (root: () => Fiber | null): (() => NavigationAdapter | undefined) => {
  let container: ContainerRef | undefined;
  let adapter: NavigationAdapter | undefined;
  return () => {
    const found = findContainer(root());
    if (!found) return undefined;
    if (found !== container) {
      container = found;
      adapter = reactNavigationAdapter(found);
    }
    return adapter;
  };
};

const isAdapter = (value: unknown): value is NavigationAdapter =>
  typeof value === 'object' && value !== null && typeof (value as NavigationAdapter).currentRoute === 'function';

/**
 * What an entry exports as `navigation`, as an adapter: a function that builds one (called on each use, since a
 * remount makes a new ref), an adapter, or a React Navigation container ref.
 */
export const entryNavigation = (exported: unknown): (() => NavigationAdapter | undefined) | undefined => {
  if (exported === undefined || exported === null) return undefined;
  const from = (value: unknown): NavigationAdapter | undefined =>
    isAdapter(value) ? value : looksLikeContainer(value) ? reactNavigationAdapter(value) : undefined;
  if (typeof exported === 'function') return () => from((exported as () => unknown)());
  const adapter = from(exported);
  if (!adapter) throw new Error('the entry exports `navigation` as neither an adapter, a function returning one, nor a navigation container ref');
  return () => adapter;
};

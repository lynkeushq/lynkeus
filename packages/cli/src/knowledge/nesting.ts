/**
 * Where a route sits among nested navigators. React Navigation reaches a screen of a navigator that is not mounted yet
 * only through its parent (`navigate('Demo', { screen: 'DemoPodcastList' })`), so `nav` finds the parents itself: from
 * the paths runs have seen on the device, else from the route graph (a navigator is the screen whose component file
 * declares the nested screens).
 */
import type { Observed } from './screens.js';
import type { ScreenGraph } from './types.js';

export type NestingSources = { graph?: ScreenGraph | null; observed?: Map<string, Observed> };

const fromGraph = (route: string, graph: ScreenGraph): string[] | undefined => {
  if (!graph.screens[route]) return undefined;
  const chain = [route];
  for (let current = graph.screens[route]; current; ) {
    const declaredIn = current.declaredIn;
    const parents = Object.values(graph.screens).filter((s) => s.file === declaredIn);
    if (parents.length === 0) return chain;
    // The same navigator bound under two routes: which one the screen is meant under cannot be told.
    if (parents.length > 1 || chain.includes(parents[0]!.route)) return undefined;
    chain.unshift(parents[0]!.route);
    current = parents[0]!;
  }
  return chain;
};

/** The route names from the root navigator down to `route`, itself included; undefined when nothing says. */
export const routeChain = (route: string, sources: NestingSources): string[] | undefined => {
  const seen = sources.observed?.get(route)?.path;
  if (seen && seen.length > 0 && seen[seen.length - 1] === route) return seen;
  return sources.graph ? fromGraph(route, sources.graph) : undefined;
};

/** `navigate(name, params)` that reaches the last route of `chain` from anywhere: through each parent, outermost first. */
export const nestedNavigate = (chain: string[], params?: object): { name: string; params?: object } => {
  let inner: object | undefined = params;
  for (let i = chain.length - 1; i > 0; i--) inner = { screen: chain[i]!, ...(inner ? { params: inner } : {}) };
  return { name: chain[0]!, ...(inner ? { params: inner } : {}) };
};

/** The screen a navigation lands on: the innermost `params.screen`, else the route itself. */
export const leafOf = (route: string, params: unknown): string => {
  let leaf = route;
  let at = params as { screen?: unknown; params?: unknown } | undefined;
  while (at && typeof at === 'object' && typeof at.screen === 'string') {
    leaf = at.screen;
    at = at.params as typeof at;
  }
  return leaf;
};

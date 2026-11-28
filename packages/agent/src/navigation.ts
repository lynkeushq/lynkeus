export type RouteInfo = { name: string; params?: unknown };

/** How the agent reads and drives the app's router; one ships for React Navigation. */
export type NavigationAdapter = {
  isReady(): boolean;
  currentRoute(): RouteInfo | undefined;
  /** Route names from the root navigator down to the focused screen. */
  path(): string[];
  navigate(name: string, params?: object): void;
  /** Whether a mounted navigator declares a screen of this name; undefined when the router cannot say. */
  declares?(name: string): boolean | undefined;
  canGoBack(): boolean;
  goBack(): void;
  /** Closes the innermost open drawer of a drawer navigator; false when none is open. `back` tries it first. */
  closeDrawer?(): boolean;
  /** Back to the initial route; called on `reset`, so a host that does not relaunch the app starts each flow clean. */
  resetToRoot?(): void;
  /** Replace the whole stack with one route, as an app does after login. */
  resetTo?(name: string, params?: object): void;
  /** Called whenever the focused route may have changed; returns an unsubscribe. */
  subscribe(listener: () => void): () => void;
};

type NavState = {
  index: number;
  routes: { name: string; state?: unknown }[];
  routeNames?: string[];
  key?: string;
  type?: string;
  /** A drawer navigator keeps `{ type: 'drawer', status: 'open' }` here while its drawer is open (`status` since v6). */
  history?: { type?: string; status?: string }[];
};

/** The key of the innermost drawer navigator on the focused path whose drawer is open. */
export const openDrawerKey = (state: NavState | undefined): string | undefined => {
  let open: string | undefined;
  for (let current = state; current; current = current.routes[current.index]?.state as NavState | undefined) {
    const drawer = current.type === 'drawer' && current.history?.some((h) => h.type === 'drawer' && h.status !== 'closed');
    if (drawer && current.key) open = current.key;
  }
  return open;
};

export type ContainerRef = {
  isReady(): boolean;
  getCurrentRoute(): { name: string; params?: unknown } | undefined;
  getRootState(): NavState | undefined;
  navigate: (...args: never[]) => void;
  canGoBack(): boolean;
  goBack(): void;
  dispatch?: (action: never) => void;
  // `never` here, not `unknown`: parameters are contravariant, and the real
  // ref types its argument, so `unknown` would reject every actual ref.
  resetRoot?: (state?: never) => void;
  addListener(type: 'state', listener: () => void): unknown;
  removeListener(type: 'state', listener: () => void): void;
};

const routePath = (state: NavState | undefined): string[] => {
  const path: string[] = [];
  let current = state;
  while (current) {
    const route = current.routes[current.index];
    if (!route) break;
    path.push(route.name);
    current = route.state as NavState | undefined;
  }
  return path;
};

/**
 * The screens every mounted navigator declares, focused or not; undefined when a navigator's state does not list them
 * (a partial state, a router of its own), since then nothing can be said about a name.
 */
export const mountedRouteNames = (state: NavState | undefined): Set<string> | undefined => {
  if (!state) return undefined;
  const names = new Set<string>();
  const stack = [state];
  while (stack.length) {
    const current = stack.pop()!;
    if (!Array.isArray(current.routeNames)) return undefined;
    for (const name of current.routeNames) names.add(name);
    for (const route of current.routes) if (route.state) stack.push(route.state as NavState);
  }
  return names;
};

// React Navigation drops a navigate to a screen no mounted navigator declares (a dev warning, nothing else), which
// would leave the caller waiting for a screen that never comes.
const unreachable = (name: string, state: NavState | undefined): string =>
  `No mounted navigator has a screen named ${name} (the root's: ${(state?.routeNames ?? []).join(', ')}). A screen in a navigator that is not open yet is reached through its parent: navigate to the parent route with { screen: '${name}' } in its params. Lynkeus's nav finds the parent itself once a run has seen the screen or the route graph is built (lynkeus map build).`;

/** Adapter for a `NavigationContainer` ref from `@react-navigation/native`. */
export const reactNavigationAdapter = (ref: ContainerRef): NavigationAdapter => {
  // An app resets its own stack (after login, say), so routes[0] stops being the
  // initial route; remember it the first time the container is ready.
  let initialRoute: string | undefined;
  const rememberInitial = () => {
    if (initialRoute === undefined && ref.isReady()) initialRoute = ref.getRootState()?.routes?.[0]?.name;
  };
  return {
    isReady: () => {
      rememberInitial();
      return ref.isReady();
    },
    currentRoute: () => (ref.isReady() ? ref.getCurrentRoute() : undefined),
    path: () => (ref.isReady() ? routePath(ref.getRootState()) : []),
    declares: (name) => (ref.isReady() ? mountedRouteNames(ref.getRootState())?.has(name) : undefined),
    navigate: (name, params) => {
      const state = ref.isReady() ? ref.getRootState() : undefined;
      if (mountedRouteNames(state)?.has(name) === false) throw new Error(unreachable(name, state));
      (ref as unknown as { navigate: (n: string, p?: object) => void }).navigate(name, params);
    },
    canGoBack: () => ref.isReady() && ref.canGoBack(),
    goBack: () => ref.goBack(),
    closeDrawer: () => {
      const key = ref.isReady() ? openDrawerKey(ref.getRootState()) : undefined;
      if (!key || !ref.dispatch) return false;
      (ref.dispatch as unknown as (action: { type: string; target: string }) => void)({ type: 'CLOSE_DRAWER', target: key });
      return true;
    },
    resetToRoot: () => {
      if (!ref.isReady() || !ref.resetRoot) return;
      rememberInitial();
      // Nested navigators re-initialize to their initial screens. resetRoot() without a state throws.
      // A root that swaps its screens on a state change (signed in, signed out) declares other ones than it began with:
      // a RESET to one it does not declare now is handled by no navigator (trial run 11: Login, while signed in).
      const root = ref.getRootState();
      const declared = root?.routeNames;
      const first = initialRoute && (!declared || declared.includes(initialRoute)) ? initialRoute : (declared?.[0] ?? root?.routes?.[0]?.name);
      if (first) (ref.resetRoot as unknown as (state: { index: number; routes: { name: string }[] }) => void)({ index: 0, routes: [{ name: first }] });
    },
    resetTo: (name, params) => {
      if (!ref.isReady() || !ref.resetRoot) return;
      (ref.resetRoot as unknown as (state: { index: number; routes: { name: string; params?: object }[] }) => void)({ index: 0, routes: [{ name, params }] });
    },
    subscribe: (listener) => {
      rememberInitial();
      const onState = () => {
        rememberInitial();
        listener();
      };
      ref.addListener('state', onState);
      return () => ref.removeListener('state', onState);
    },
  };
};

/** For apps without a router: the agent still reads and drives the screen. */
export const noNavigation: NavigationAdapter = {
  isReady: () => true,
  currentRoute: () => undefined,
  path: () => [],
  navigate: () => {
    throw new Error('No navigation adapter configured');
  },
  canGoBack: () => false,
  goBack: () => {
    throw new Error('No navigation adapter configured');
  },
  subscribe: () => () => {},
};

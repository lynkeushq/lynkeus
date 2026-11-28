import { describe, expect, it, jest } from '@jest/globals';

import type { Backend } from '../backend';
import { createHandlers, dispatch } from '../handlers';
import { type ContainerRef, mountedRouteNames, noNavigation, reactNavigationAdapter } from '../navigation';

const backend: Backend = {
  name: 'fake',
  native: false,
  snapshot: () => ({ elements: [] }),
  commitCount: () => 0,
  window: () => ({ w: 390, h: 844 }),
  press: async () => undefined,
  pressPoint: async () => undefined,
  pressJs: async () => undefined,
  typeText: async () => undefined,
  deleteBackward: async () => undefined,
  dismissKeyboard: async () => undefined,
  submit: async () => undefined,
  swipe: async () => undefined,
  swipeOn: async () => undefined,
  debug: () => null,
};

// Ignite's shape: a root stack whose Demo route is a tab navigator, mounted only once Demo is open.
const onWelcome = { index: 0, routeNames: ['Welcome', 'Demo'], routes: [{ name: 'Welcome' }] };
const inDemo = {
  index: 1,
  routeNames: ['Welcome', 'Demo'],
  routes: [
    { name: 'Welcome' },
    {
      name: 'Demo',
      state: {
        index: 2,
        routeNames: ['DemoShowroom', 'DemoCommunity', 'DemoPodcastList'],
        routes: [{ name: 'DemoShowroom' }, { name: 'DemoCommunity' }, { name: 'DemoPodcastList' }],
      },
    },
  ],
};

const container = (state: object) => {
  const navigate = jest.fn();
  const ref = {
    isReady: () => true,
    getCurrentRoute: () => undefined,
    getRootState: () => state,
    navigate,
    canGoBack: () => false,
    goBack: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
  } as unknown as ContainerRef;
  return { adapter: reactNavigationAdapter(ref), navigate };
};

describe('navigating to a nested screen', () => {
  it('lists the screens of every mounted navigator', () => {
    expect([...(mountedRouteNames(inDemo as never) ?? [])].sort()).toEqual(['Demo', 'DemoCommunity', 'DemoPodcastList', 'DemoShowroom', 'Welcome']);
    expect(mountedRouteNames({ index: 0, routes: [{ name: 'A' }] } as never)).toBeUndefined();
  });

  it('says how to reach a screen of a navigator that is not mounted, instead of dropping the navigate', () => {
    const { adapter, navigate } = container(onWelcome);
    expect(() => adapter.navigate('DemoPodcastList')).toThrow(/No mounted navigator has a screen named DemoPodcastList.*\{ screen: 'DemoPodcastList' \}/);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('navigates to a parent route with its nested screen, and to a screen of a mounted navigator', () => {
    const { adapter, navigate } = container(onWelcome);
    adapter.navigate('Demo', { screen: 'DemoPodcastList' });
    expect(navigate).toHaveBeenCalledWith('Demo', { screen: 'DemoPodcastList' });
    const mounted = container(inDemo);
    mounted.adapter.navigate('DemoCommunity');
    expect(mounted.navigate).toHaveBeenCalledWith('DemoCommunity', undefined);
  });

  it('leaves a state that does not list its screens to the router', () => {
    const { adapter, navigate } = container({ index: 0, routes: [{ name: 'index' }] });
    adapter.navigate('(tabs)');
    expect(navigate).toHaveBeenCalledWith('(tabs)', undefined);
  });
});

describe('waiting for a navigator route', () => {
  const nested = { ...noNavigation, currentRoute: () => ({ name: 'DemoPodcastList' }), path: () => ['Demo', 'DemoPodcastList'] };

  it('counts a navigator as reached once the focused screen is inside it', async () => {
    const handlers = createHandlers(nested, backend);
    await expect(dispatch(handlers, 'waitFor', { route: 'Demo', timeoutMs: 100 })).resolves.toMatchObject({ route: 'DemoPodcastList' });
    await expect(dispatch(handlers, 'waitFor', { route: 'DemoPodcastList', timeoutMs: 100 })).resolves.toMatchObject({ route: 'DemoPodcastList' });
  });

  it('names the navigators of the focused screen when it times out', async () => {
    const handlers = createHandlers(nested, backend);
    await expect(dispatch(handlers, 'waitFor', { route: 'Welcome', timeoutMs: 50 })).rejects.toThrow('(on Demo > DemoPodcastList)');
  });
});

describe('navigating while a conditional navigator swaps its screens', () => {
  // Ignite's root stack lists Login until the sign-in renders, then Welcome and Demo.
  const signedOut = { index: 0, routeNames: ['Login'], routes: [{ name: 'Login' }] };

  it('waits for the navigator that lists the screen, then navigates', async () => {
    const live: { state: object } = { state: signedOut };
    const { adapter, navigate } = container(new Proxy(live, { get: (_, key) => Reflect.get(live.state, key) }));
    const handlers = createHandlers(adapter, backend);
    setTimeout(() => {
      live.state = onWelcome;
    }, 120);
    await dispatch(handlers, 'navigate', { name: 'Welcome' });
    expect(navigate).toHaveBeenCalledWith('Welcome', undefined);
  });

  it('fails, rather than dropping the navigate, when no navigator comes to list it', async () => {
    const { adapter, navigate } = container(signedOut);
    const handlers = createHandlers(adapter, backend);
    const started = Date.now();
    await expect(dispatch(handlers, 'navigate', { name: 'Welcome' })).rejects.toThrow(/No mounted navigator has a screen named Welcome \(the root's: Login\)/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1400);
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('the open drawer back closes', () => {
  it('is the innermost drawer navigator on the focused path whose history says it is open', async () => {
    const { openDrawerKey } = await import('../navigation');
    const state = {
      index: 0,
      key: 'root',
      routes: [
        {
          name: 'Demo',
          state: {
            index: 0,
            key: 'drawer-1',
            type: 'drawer',
            history: [{ type: 'route' }, { type: 'drawer', status: 'open' }],
            routes: [{ name: 'Showroom' }],
          },
        },
      ],
    };
    expect(openDrawerKey(state)).toBe('drawer-1');
    expect(
      openDrawerKey({ ...state, routes: [{ name: 'Demo', state: { ...state.routes[0]!.state, history: [{ type: 'drawer', status: 'closed' }] } }] }),
    ).toBeUndefined();
    expect(openDrawerKey({ index: 0, routes: [{ name: 'Welcome' }] })).toBeUndefined();
  });
});

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

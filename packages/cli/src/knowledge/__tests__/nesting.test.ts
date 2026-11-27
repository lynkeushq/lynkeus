import assert from 'node:assert/strict';
import { test } from 'node:test';

import { leafOf, navigatorRoutes, nestedNavigate, routeChain } from '../nesting.js';
import type { Observed } from '../screens.js';
import type { ScreenGraph } from '../types.js';

const screen = (route: string, file: string | null, declaredIn: string) => ({ route, component: route, file, declaredIn });

// Ignite's shape: the root stack declares Welcome and Demo; Demo's component declares the tabs.
const graph: ScreenGraph = {
  app: 'shop',
  root: '/app',
  extractedAt: '2026-11-27T00:00:00Z',
  screens: {
    Welcome: screen('Welcome', 'app/screens/WelcomeScreen.tsx', 'app/navigators/AppNavigator.tsx'),
    Demo: screen('Demo', 'app/navigators/DemoNavigator.tsx', 'app/navigators/AppNavigator.tsx'),
    DemoPodcastList: screen('DemoPodcastList', 'app/screens/DemoPodcastListScreen.tsx', 'app/navigators/DemoNavigator.tsx'),
  },
  files: {},
  warnings: [],
};

test('a nested screen is reached through the navigators the graph puts it in', () => {
  assert.deepEqual(routeChain('DemoPodcastList', { graph }), ['Demo', 'DemoPodcastList']);
  assert.deepEqual(routeChain('Welcome', { graph }), ['Welcome']);
  assert.equal(routeChain('Unknown', { graph }), undefined);
  assert.equal(routeChain('DemoPodcastList', {}), undefined);
});

test('the path a run saw on the device wins over the graph', () => {
  const observed = new Map<string, Observed>([
    ['DemoPodcastList', { route: 'DemoPodcastList', path: ['Main', 'Demo', 'DemoPodcastList'], seen: 1, date: '', testIds: [] }],
  ]);
  assert.deepEqual(routeChain('DemoPodcastList', { graph, observed }), ['Main', 'Demo', 'DemoPodcastList']);
});

test('a navigator bound under two routes leaves the parent unknown', () => {
  const twice: ScreenGraph = {
    ...graph,
    screens: { ...graph.screens, Other: screen('Other', 'app/navigators/DemoNavigator.tsx', 'app/navigators/AppNavigator.tsx') },
  };
  assert.equal(routeChain('DemoPodcastList', { graph: twice }), undefined);
});

test('navigating through parents nests each screen in the one above it', () => {
  assert.deepEqual(nestedNavigate(['Demo', 'DemoPodcastList']), { name: 'Demo', params: { screen: 'DemoPodcastList' } });
  assert.deepEqual(nestedNavigate(['Main', 'Demo', 'Episode'], { id: 3 }), {
    name: 'Main',
    params: { screen: 'Demo', params: { screen: 'Episode', params: { id: 3 } } },
  });
  assert.deepEqual(nestedNavigate(['Welcome'], { a: 1 }), { name: 'Welcome', params: { a: 1 } });
});

test('the screen a navigation lands on is the innermost params.screen', () => {
  assert.equal(leafOf('Demo', { screen: 'DemoPodcastList' }), 'DemoPodcastList');
  assert.equal(leafOf('Main', { screen: 'Demo', params: { screen: 'Episode', params: { id: 1 } } }), 'Episode');
  assert.equal(leafOf('Welcome', undefined), 'Welcome');
});

test('a route whose component declares other routes is a navigator', () => {
  assert.deepEqual(navigatorRoutes(graph), ['Demo']);
});

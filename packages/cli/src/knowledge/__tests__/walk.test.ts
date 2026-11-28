import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { EdgeObservation } from '../edges.js';
import { viaOf, walk } from '../walk.js';

const learner = () => {
  const edges: EdgeObservation[] = [];
  return { edges, w: walk((e) => edges.push(e)) };
};

const screen = (route: string, presenting?: { testId?: string; modal?: boolean }) => ({
  route,
  ...(presenting ? { presenting: { i: 9, modal: !!presenting.modal, ...(presenting.testId ? { testId: presenting.testId } : {}) } } : {}),
});

test('a press between two screen reads on different routes is one edge', () => {
  const { edges, w } = learner();
  w.saw(screen('Home'));
  w.pressing();
  w.pressed('open-settings');
  w.saw(screen('Settings'));
  assert.deepEqual(edges, [{ from: 'Home', to: 'Settings', via: 'open-settings' }]);
});

test('the route the app announces lands a press without a screen read; the next press settles it', () => {
  const { edges, w } = learner();
  w.saw(screen('Home'));
  w.pressing();
  w.routed('Settings');
  w.pressed('text:Settings');
  w.pressing();
  w.pressed('back');
  assert.deepEqual(edges, [{ from: 'Home', to: 'Settings', via: 'text:Settings' }]);
});

test('a layer raised by a press is named after the control, and a press inside it starts from it', () => {
  const { edges, w } = learner();
  w.saw(screen('Home'));
  w.pressing();
  w.pressed('menu');
  w.saw(screen('Home', { testId: 'menu-sheet' }));
  w.saw(screen('Home', { testId: 'menu-sheet' }));
  w.pressing();
  w.pressed('profile');
  w.routed('Profile');
  w.settle();
  assert.deepEqual(edges, [
    { from: 'Home', to: 'Home', via: 'menu', toLayer: 'menu' },
    { from: 'Home', to: 'Profile', via: 'profile', fromLayer: 'menu' },
  ]);
});

test('nothing is recorded when either end is not known for sure', () => {
  const { edges, w } = learner();
  // Never read before the press: where it was pressed from is unknown.
  w.pressing();
  w.pressed('a');
  w.saw(screen('B'));
  // A press that may have raised a layer, followed by another press with no read between: unknown where it led.
  w.pressing();
  w.pressed('c');
  w.pressing();
  w.pressed('d');
  // A jump before anything was read after the press.
  w.saw(screen('B'));
  w.pressing();
  w.pressed('e');
  w.acted(true);
  w.routed('Z');
  w.saw(screen('Z'));
  // A press that failed.
  w.pressing();
  w.pressed(undefined);
  w.saw(screen('Y'));
  assert.deepEqual(edges, []);
});

test('a press that changed nothing is no edge; forget drops what a crawl made untrue', () => {
  const { edges, w } = learner();
  w.saw(screen('Home'));
  w.pressing();
  w.pressed('noop');
  w.saw(screen('Home'));
  w.pressing();
  w.pressed('go');
  w.forget();
  w.saw(screen('Elsewhere'));
  assert.deepEqual(edges, []);
});

test('a control is named the way crawl names it', () => {
  assert.equal(viaOf({ testId: 'x', text: 'X' }), 'x');
  assert.equal(viaOf({ text: 'A label that is a good deal longer than forty characters' }), 'text:A label that is a good deal longer than ');
  assert.equal(viaOf({}), undefined);
  assert.equal(viaOf(undefined), undefined);
});

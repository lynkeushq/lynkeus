/**
 * Where a press led, learned from what a connection reads anyway: the screens commands read, the route a wait
 * answers with and the route the app announces when it changes. It asks the app nothing, so a case run or a
 * press by hand sends what it sent before and the route map still grows from it.
 *
 * A press is placed only when both ends are known for sure. Before it, the place must have been read since the
 * last press; after it, a screen read or a route the app announced must come before the next thing that could move
 * the app (another press, a swipe, a jump). Anything less is dropped: an edge missed costs a crawl, an edge invented
 * sends `map plan` the wrong way.
 */
import type { Screen } from 'lynkeus-protocol';

import type { EdgeObservation } from './edges.js';

type Place = { route?: string; layer?: string };

export type Walk = {
  /** A screen a command read. */
  saw: (screen: Pick<Screen, 'route' | 'presenting'>) => void;
  /** A route the app announced, or a wait answered with: no word on layers. */
  routed: (route: string | undefined) => void;
  /** Right before a press is sent: what it is pressed from. */
  pressing: () => void;
  /** The press landed on this control (a testID, or `text:<label>`); undefined when it failed or names nothing. */
  pressed: (via: string | undefined) => void;
  /** Something other than a press that may move the app; `layers`: it may also raise or close a layer. */
  acted: (layers: boolean) => void;
  /** Places the press still waiting, if what follows it is known. */
  settle: () => void;
  /** What happened while nobody watched (a crawl drives the app itself): nothing known is still true. */
  forget: () => void;
};

/** A layer has no route: it is named after the control that raised it, as a crawl names it, so both feed one map. */
const layerOf = (s: Pick<Screen, 'presenting'>) => s.presenting?.testId ?? (s.presenting?.modal ? 'modal' : 'overlay');

/** The control a press result names, the way crawl names it in edges.jsonl. */
export const viaOf = (element: { testId?: string; text?: string } | undefined | null): string | undefined => {
  if (element?.testId) return element.testId;
  return element?.text ? `text:${element.text.slice(0, 40)}` : undefined;
};

export const walk = (record: (edge: EdgeObservation) => void): Walk => {
  let here: Place | undefined;
  // Whether `here` still holds: a press may raise or close a layer that only a screen read shows.
  let sure = false;
  let from: Place | undefined;
  let waiting: { from: Place; via: string } | undefined;

  const land = () => {
    const press = waiting;
    waiting = undefined;
    if (!press || !sure || !here?.route || !press.from.route) return;
    if (here.route === press.from.route && here.layer === press.from.layer) return;
    record({
      from: press.from.route,
      to: here.route,
      via: press.via,
      ...(press.from.layer ? { fromLayer: press.from.layer } : {}),
      ...(here.layer ? { toLayer: here.layer } : {}),
    });
  };

  return {
    saw: (screen) => {
      // A press made inside a layer stays in it; one that raised a layer names it; otherwise a layer keeps its name.
      const layer = !screen.presenting
        ? undefined
        : waiting
          ? (waiting.from.layer ?? waiting.via)
          : here?.layer && here.route === screen.route
            ? here.layer
            : layerOf(screen);
      here = { route: screen.route, layer };
      sure = true;
      land();
    },
    routed: (route) => {
      if (route === undefined || route === here?.route) return;
      here = { route };
      sure = true;
    },
    pressing: () => {
      land();
      from = sure && here?.route ? { ...here } : undefined;
      sure = false;
    },
    pressed: (via) => {
      if (from && via) waiting = { from, via };
      from = undefined;
    },
    acted: (layers) => {
      land();
      if (layers) sure = false;
    },
    settle: land,
    forget: () => {
      here = undefined;
      sure = false;
      from = undefined;
      waiting = undefined;
    },
  };
};

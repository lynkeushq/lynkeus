import { Linking } from 'react-native';

import { type Backend, centre } from './backend';
import type { NavigationAdapter } from './navigation';
import { openedSince } from './opened';
import type { CoreMethods, Element, PressOptions, Scope, Screen, Target } from './protocol';
import { devLoadingShowing } from './devLoading';
import { jsAge } from './jsAge';
import { host } from './registry';
import { recentRequests, requestsHeld, requestsInFlight } from './requests';
import { lastSeq, traceSince } from './trace';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
// 30 looks 40 ms apart: 1.2 s on a real clock, inside settle's 3 s deadline.
const MIN_SETTLE_LOOKS = 30;
// Longer than a conditional navigator takes to render its other branch, short enough that a wrong name fails fast.
const NAVIGATOR_SWAP_MS = 1500;

// How well an element answers a target: 0 = no, higher = better. Exact text
// on a control beats the same text in a paragraph, and a substring of a
// paragraph is no target at all: its centre lands on whatever word sits there.
// Case is ignored: a text drawn with `textTransform` reads as drawn, and the
// source's own casing still finds it. A field also answers to its placeholder.
export const score = (element: Element, target: Target): number => {
  if ('testId' in target) return element.testId === target.testId ? 4 : 0;
  if ('i' in target) return element.i === target.i ? 4 : 0;
  if (!('text' in target)) return 0;
  const needle = target.text.toLowerCase().trim();
  const haystacks = [element.text, element.accessibilityLabel, element.kind === 'input' ? element.placeholder : undefined]
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.toLowerCase().trim());
  const control = element.kind === 'button' || element.kind === 'input';
  if (haystacks.some((h) => h === needle)) return control ? 4 : 3;
  // Part of a control's label: as whole words ("Favorite" in "Add to Favorite") before inside a word ("Favorites").
  if (control && haystacks.some((h) => hasWords(h, needle))) return 2;
  if (control && haystacks.some((h) => h.includes(needle))) return 1;
  return 0;
};

// A letter in any script, or a digit: what a word is made of.
const wordy = (c: string | undefined) => !!c && (c.toLowerCase() !== c.toUpperCase() || (c >= '0' && c <= '9'));

const hasWords = (haystack: string, needle: string): boolean => {
  if (!needle) return false;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1))
    if (!(wordy(needle[0]) && wordy(haystack[at - 1])) && !(wordy(needle[needle.length - 1]) && wordy(haystack[at + needle.length]))) return true;
  return false;
};

// Hidden belongs to another screen or to no one. An inert label inside a
// pressable is still readable, so it matches; it just cannot act.
const matchable = (e: Element) => !e.hidden || e.hidden === 'inert';

const insideOf = (elements: Element[], e: Element, ancestor: number): boolean => {
  for (let p = e.parent; p !== undefined; p = elements[p]?.parent) if (p === ancestor) return true;
  return false;
};

// Of several rows with a "like" button, the one that goes with a text shares
// the smallest container with it, and within that container is nearest to it.
const pickWithin = (elements: Element[], { within, ...target }: Target & { within: Scope }): Element | undefined => {
  const scope = pick(elements, within);
  if (!scope) return undefined;
  const matches = elements.filter((e) => matchable(e) && score(e, target as Target) > 0);
  const nth = 'nth' in target ? target.nth : undefined;
  let container: Element | undefined = scope;
  while (true) {
    const level: Element | undefined = container;
    const here = level ? matches.filter((e) => e.i === level.i || insideOf(elements, e, level.i)) : matches;
    if (here.length > 0) {
      if (nth !== undefined) return here[nth];
      // A card made accessible reads its children's words run together, so it contains the text of every button in
      // it: an exact label beats one that only contains the text, and of matches nested in one another the innermost wins.
      const top = Math.max(...here.map((e) => score(e, target as Target)));
      const strongest = here.filter((e) => score(e, target as Target) === top);
      const innermost = strongest.filter((e) => !strongest.some((other) => other !== e && insideOf(elements, other, e.i)));
      return innermost.reduce((best, e) => {
        const d = Math.abs(e.i - scope.i);
        const b = Math.abs(best.i - scope.i);
        return d < b || (d === b && e.i > best.i) ? e : best;
      });
    }
    if (!level) return undefined;
    container = level.parent === undefined ? undefined : elements[level.parent];
  }
};

/**
 * Best match for a target. Reachable elements win; a covered one is returned
 * only when nothing reachable matches: an input under the pressable box that
 * focuses it is still on screen, and a tap at its centre reaches the box, as a
 * finger would. Ties go to the later element, which draws on top.
 */
export const pick = (elements: Element[], target: Target): Element | undefined => {
  if ('x' in target) return undefined;
  if ('within' in target && target.within) return pickWithin(elements, target as Target & { within: Scope });
  if ('nth' in target && target.nth !== undefined) return elements.filter((e) => matchable(e) && score(e, target) > 0)[target.nth];
  let best: Element | undefined;
  let bestRank = 0;
  for (const element of elements) {
    if (!matchable(element)) continue;
    const s = score(element, target);
    if (s === 0) continue;
    const rank = s + (element.covered ? 0 : 10) + (element.hidden === 'inert' ? 0 : 20);
    if (rank >= bestRank) {
      best = element;
      bestRank = rank;
    }
  }
  return best;
};

const describeTarget = (target: Target): string => JSON.stringify(target);

/**
 * A target that was there while a press waited for it to hold still, and then was not: the list it is in kept
 * coasting after a scroll, or a view animated away. Said as such, so a wait that found it and a press that did not
 * do not read as two different ways of matching.
 */
class LeftScreen extends Error {}

type Point = { x: number; y: number; element?: Element };

// Within a point is the same place: a breathing CTA is not a transition.
const sameFrame = (a: Element, b: Element) =>
  Math.abs(a.frame.x - b.frame.x) < 1 && Math.abs(a.frame.y - b.frame.y) < 1 && Math.abs(a.frame.w - b.frame.w) < 1 && Math.abs(a.frame.h - b.frame.h) < 1;

export type Handlers = {
  [M in keyof CoreMethods]: (params: CoreMethods[M]['params']) => CoreMethods[M]['result'] | Promise<CoreMethods[M]['result']>;
} & {
  debug: (params?: unknown) => unknown;
};

export const createHandlers = (navigation: NavigationAdapter, backend: Backend): Handlers => {
  const elements = () => backend.snapshot().elements;

  const busy = async (): Promise<boolean> => {
    if (requestsInFlight() > 0) return true;
    const custom = host.get('busy');
    if (!custom) return false;
    try {
      return (await custom(undefined)) === true;
    } catch {
      return false;
    }
  };

  const screen = async (): Promise<Screen> => {
    const started = Date.now();
    const { elements, presenting, system } = backend.snapshot();
    const route = navigation.currentRoute();
    return {
      route: route?.name,
      params: route?.params,
      path: navigation.path(),
      elements,
      commit: backend.commitCount(),
      busy: await busy(),
      window: backend.window(),
      presenting,
      ...(system ? { system } : {}),
      costMs: Date.now() - started,
    };
  };

  const find = (target: Target): Element | null => pick(elements(), target) ?? null;

  const presented = (target: Target): Element => {
    const element = find(target);
    if (!element) {
      // The same matching as find and waitFor: what they skip as not presented is named, not reported as absent.
      const unseen = 'x' in target ? undefined : elements().find((e) => e.hidden && score(e, target) > 0)?.hidden;
      throw new Error(`No element matches ${describeTarget(target)}${unseen ? `: one is in the tree but not presented (${unseen})` : ''}`);
    }
    if (element.hidden) throw new Error(`${describeTarget(target)} is not presented (${element.hidden})`);
    return element;
  };

  const pointOf = (target: Target): Point => {
    if ('x' in target) return { x: target.x, y: target.y };
    const element = presented(target);
    return { ...centre(element), element };
  };

  const inWindow = (e: Element) => {
    const { w, h } = backend.window();
    const { x, y } = centre(e);
    return !e.offscreen && x >= 0 && y >= 0 && x <= w && y <= h;
  };

  // A host that is not a device moves a view per frame, which it runs on a timer of its own (the headless host's
  // requestAnimationFrame): two looks one frame apart see the move, and a landed target costs a frame, not 40 ms.
  const stillLookMs = backend.native ? 40 : 16;

  // An element still sliding in would be tapped where it was. Two identical
  // measurements 40 ms apart mean it has landed. An Android fling coasts for
  // seconds, and a finger that lands on it stops the scroll where it is: wait
  // it out, or the screen depends on when the tap came.
  const settled = async (target: Target, timeoutMs = 3000): Promise<Point> => {
    const deadline = Date.now() + timeoutMs;
    // On a host with a virtual clock (fastsim) Date.now jumps ahead while JavaScript sleeps, so the deadline can pass in a
    // few real milliseconds, before the native side has moved at all. The wait therefore also lasts a number of looks,
    // which costs nothing where the clock is real (they fit well inside the deadline).
    let looks = 0;
    const waiting = () => Date.now() < deadline || looks < MIN_SETTLE_LOOKS;
    // A control still becoming interactive (a pager's last page arriving, a sheet sliding in) reads as inert for a
    // moment, and may flicker while it lands, more so on a loaded machine: wait it out within the same deadline
    // before calling it not presented.
    const inert = () => !('x' in target) && find(target)?.hidden === 'inert';
    let seenAt: number | undefined;
    // On a native host the element list is read from the view tree while it changes, so two reads in a row can
    // disagree: an inert read right after a presented one is the same flicker, not an answer.
    const look = (): Point | undefined => {
      try {
        const point = pointOf(target);
        if (point.element) seenAt = Date.now();
        return point;
      } catch (error) {
        if (waiting() && error instanceof Error && error.message.endsWith('is not presented (inert)')) return undefined;
        if (seenAt !== undefined && error instanceof Error && error.message.startsWith('No element matches'))
          throw new LeftScreen(
            `${error.message}: it was on screen ${Date.now() - seenAt} ms before, and left while the press waited for it to hold still (a list still coasting after a scroll, a view animating away)`,
          );
        throw error;
      }
    };
    while (inert() && waiting()) {
      looks++;
      await sleep(stillLookMs);
    }
    let previous = look();
    while (waiting()) {
      looks++;
      await sleep(stillLookMs);
      if (inert()) continue;
      const current = look();
      if (!current) continue;
      if (!current.element || (previous?.element && current.element && sameFrame(current.element, previous.element))) return current;
      previous = current;
    }
    return previous ?? pointOf(target);
  };

  // A finger would land on what another window shows there (a system alert, a prompt), and the app would never
  // hear it: said, rather than a tap that answers as if it had worked.
  const underSystemView = (target: Target, element: Element) => {
    if (!element.covered || element.system) return;
    const { system, elements: now } = backend.snapshot();
    if (!system) return;
    const { x, y } = centre(element);
    const { frame } = system;
    if (x < frame.x || y < frame.y || x > frame.x + frame.w || y > frame.y + frame.h) return;
    const words = now.filter((e) => e.system && e.kind === 'button').map((e) => JSON.stringify(e.text));
    throw new Error(
      `${describeTarget(target)} is under a view the app did not draw (a system alert or prompt): ${
        words.length > 0
          ? `press one of its buttons first (${words.join(', ')})`
          : 'another process draws it, so no touch from Lynkeus reaches it; relaunch the app, or answer it on the device'
      }`,
    );
  };

  const pressNative = async (target: Target, holdMs: number) => {
    let point = await settled(target);
    // With the keyboard up, a tap outside the field only dismisses it (the
    // scroll view swallows it): close it first and measure again once the layout moves back.
    if (point.element?.kind !== 'input' && elements().some((e) => e.focused)) {
      await backend.dismissKeyboard();
      // Only a device has a keyboard that slides away and a layout that follows it; a host has neither to wait for.
      if (backend.native) await sleep(300);
      point = await settled(target);
    }
    if (point.element) underSystemView(target, point.element);
    const pressedAt = Date.now();
    if (point.element) await backend.press(point.element, holdMs);
    else await backend.pressPoint(point.x, point.y, holdMs);
    const opened = openedSince(pressedAt);
    return { ...point, mode: 'native' as const, ...(opened ? { opened } : {}) };
  };

  // No touch, no gesture recognizer, no settle wait; but a disabled or covered
  // control stays unreachable, or the UI's own gates would mean nothing.
  const pressJs = async (target: Target) => {
    const element = presented(target);
    if (!element.enabled) throw new Error(`${describeTarget(target)} is disabled`);
    if (element.covered) throw new Error(`${describeTarget(target)} is covered`);
    const pressedAt = Date.now();
    await backend.pressJs(element);
    const opened = openedSince(pressedAt);
    return { ...centre(element), element, mode: 'js' as const, ...(opened ? { opened } : {}) };
  };

  const press = async ({ mode, holdMs, ...rest }: Target & PressOptions) => {
    const target = rest as Target;
    if (mode === 'js') return pressJs(target);
    // A finger cannot reach what is outside the window, so bring it in first. A host's
    // geometry is only an estimate, so there the case has to ask for it (`wait --scroll`).
    const known = 'x' in target || !backend.native ? undefined : find(target);
    if (known && !known.hidden && !inWindow(known)) await waitFor({ target, scroll: true, timeoutMs: 5000 });
    try {
      return await pressNative(target, holdMs ?? 50);
    } catch (error) {
      if (!(error instanceof LeftScreen) || !backend.native) throw error;
      // Brought back once, as a person scrolls back to what slid away under their finger.
      const back = await waitFor({ target, scroll: true, timeoutMs: 5000 }).then(
        () => true,
        () => false,
      );
      if (!back) throw error;
      return pressNative(target, holdMs ?? 50);
    }
  };

  const type = async (params: CoreMethods['type']['params']) => {
    let element: Element | undefined;
    if (params.target) {
      const found = find(params.target);
      if (found?.kind === 'input' && found.hidden === 'inert') {
        element = found;
      } else {
        element = (await pressNative(params.target, 50)).element;
        if (backend.native) {
          // The keyboard needs a frame to attach to the field before it accepts input.
          await sleep(80);
          // A screen that makes room for the keyboard moves the field meanwhile; text typed before it lands lays the
          // field out where it was then, so wait it out like a person would.
          await settled(params.target);
        }
      }
    }
    if (params.clear) {
      const current = elements().find((e) => e.focused)?.value ?? element?.value ?? '';
      if (current.length > 0) await backend.deleteBackward(current.length, element);
    }
    if (params.paste) {
      await backend.typeText(params.text, element);
    } else {
      // A controlled input formats on every change, and keys faster than a commit race the formatter. A host commits
      // each key before it answers (the headless host types inside act()); a turn of the event loop lets a formatter
      // that defers to a timer run, as a frame would.
      for (const char of params.text) {
        await backend.typeText(char, element);
        await sleep(backend.native ? 25 : 0);
      }
    }
    if (params.submit) await backend.submit(element);
    return { typed: params.text, element };
  };

  const swipe = async (params: CoreMethods['swipe']['params']) => {
    const { w: width, h: height } = backend.window();
    const durationMs = params.durationMs ?? 250;
    if (params.target) {
      const landed = await settled(params.target);
      const element = landed.element ?? presented(params.target);
      const direction = params.direction ?? 'up';
      const distance = params.distance ?? (direction === 'up' || direction === 'down' ? height : width) * 0.6;
      const dx = direction === 'left' ? -distance : direction === 'right' ? distance : 0;
      const dy = direction === 'up' ? -distance : direction === 'down' ? distance : 0;
      // Keep the finger inside the target. Moving the start to force the requested distance used to put it on the
      // outer pager for small cards; clip the end at the window instead and use the edge that maximizes the drag.
      const inset = 8;
      const middle = centre(element);
      const from = {
        x: dx < 0 ? element.frame.x + element.frame.w - inset : dx > 0 ? element.frame.x + inset : middle.x,
        y: dy < 0 ? element.frame.y + element.frame.h - inset : dy > 0 ? element.frame.y + inset : middle.y,
      };
      from.x = Math.max(inset, Math.min(width - inset, from.x));
      from.y = Math.max(inset, Math.min(height - inset, from.y));
      const to = {
        x: Math.max(inset, Math.min(width - inset, from.x + dx)),
        y: Math.max(inset, Math.min(height - inset, from.y + dy)),
      };
      if (!backend.swipeOn || (await backend.swipeOn(element, dx, dy)) === false) await backend.swipe(from, to, durationMs);
      return { from, to };
    }
    const presets = {
      up: { from: { x: width / 2, y: height * 0.7 }, to: { x: width / 2, y: height * 0.3 } },
      down: { from: { x: width / 2, y: height * 0.3 }, to: { x: width / 2, y: height * 0.7 } },
      left: { from: { x: width * 0.8, y: height / 2 }, to: { x: width * 0.2, y: height / 2 } },
      right: { from: { x: width * 0.2, y: height / 2 }, to: { x: width * 0.8, y: height / 2 } },
    };
    const preset = params.direction ? presets[params.direction] : undefined;
    const from = params.from ?? preset?.from;
    const to = params.to ?? preset?.to;
    if (!from || !to) throw new Error('swipe needs a direction, a target, or from/to points');
    await backend.swipe(from, to, durationMs);
    return { from, to };
  };

  // Towards an element that is known but outside the window, or onwards when it
  // has not rendered yet; over its own scroller when it has one.
  const swipeTowards = async (all: Element[], target: Element | undefined, back: boolean) => {
    const win = backend.window();
    let scroller: Element | undefined;
    for (let p = target?.parent; p !== undefined && !scroller; p = all[p]?.parent) if (all[p]?.kind === 'scroll') scroller = all[p];
    scroller ??= all.filter((e) => e.kind === 'scroll' && !e.hidden).sort((a, b) => b.frame.w * b.frame.h - a.frame.w * a.frame.h)[0];
    const box = scroller?.frame ?? { x: 0, y: 0, w: win.w, h: win.h };
    const left = Math.max(box.x, 0);
    const top = Math.max(box.y, 0);
    const right = Math.min(box.x + box.w, win.w);
    const bottom = Math.min(box.y + box.h, win.h);
    const cx = (left + right) / 2;
    const cy = (top + bottom) / 2;
    const dx = (right - left) * 0.3;
    const dy = (bottom - top) * 0.3;
    const at = target ? centre(target) : undefined;
    // The finger travels along the target's own row or column: a drag anywhere
    // else on the scroller may belong to something else (a pager of tabs).
    if (at && (at.x < 0 || at.x > win.w) && at.y >= 0 && at.y <= win.h) {
      const forward = at.x > win.w;
      await backend.swipe({ x: cx + (forward ? dx : -dx), y: at.y }, { x: cx + (forward ? -dx : dx), y: at.y }, 250);
      return;
    }
    const up = at === undefined ? back : at.y < 0;
    const x = at === undefined ? cx : Math.min(Math.max(at.x, left + 1), right - 1);
    await backend.swipe({ x, y: cy + (up ? -dy : dy) }, { x, y: cy + (up ? dy : -dy) }, 250);
  };

  // The focused screen, and the navigators it sits in when it is nested: `Demo > DemoPodcastList`.
  const onRoute = (route: string | undefined) => {
    const path = navigation.path();
    return path.length > 1 ? path.join(' > ') : route;
  };

  const waitFor = async (params: CoreMethods['waitFor']['params']) => {
    let swipes = 0;
    let lastSwipe = 0;
    // A target that is not mounted yet gives no direction: go down until the
    // list stops moving, then back up, and give up when that stops moving too.
    let back = false;
    let before = '';
    let moving = '';
    let movedAt = 0;
    const shape = (all: Element[]) => all.map((e) => `${e.testId ?? e.text ?? ''}@${Math.round(e.frame.y)}`).join('|');
    if (params.anyOf && params.gone) throw new Error('waitFor: gone takes one target, not anyOf');
    const started = Date.now();
    const deadline = started + (params.timeoutMs ?? 5000);
    while (true) {
      const route = navigation.currentRoute()?.name;
      // A navigator's own name (a tab or stack nested in the root) is reached once the focused screen is inside it.
      const routeOk = params.route === undefined || route === params.route || navigation.path().includes(params.route);
      const all = params.target || params.anyOf ? elements() : [];
      const found = params.target ? pick(all, params.target) : undefined;
      // Enabled means it takes a touch now: a control under a view that blocks touches (a pager whose last page has
      // not landed) reads as enabled but inert, and a swipe or press on it would be refused.
      const stateOk = (element: Element | undefined) =>
        element !== undefined && (params.enabled === undefined || (element.enabled === params.enabled && (!params.enabled || element.hidden !== 'inert')));
      const present = params.target ? stateOk(found) && !(params.scroll && !inWindow(found!)) : true;
      const targetOk = params.gone ? !present : present;
      const matched = params.anyOf?.find((t) => stateOk(pick(all, t)));
      const anyOk = !params.anyOf || matched !== undefined;
      // A device scroller keeps moving after the finger lifts; a host's stops at once.
      const now = shape(all);
      if (now !== moving) {
        moving = now;
        movedAt = Date.now();
      }
      const still = !backend.native || Date.now() - movedAt >= 120 || Date.now() - lastSwipe > 3000;
      // Found while the list still coasts from this wait's own swipe is not found where a press will look: the
      // scroll may carry it out of the window (a list virtualizes it away, or recycles its row for another).
      const landed = swipes === 0 || still;
      if (routeOk && targetOk && anyOk && landed) return { route, matched, waitedMs: Date.now() - started };
      if (params.route !== undefined && params.since !== undefined && !params.target && !params.anyOf && !params.gone) {
        const reached = traceSince(params.since).some((e) => e.kind === 'route' && (e.route === params.route || e.path.includes(params.route!)));
        if (reached) return { route, waitedMs: Date.now() - started, passed: true };
      }
      if (Date.now() > deadline) {
        throw new Error(
          `Timed out waiting for ${params.route ?? ''} ${params.target ? describeTarget(params.target) : ''}${params.gone ? ' to disappear' : ''} (on ${onRoute(route)})`,
        );
      }
      // The next swipe waits for the scroll to stop, so that whether one more is needed is decided where it
      // ends, not on its way.
      if (params.scroll && params.target && !params.gone && swipes < 30 && still && Date.now() - lastSwipe > (backend.native ? 400 : 50)) {
        if (!found && swipes > 0 && shape(all) === before) {
          if (back) swipes = 30;
          back = true;
        }
        before = shape(all);
        await swipeTowards(all, found, back);
        swipes += 1;
        lastSwipe = Date.now();
        continue;
      }
      await sleep(40);
    }
  };

  // Gives up quietly: a screen with a ticking clock never settles, and that is information, not a failure.
  const idle = async (params: CoreMethods['idle']['params']) => {
    const quietMs = params?.quietMs ?? 150;
    const after = params?.after;
    const deadline = Date.now() + (params?.timeoutMs ?? 3000);
    let lastCommit = backend.commitCount();
    let quietSince = Date.now();
    let arrived = after === undefined || lastCommit > after;
    while (Date.now() < deadline) {
      await sleep(30);
      const commit = backend.commitCount();
      if (after !== undefined && commit > after) arrived = true;
      // React Native's "Refreshing..." banner over the app is not the app at rest: a frame taken now would show it.
      if (commit !== lastCommit || devLoadingShowing() || (await busy())) {
        lastCommit = commit;
        quietSince = Date.now();
      } else if (arrived && Date.now() - quietSince >= quietMs) {
        return { commit, idle: true };
      }
    }
    return { commit: backend.commitCount(), idle: false };
  };

  const handlers: Handlers = {
    ping: () => ({ pong: true, native: backend.native, commands: host.commands(), js: jsAge() }),
    screen,
    find,
    press,
    type,
    swipe,
    navigate: async (params) => {
      // Right after a launch the app may not have mounted its navigation container yet (an emulator takes a few
      // hundred milliseconds more than a host).
      const deadline = Date.now() + 10_000;
      while (!navigation.isReady() && Date.now() < deadline) await sleep(50);
      // A navigator that swaps its screens on a state change (signed in, signed out) declares the new ones a render
      // or a remount later: a navigate sent right after the change would be dropped. Looks are counted too, for a
      // host whose clock jumps ahead while JavaScript sleeps.
      const listedBy = Date.now() + NAVIGATOR_SWAP_MS;
      for (let looks = 0; navigation.declares?.(params.name) === false && (Date.now() < listedBy || looks < NAVIGATOR_SWAP_MS / 50); looks++) await sleep(50);
      navigation.navigate(params.name, params.params);
      return { route: params.name };
    },
    back: () => {
      if (!navigation.canGoBack()) throw new Error('Nothing to go back to');
      navigation.goBack();
      return { route: navigation.currentRoute()?.name };
    },
    waitFor,
    idle,
    deepLink: async (params) => {
      await Linking.openURL(params.url);
      return { opened: params.url };
    },
    requests: (params) => ({ inFlight: requestsInFlight(), held: requestsHeld(), requests: recentRequests(params?.since) }),
    trace: (params) => ({ last: lastSeq(), events: traceSince(params?.since) }),
    dismissKeyboard: async () => {
      await backend.dismissKeyboard();
      return true;
    },
    debug: (params) => backend.debug(params),
    batch: async (params) => {
      const results: unknown[] = [];
      for (const call of params.calls) results.push(await dispatch(handlers, call.method, call.params, navigation));
      return { results };
    },
  };
  return handlers;
};

// `__DEV__` is false in a release bundle, the kind Lynkeus FastSim runs: an app that registered its commands inside
// `if (__DEV__)` has none there, and only this side can tell the driver why.
const releaseBundle = (): boolean => typeof __DEV__ !== 'undefined' && __DEV__ === false;

/** What a command the app did not register is missing, said so that a release bundle's reason is in the error. */
const unregistered = (head: string, method: string): string =>
  releaseBundle()
    ? `${head} (this is a release bundle, __DEV__ is false, as on Lynkeus FastSim: if the app registers ${method} inside if (__DEV__), that never ran here; call qa.register without the guard, it does nothing until Lynkeus connects)`
    : head;

/** Core methods first, then whatever the app registered. Unknown names fail loudly. */
export const dispatch = async (handlers: Handlers, method: string, params: unknown, navigation?: NavigationAdapter): Promise<unknown> => {
  const core = (handlers as Record<string, (p: unknown) => unknown>)[method];
  if (core) return (await core(params)) ?? null;
  const custom = host.get(method);
  // The app resets its own stores; the agent adds what only it reaches: the
  // host's mocked native state and the navigation stack.
  if (method === 'reset') {
    // With nothing to reset the app's own state, an answer of null would read as a reset that happened.
    if (!custom && !host.resetsItself())
      throw new Error(unregistered(`no command reset registered; registered: ${host.commands().join(', ') || 'none'}`, 'reset'));
    const result = custom ? ((await custom(params)) ?? null) : null;
    await host.runReset();
    navigation?.resetToRoot?.();
    return result;
  }
  if (custom) return (await custom(params)) ?? null;
  throw new Error(unregistered(`Unknown method ${method}`, method));
};

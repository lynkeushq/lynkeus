import fs from 'node:fs';
import path from 'node:path';

import type { Element, Screen } from 'lynkeus-protocol';

import type { Device } from '../device/driver.js';
import type { Flow } from '../flow/types.js';
import { pathOf, problemsOf } from '../knowledge/problems.js';
import { createReturns, RecoveryError } from './crawl/return.js';
import { candidates, controlName, label, layerName, nodeOf, pattern, presented, stateKey, targetOf } from './crawl/state.js';
import { awayAfter } from './drive.js';
import { clearOverlayIfShown, type Overlay } from './overlay.js';

export type LoginRecovery = {
  /** Run in order after a reset, with `vars`; the last should land logged in. */
  flows: Flow[];
  vars: Record<string, unknown>;
  /** Shell commands that print a variable, run right before a flow that declares it: a one-time code, a minted session. */
  varCommands?: Record<string, string>;
};

// The one signal about a press's consequences that holds in any app, with no vocabulary.
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export type Transition = {
  from: string;
  fromRoute?: string;
  fromLayer?: string;
  toLayer?: string;
  button: { testId?: string; text?: string };
  to: string;
  toRoute?: string;
  ms: number;
  problems: string[];
  /** The writes the press caused, when it caused any. */
  wrote?: string[];
  /** The press put another app in front (a link opened in the browser): what it opened, and whether the app had to be relaunched to come back. */
  outside?: { opened?: string; relaunched?: boolean };
};

/** Where a press that put another app in front leads: no screen of this app. */
export const OUTSIDE = 'outside';

export type CrawlOptions = {
  device: Device;
  outDir: string;
  depth: number;
  maxActions: number;
  neverPress?: RegExp;
  errorCopy?: RegExp;
  /** Without one, an overlay is closed by tapping its backdrop, then by a swipe down. */
  closers?: RegExp;
  backs?: RegExp;
  /** `read-only` (default): a press that makes the app write is reported, never repeated, and not explored past. */
  safety?: 'read-only' | 'anything';
  appId?: string;
  overlay?: Overlay;
  /** How to log in again after a headless host is reset (a crashed screen kills its navigator). */
  login?: LoginRecovery;
  /**
   * Signs in (`crawl.login`, a macro or steps): run when a route the crawl goes to is not mounted (a press signed
   * out, so the root holds only the sign-in screens), and first when the crawl starts on `signInFrom`. Resolves with
   * why it failed, or undefined.
   */
  signIn?: () => Promise<string | undefined>;
  /** The screen the sign-in begins on (its first wait for a route): a crawl that starts there signs in first. */
  signInFrom?: string;
  /**
   * What the sign-in waits for first when it is not a route (`#login-button`): the sign-in runs only while that is on
   * screen, so a crawl already signed in never runs it.
   */
  signInShows?: Record<string, unknown>;
  /** Goes to a route the way `nav` does, through the navigators that hold it; default the app's own navigate. */
  nav?: (route: string) => Promise<void>;
  /** Where to start, reached through a sign-in when it is behind one; default the screen the app is on. */
  from?: string;
  /** Press what the directions say leads here first, and stop on arrival. */
  goal?: string;
  /** What earlier crawls pressed, and what this one learns. */
  memory?: {
    tried: (node: string) => string[];
    record: (node: string, update: { tried?: string[]; seen?: string[]; visited?: boolean }) => void;
    /** Places with controls nobody has pressed, most owed first. */
    unfinished: () => string[];
  };
  directions?: (from: string, to: string) => { press?: string; to: string }[] | null;
  onTransition?: (t: Transition) => void;
  log?: (line: string) => void;
  /** Aborted when the caller gives up (an MCP client cancelling): no press starts after it. */
  signal?: AbortSignal;
};

/** A route the crawl could not get to because the app's root does not hold it: the other side of a sign-in. */
export type Gate = { route: string; root: string[]; error?: string };

const GATE = /No mounted navigator has a screen named (\S+?) \(the root's: ([^)]*)\)/;
// A sign-in that keeps being undone (every crawl of a screen signs out) is not worth repeating past this.
const MAX_SIGN_INS = 3;

class GateError extends Error {}

export const crawl = async (
  options: CrawlOptions,
): Promise<{ transitions: Transition[]; states: Record<string, Screen>; gate?: Gate; signedOutOnly?: string[] }> => {
  const { device, memory } = options;
  const readOnly = (options.safety ?? 'read-only') === 'read-only';
  fs.mkdirSync(options.outDir, { recursive: true });
  const transitions: Transition[] = [];
  const states: Record<string, Screen> = {};
  const explored = new Set<string>();
  const wrote = new Set<string>();
  const left = new Set<string>();
  const walked = new Set<string>();
  let actions = 0;
  let reached = false;
  let start: string | undefined;
  let gate: Gate | undefined;
  const signedOutOnly = new Set<string>();
  // The routes a signed-out app's root holds, as its gates said.
  const signedOutRoots = new Set<string>();
  let signIns = 0;
  const signIn = async (): Promise<string | undefined> => {
    signIns += 1;
    options.log?.('signing in (crawl.login)');
    const failed = await options.signIn!().catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
    await device.idle({ quietMs: 200, timeoutMs: 2000 }).catch(() => undefined);
    return failed;
  };
  const go = (route: string) => (options.nav ? options.nav(route) : device.navigate(route));
  /**
   * Whether the sign-in is what stands in the way: its first screen in the app's root, or what it waits for first on
   * screen. A route the root does not hold for another reason (a nested navigator not open yet) is no sign-in.
   */
  const signInShown = async (root: string[]): Promise<boolean> => {
    if (options.signInFrom) return root.includes(options.signInFrom) || (await device.screen()).route === options.signInFrom;
    if (options.signInShows) return !!(await device.server.call('find', options.signInShows).catch(() => null));
    return true;
  };
  /** Goes to a route; one the root does not hold is behind a sign-in: signed in through crawl.login, else the crawl stops there. */
  const navigate = async (route: string): Promise<void> => {
    try {
      await go(route);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const hit = GATE.exec(message);
      if (!hit) throw error;
      const root = hit[2]!.split(', ').filter(Boolean);
      if (options.signIn && !(await signInShown(root))) {
        // Signed in, the route is a screen only a signed-out app shows: left, not the crawl's end.
        if (route === options.signInFrom || signedOutRoots.has(route)) {
          signedOutOnly.add(route);
          throw new GateError(message);
        }
        // Signed in already (trial run 10: crawl.login ran on Welcome and failed): a plain way that did not work.
        throw error;
      }
      for (const r of root) signedOutRoots.add(r);
      let failed: string | undefined;
      if (options.signIn && signIns < MAX_SIGN_INS) {
        failed = await signIn();
        if (!failed) {
          const again = await go(route).then(
            () => undefined,
            (e: unknown) => (e instanceof Error ? e.message : String(e)),
          );
          if (again === undefined) return;
          if (!GATE.test(again)) throw new Error(again);
          // Signed in, the route is still not there: it is a sign-in screen itself. Left, not the crawl's end.
          signedOutOnly.add(route);
          throw new GateError(again);
        }
      }
      gate = { route, root, ...(failed ? { error: failed } : {}) };
      throw new GateError(message);
    }
  };
  const goTo = async (route: string | undefined): Promise<void> => {
    const target = route ?? start;
    if (target) await navigate(target);
    else await device.back();
  };
  const { dead, recover, settle, revive, restore } = createReturns({ device, options, goTo });

  const report = (transition: Transition, t0: number) => {
    transition.ms = Math.round(performance.now() - t0);
    transitions.push(transition);
    options.onTransition?.(transition);
  };

  const back = async (): Promise<'returned' | 'relaunched'> => {
    try {
      return await device.foreground();
    } catch (error) {
      throw new RecoveryError(error instanceof Error ? error.message : String(error));
    }
  };

  /**
   * A press that put another app in front went somewhere, outside the app: like a press that wrote, it is reported
   * and never repeated (it would only leave again), and the app is brought back as it was to go on from there.
   */
  const wentOutside = async (transition: Transition, button: Element, node: string, t0: number) => {
    const opened = device.opened;
    const how = await back();
    transition.to = OUTSIDE;
    transition.outside = { ...(opened ? { opened } : {}), ...(how === 'relaunched' ? { relaunched: true } : {}) };
    left.add(pattern(button));
    report(transition, t0);
    memory?.record(node, { tried: [controlName(button)] });
    options.log?.(
      `${controlName(button)} left the app (${opened ?? 'another app came to the front'}); brought it back${how === 'relaunched' ? ' by relaunching it' : ''}`,
    );
  };

  /** With a goal, whatever the directions say leads towards it goes first. */
  const ordered = (buttons: Element[], next: string | undefined): Element[] => {
    const toward = next ? buttons.filter((b) => b.testId === next) : [];
    if (toward.length === 0) return buttons;
    options.log?.(`towards ${options.goal}: press ${next} first`);
    return [...toward, ...buttons.filter((b) => !toward.includes(b))];
  };

  const explore = async (origin: Screen, depth: number, layer?: string): Promise<void> => {
    const key = stateKey(origin);
    if (explored.has(key) || depth > options.depth || reached || gate) return;
    explored.add(key);
    states[key] = origin;
    const node = nodeOf(origin, layer);
    const all = candidates(origin, options.neverPress, options.backs, options.closers);
    // Only a testID is promised to a later run: a control known by its text may render differently next time.
    memory?.record(node, { seen: all.filter((b) => b.testId).map(controlName), visited: true });
    const done = new Set(memory?.tried(node) ?? []);
    const next = options.goal && options.directions ? options.directions(node, options.goal)?.[0]?.press : undefined;
    const buttons = ordered(
      all.filter((b) => !done.has(controlName(b))),
      next,
    );
    const found = new Map<string, { button: Element; layer?: string }>();
    options.log?.(
      `explore ${origin.route ?? '?'}${layer ? ` +${layer}` : ''} depth ${depth}: ${buttons.length} buttons ` +
        `(${origin.elements.filter((e) => e.hidden).length} hidden, ${presented(origin).filter((e) => e.covered).length} covered)`,
    );
    for (const button of buttons) {
      if (actions >= options.maxActions || reached || gate || options.signal?.aborted) return;
      if (readOnly && wrote.has(pattern(button))) continue;
      if (left.has(pattern(button))) continue;
      const t0 = performance.now();
      const transition: Transition = { from: key, fromRoute: origin.route, fromLayer: layer, button: label(button), to: '', ms: 0, problems: [] };
      let sent = false;
      try {
        if (device.inBackground) await back();
        if (!device.server.connected) {
          await recover();
          if (!(await restore(origin, layer))) return;
        }
        const before = await device.requests();
        const present = await device.waitFor({ target: targetOf(button), timeoutMs: 800 }).then(
          () => true,
          () => false,
        );
        if (!present) {
          options.log?.(`skip ${controlName(button)}: no longer on screen`);
          continue;
        }
        actions++;
        sent = true;
        const { opened } = await device.press(targetOf(button));
        await awayAfter(device, opened);
        if (device.inBackground) {
          await wentOutside(transition, button, node, t0);
          if (!(await restore(origin, layer))) await goTo(origin.route);
          continue;
        }
        const after = await settle();
        transition.to = stateKey(after);
        transition.toRoute = after.route;
        // A press made inside a layer that is still up stays in it; one that raised a layer names it.
        transition.toLayer = layerName(after, origin.presenting ? layer : controlName(button));
        const { requests } = await device.requests(before.requests.at(-1)?.id);
        transition.problems.push(...problemsOf(after, requests, options.errorCopy));
        const writes = requests.filter((r) => WRITE_METHODS.has(r.method.toUpperCase()));
        if (writes.length) {
          transition.wrote = [...new Set(writes.map((r) => `${r.method} ${pathOf(r.url)}`))];
          wrote.add(pattern(button));
        }
        report(transition, t0);
        memory?.record(node, { tried: [controlName(button)] });
        if (options.goal && after.route === options.goal) {
          options.log?.(`reached ${options.goal}`);
          reached = true;
          return;
        }
        if (transition.to === key) continue;
        if (transition.wrote && readOnly) {
          options.log?.(`stop here: pressing ${controlName(button)} wrote (${transition.wrote.join(', ')})`);
        } else if (next !== undefined && button.testId === next) {
          // Getting somewhere in particular: follow the directions now instead of sweeping this screen first.
          await explore(after, depth + 1, transition.toLayer);
        } else if (!explored.has(transition.to) && !found.has(transition.to)) {
          found.set(transition.to, { button, layer: transition.toLayer });
        }
        if (after.route) memory?.record(nodeOf(after, transition.toLayer), {});
        if (!device.server.connected) await recover();
        if (!(await restore(origin, layer))) {
          await goTo(origin.route);
          await device.idle({ quietMs: 200, timeoutMs: 1500 });
        }
      } catch (error) {
        if (error instanceof RecoveryError) throw error;
        // The press went through and was reported; the way back is behind a sign-in: the crawl stops here (signed
        // out, no way in), or leaves this screen (one only a signed-out app shows).
        if (error instanceof GateError) return;
        // The OS can take longer to put the other app up than the press waits for: the read after it is what fails.
        if (sent && device.inBackground) {
          await wentOutside(transition, button, node, t0);
          if (!(await restore(origin, layer).catch(() => false))) await goTo(origin.route).catch(() => undefined);
          continue;
        }
        transition.problems.push(error instanceof Error ? error.message : String(error));
        report(transition, t0);
        if (!device.server.connected) await recover().catch(() => undefined);
        if (!(await restore(origin, layer).catch(() => false))) await goTo(origin.route).catch(() => undefined);
      }
    }

    // The whole screen is swept before going into what it opened: depth-first from the first control would
    // spend the budget inside it. Layers go first: one only exists while this screen holds it open, while a
    // route stays reachable by name.
    const queue = [...found].sort(([, a], [, b]) => Number(b.layer !== undefined) - Number(a.layer !== undefined));
    for (const [to, { button, layer: into }] of queue) {
      if (reached || gate) return;
      if (actions >= options.maxActions || explored.has(to) || options.signal?.aborted) continue;
      if (!(await restore(origin, layer).catch(() => false))) return;
      const target = targetOf(button);
      const back = await device
        .waitFor({ target, timeoutMs: 800 })
        .then(() => device.press(target))
        .then(() => settle())
        .catch(() => undefined);
      if (!back) continue;
      // What is there now, not what was: a banner may have rotated since the sweep.
      await explore(back, depth + 1, into);
      if (!device.server.connected) await recover().catch(() => undefined);
    }
  };

  /** A route can be jumped to; a layer is opened again from the route under it, the way the edge that found it says. */
  const walkTo = async (node: string): Promise<Screen | undefined> => {
    const [route, layer] = node.split('#');
    if (!route) return undefined;
    const jump = async () => {
      await navigate(route).catch(() => undefined);
      await device.idle({ quietMs: 200, timeoutMs: 2000 });
      return settle();
    };
    await revive();
    let now = await jump();
    if (now.route !== route) {
      // A dead navigator answers every jump with the same nothing; one reset is the difference between resuming and not.
      if (!dead(now)) return undefined;
      await revive();
      now = await jump();
      if (now.route !== route) return undefined;
    }
    if (!layer) return now;
    for (const step of options.directions?.(route, node) ?? []) {
      if (!step.press) return undefined;
      const press = step.press;
      const ok = await device
        .waitFor({ target: { testId: press }, timeoutMs: 1000 })
        .then(() => device.press({ testId: press }))
        .then(
          () => true,
          () => false,
        );
      if (!ok) return undefined;
      now = await settle();
    }
    return now.presenting ? now : undefined;
  };

  if (device.inBackground) await back();
  await clearOverlayIfShown(device, options.overlay);
  // Started on the screen the sign-in begins on: signed in first, so the crawl walks the app behind it.
  const startsSignedOut = options.signInFrom
    ? (await device.screen()).route === options.signInFrom
    : !!options.signInShows && !!(await device.server.call('find', options.signInShows).catch(() => null));
  if (options.signIn && startsSignedOut) {
    const failed = await signIn();
    const here = (await device.screen()).route ?? '?';
    if (failed) gate = { route: options.from ?? here, root: options.signInFrom ? [options.signInFrom] : [], error: failed };
  }
  if (options.from && !gate) {
    await navigate(options.from).catch((error: unknown) => {
      if (!(error instanceof GateError)) throw error;
    });
    await device.idle({ quietMs: 200, timeoutMs: 2000 }).catch(() => undefined);
  }
  const first = await revive();
  start = first.route;
  if (!gate) await explore(first, 0);

  // The budget is per run and the app is bigger than one: what is left goes back in the frontier, and what
  // is still reachable gets walked to while there is budget.
  while (!reached && !gate && actions < options.maxActions && !options.signal?.aborted) {
    const next = memory?.unfinished().find((node) => !walked.has(node));
    if (!next) break;
    walked.add(next);
    options.log?.(`resuming at ${next}`);
    const there = await walkTo(next);
    if (!there) {
      options.log?.(`could not get back to ${next}`);
      continue;
    }
    await explore(there, 0, next.split('#')[1]);
  }
  const more = { ...(gate ? { gate } : {}), ...(signedOutOnly.size ? { signedOutOnly: [...signedOutOnly] } : {}) };
  fs.writeFileSync(path.join(options.outDir, 'transitions.json'), JSON.stringify({ transitions, states, ...more }, null, 2));
  return { transitions, states, ...more };
};

/** Why a crawl stopped at a sign-in, and what lets it past: a line for its summary. */
export const describeGate = (gate: Gate, login: boolean): string => {
  const root = gate.root.length ? ` (the app's root holds ${gate.root.join(', ')})` : '';
  if (gate.error) return `stopped at a sign-in: crawl.login failed (${gate.error.split('\n')[0]}), so ${gate.route} could not be reached${root}`;
  return login
    ? `stopped at a sign-in: ${gate.route} is not mounted${root} and crawl.login was used ${MAX_SIGN_INS} times already`
    : `stopped at a sign-in: a press signed out and ${gate.route} is not mounted${root}; set crawl.login in lynkeus.config.json to a macro that signs in (such as "app.signIn") and crawl signs in there and goes on`;
};

const placeOf = (route: string | undefined, layer: string | undefined) => `${route ?? '?'}${layer ? `#${layer}` : ''}`;
const buttonOf = (t: Transition) => (t.button.testId ? `#${t.button.testId}` : JSON.stringify(t.button.text ?? ''));

/**
 * What a crawl found, in a few lines a model can read whole: the places it stood, the edges it learned, the problems and
 * the presses it did not go past; never a line per press (those go to stderr while it runs).
 */
export const describeCrawl = (r: {
  transitions: Transition[];
  learned: string[];
  reinforced: number;
  seconds: number;
  /** The press budget was spent: there is more to find. */
  spent: boolean;
  outDir: string;
  /** Where it stopped at a sign-in, said with what lets it past. */
  gate?: string;
  /** Screens only a signed-out app shows, left once it had signed in. */
  signedOutOnly?: string[];
}): string => {
  const places = new Set<string>();
  for (const t of r.transitions) {
    places.add(placeOf(t.fromRoute, t.fromLayer));
    if (t.toRoute) places.add(placeOf(t.toRoute, t.toLayer));
  }
  const listed = (items: string[], cap: number) => [
    ...items.slice(0, cap).map((i) => `    ${i}`),
    ...(items.length > cap ? [`    … ${items.length - cap} more`] : []),
  ];
  const problems = r.transitions
    .filter((t) => t.problems.length)
    .map((t) => `${placeOf(t.fromRoute, t.fromLayer)} ${buttonOf(t)} → ${placeOf(t.toRoute, t.toLayer)}: ${t.problems.join('; ')}`);
  const wrote = r.transitions.filter((t) => t.wrote).map((t) => `${placeOf(t.fromRoute, t.fromLayer)} ${buttonOf(t)}: ${t.wrote!.join(', ')}`);
  const outside = r.transitions
    .filter((t) => t.outside)
    .map(
      (t) =>
        `${placeOf(t.fromRoute, t.fromLayer)} ${buttonOf(t)} → ${t.outside!.opened ?? 'another app'}${t.outside!.relaunched ? ' (it did not come back: relaunched)' : ''}`,
    );
  return [
    `  ${r.transitions.length} presses on ${places.size} screens in ${r.seconds}s; ${r.learned.length} new edges (${r.reinforced} seen again), ${problems.length} problems`,
    ...(places.size ? [`  screens: ${[...places].sort().join(', ')}`] : []),
    ...(r.learned.length ? ['  new edges', ...listed(r.learned, 10)] : []),
    ...(problems.length ? ['  problems', ...listed(problems, 5)] : []),
    ...(wrote.length ? ['  not explored past (the press wrote)', ...listed(wrote, 5)] : []),
    ...(outside.length ? ['  left the app (brought back; not pressed again)', ...listed(outside, 5)] : []),
    ...(r.gate ? [`  ${r.gate}`] : []),
    ...(r.signedOutOnly?.length
      ? [`  left once signed in (the crawl does not sign out to go back): ${r.signedOutOnly.join(', ')}; crawl from there to finish them`]
      : []),
    ...(r.spent ? ['  more to find: the press budget ran out; crawl again to go on where it stopped, or pass a larger max or depth'] : []),
    `  artifacts: ${r.outDir}`,
  ].join('\n');
};

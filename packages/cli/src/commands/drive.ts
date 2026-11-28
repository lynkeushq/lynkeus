import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Element, Screen, Target } from 'lynkeus-protocol';
import { PNG } from 'pngjs';

import { lynkeusDir } from '../config.js';
import { type Device, describeScreen, describeTrace, NOT_DRAWN, nativeCover } from '../device/driver.js';
import { readJson, writeJson } from '../files.js';
import { lintContrast } from '../knowledge/contrast.js';
import { describeFindings, lintScreen } from '../knowledge/lint.js';
import { leafOf, nestedNavigate, routeChain } from '../knowledge/nesting.js';
import { describePerf, summarize, visitsFrom } from '../knowledge/perf.js';
import * as screens from '../knowledge/screens.js';
import { screenTree } from '../knowledge/tree.js';
import { type Base, define } from '../registry.js';
import { awayNote, describeKept, keptFailure, onPhone, platformOf, whyFor, whyScope } from '../runtime.js';
import { bareWordNote, expectedOf, isRoute, parseTarget, partMatchNote, routeOf, scopedTarget, TARGET_HELP } from '../targets.js';
import { type LintBaseline, newFindings } from './check.js';

const SCOPE_FLAGS = {
  in: { type: 'string' as const, help: 'the match nearest this target', value: 'target' },
  nth: { type: 'number' as const, help: 'the nth match, from 0', value: 'n' },
};

const coverOf = (device: Device): Promise<string | undefined> => device.screen().then(nativeCover, () => undefined);

/** A press that failed while a native view covers the app says so: the agent alone only reads every control as covered. */
const withCover = async (device: Device, error: unknown): Promise<unknown> => {
  const cover = error instanceof Error && !error.message.includes(NOT_DRAWN) ? await coverOf(device) : undefined;
  if (cover && error instanceof Error) error.message = `${error.message} (${cover})`;
  return error;
};

// The looks below go through the app (`idle`), so a host with a clock of its own moves on between them.
const look = (device: Device, ms: number) => device.idle({ quietMs: ms, timeoutMs: ms * 2 }).catch(() => undefined);

/**
 * A control still under what covers it (a screen sliding in, the app coming back from a reset) takes no tap: a press
 * is lost and typing finds no focused input. Waited for as a case's steps wait: there, then not covered.
 */
export const untilUncovered = async (device: Device, target: Target, timeoutMs = 3000): Promise<void> => {
  // A point is pressed where it is, whatever covers it: the agent never lists one, so a wait would only run out.
  if ('x' in target) return;
  const deadline = Date.now() + timeoutMs;
  const find = async () => (await device.server.call('find', target).catch(() => null)) as Element | null;
  // The keyboard of a focused field covers a control only until the press itself closes it (the agent does); a view
  // the app did not draw stays until someone answers it, and the press then says so.
  const stuck = async (e: Element) => {
    const screen = await device.screen();
    return !!screen.system || (e.kind !== 'input' && screen.elements.some((x) => x.focused));
  };
  let found = await find();
  if (!found) {
    await device.waitFor({ target, timeoutMs }).catch(() => undefined);
    found = await find();
  }
  while (found?.covered && Date.now() < deadline && !(await stuck(found))) {
    await look(device, 50);
    found = await find();
  }
};

const coveredShape = (screen: Screen) =>
  screen.elements
    .filter((e) => e.covered && !e.hidden)
    .map((e) => `${e.i}@${Math.round(e.frame.x)},${Math.round(e.frame.y)}`)
    .join('|');

// Longer than a platform's screen transition: covered controls that stay so this long are covered for good (a header
// over a scrolled list), not by a screen still moving.
const STEADY_COVER_MS = 600;

/**
 * The screen once the app is quiet and done moving. A native transition changes no React state, so a quiet app can
 * still be sliding the next screen in, every control on it reading as covered until it lands: the screen is read
 * again until what is covered clears or stops changing.
 */
export const settledScreen = async (device: Device, timeoutMs = 3000): Promise<Screen> => {
  await device.idle({ quietMs: 200, timeoutMs }).catch(() => undefined);
  let screen = await device.screen();
  let shape = coveredShape(screen);
  let since = Date.now();
  const deadline = Date.now() + timeoutMs;
  while (shape && Date.now() < deadline && Date.now() - since < STEADY_COVER_MS) {
    // A host on a clock of its own answers a look at once: the steady time is still the wall's.
    await Promise.all([look(device, 100), new Promise((r) => setTimeout(r, 50))]);
    screen = await device.screen();
    const now = coveredShape(screen);
    if (now !== shape) {
      shape = now;
      since = Date.now();
    }
  }
  return screen;
};

// The OS takes a moment to put the browser up once the app hands it a URL; the app says so when it steps back.
const AWAY_WAIT_MS = 1500;

/** Whether a press sent the app behind something else, and what: waited for only when the press opened a URL. */
export const awayAfter = async (device: Device, opened: string | undefined): Promise<string | undefined> => {
  if (opened && onPhone(device.server) && device.server.appState === 'active') {
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        device.server.off('appstate', done);
        resolve();
      };
      const timer = setTimeout(done, AWAY_WAIT_MS);
      device.server.on('appstate', done);
    });
  }
  return awayNote(device.server, opened);
};

const graphOrNull = (ctx: Base) => {
  try {
    return ctx.graph();
  } catch {
    return null;
  }
};

/** The note `bareWordNote` makes about a bare word, against the routes the route graph and the screens read so far name. */
const bareWordOnScreen = async (ctx: Base, device: Device, raw: string): Promise<string | undefined> => {
  if (raw.startsWith('route:') || !isRoute(raw)) return undefined;
  const known = new Set<string>(screens.observed(lynkeusDir(ctx.root)).keys());
  for (const route of Object.keys(graphOrNull(ctx)?.screens ?? {})) known.add(route);
  const screen = await device.screen().catch(() => undefined);
  if (!screen) return undefined;
  if (screen.route) known.add(screen.route);
  const texts = screen.elements.filter((e) => !e.hidden || e.hidden === 'inert').flatMap((e) => [e.text, e.accessibilityLabel].filter((t): t is string => !!t));
  return bareWordNote(raw, texts, known);
};

const DEVICE_LANES = ['ios', 'android'];
const WHY_LANES = [...DEVICE_LANES, 'fastsim:ios', 'fastsim:android', 'headless'];

export const driveCommands = [
  define({
    name: 'screen',
    mcp: 'core',
    mcpOmit: ['record', 'tree', 'verbose', 'frames'],
    mcpDetails: 'One line per element: index, kind, #testId, label, value, state (!disabled ~covered ~inert). The header counts what is not presented.',
    group: 'drive',
    summary: 'Route, path and every element on screen, in ms',
    details:
      'One line per element: index, kind, #testId, label, value and state (`!disabled`, `~covered`, `~inert`). What the platform is not presenting is left out and counted in the header; `--all` lists it. `--frames` adds each centre in points; `--verbose` the commit count and cost. `--tree` prints nested lines with no geometry: the form to diff. `--record` keeps the structure under .lynkeus/screens/ and notes what changed since the last read.',
    flags: {
      tree: { type: 'boolean', help: 'as a tree of meaning, without frames' },
      record: { type: 'boolean', help: 'keep it under .lynkeus/screens/ and report changes (or LYNKEUS_RECORD_SCREENS=1)' },
      all: { type: 'boolean', help: 'also list what is not presented' },
      frames: { type: 'boolean', help: 'with each centre, in points' },
      verbose: { type: 'boolean', help: 'commit count and read cost in the header' },
    },
    needs: 'app',
    run: async (ctx) => {
      const device = await ctx.device();
      const screen = await device.screen();
      const away = awayNote(device.server);
      if (ctx.flags.record || process.env.LYNKEUS_RECORD_SCREENS === '1') {
        const change = screens.record(lynkeusDir(ctx.root), screen);
        if (change) ctx.err(`screen changed since last read:\n${screens.describeChange(change)}`);
      }
      const options = { all: Boolean(ctx.flags.all), frames: Boolean(ctx.flags.frames), verbose: Boolean(ctx.flags.verbose) };
      const text = ctx.flags.tree ? screenTree(screen) : describeScreen(screen, options);
      return { text: away ? `! ${away}\n${text}` : text, json: away ? { ...screen, away } : screen };
    },
  }),
  define({
    name: 'press',
    mcp: 'core',
    mcpOmit: ['hold', 'js', 'nth'],
    group: 'drive',
    summary: 'A finger on an element',
    positionals: [{ name: 'target', help: TARGET_HELP, required: true }],
    flags: {
      ...SCOPE_FLAGS,
      hold: { type: 'number', help: 'hold for this long', value: 'ms' },
      js: { type: 'boolean', help: 'call onPress directly instead of a synthesized touch' },
      settle: { type: 'boolean', help: 'wait for the app to stop committing, then print the screen' },
    },
    needs: 'app',
    run: async (ctx) => {
      const device = await ctx.device();
      // A control a screen is still sliding over takes no tap: waited for as a case's press waits.
      if (!ctx.waited) await untilUncovered(device, scopedTarget(ctx.args[0]!, ctx.flags));
      const result = await device
        .press({
          ...scopedTarget(ctx.args[0]!, ctx.flags),
          holdMs: ctx.flags.hold as number | undefined,
          mode: ctx.flags.js ? 'js' : undefined,
        })
        .catch(async (error: unknown) => {
          throw await withCover(device, error);
        });
      const away = await awayAfter(device, result.opened);
      if (away) return { text: `! ${away}`, json: { ...result, away } };
      const part = partMatchNote(scopedTarget(ctx.args[0]!, ctx.flags), result.element);
      const pressed = part ? { ...result, part } : result;
      const note = part ? `! pressed ${part}: if that is not the one, write its whole label or its testID` : undefined;
      if (!ctx.flags.settle) return note ? { text: note, json: pressed } : { json: pressed };
      const screen = await settledScreen(device);
      const late = awayNote(device.server);
      return late
        ? { text: `! ${late}`, json: { ...pressed, away: late } }
        : { text: [note, describeScreen(screen)].filter(Boolean).join('\n'), json: pressed };
    },
  }),
  define({
    name: 'type',
    mcp: 'core',
    mcpOmit: ['paste', 'nth'],
    group: 'drive',
    summary: 'Type into the focused input, or tap a target first',
    positionals: [
      { name: 'text', help: 'what to type', required: true },
      { name: 'target', help: `tap this first: ${TARGET_HELP}` },
    ],
    flags: {
      ...SCOPE_FLAGS,
      paste: { type: 'boolean', help: 'insert at once instead of key by key' },
      submit: { type: 'boolean', help: 'then the return key (onSubmitEditing)' },
      clear: { type: 'boolean', help: 'clear the field first' },
    },
    needs: 'app',
    run: async (ctx) => {
      const device = await ctx.device();
      const target = ctx.args[1] ? scopedTarget(ctx.args[1], ctx.flags) : undefined;
      if (target) await untilUncovered(device, target);
      return {
        json: await device.type({ text: ctx.args[0]!, target, paste: !!ctx.flags.paste, clear: !!ctx.flags.clear, submit: !!ctx.flags.submit }),
      };
    },
  }),
  define({
    name: 'swipe',
    mcp: 'core',
    group: 'drive',
    summary: 'A drag; on a target, drives its gesture (a slider, a sheet)',
    details:
      'On a target the drag starts at its centre, which a wide control cannot always afford: a slider needing 80% of its width would end off-screen, and a touch that leaves the screen is cancelled. `--from`/`--to` place both ends, in points.',
    positionals: [
      { name: 'direction', help: 'up | down | left | right (omit when giving --from/--to)' },
      { name: 'target', help: TARGET_HELP },
    ],
    flags: {
      distance: { type: 'number', help: 'how far, in points', value: 'pt' },
      from: { type: 'string', help: 'where the finger lands, as x,y', value: 'x,y' },
      to: { type: 'string', help: 'where it lifts, as x,y', value: 'x,y' },
      duration: { type: 'number', help: 'how long the drag takes, ms', value: 'ms' },
    },
    needs: 'app',
    run: async (ctx) => {
      const device = await ctx.device();
      const durationMs = ctx.flags.duration as number | undefined;
      const point = (flag: 'from' | 'to') => {
        const [x, y] = (ctx.flags[flag] as string).split(',').map((n) => Number(n.trim()));
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`--${flag} must be two numbers, as x,y`);
        return { x: x!, y: y! };
      };
      if (ctx.flags.from || ctx.flags.to) {
        if (!ctx.flags.from || !ctx.flags.to) throw new Error('--from and --to go together');
        return { json: await device.swipe({ from: point('from'), to: point('to'), durationMs }) };
      }
      const direction = ctx.args[0] as 'up' | 'down' | 'left' | 'right';
      if (!['up', 'down', 'left', 'right'].includes(direction)) throw new Error('swipe needs a direction (up, down, left or right), or --from and --to');
      if (ctx.args[1]) {
        const distance = ctx.flags.distance as number | undefined;
        return { json: await device.swipe({ direction, target: parseTarget(ctx.args[1]), distance, durationMs }) };
      }
      await device.swipe({ direction });
      return { json: { direction } };
    },
  }),
  define({
    name: 'back',
    group: 'drive',
    summary: 'Back, as a person goes back: an open drawer or menu closes first, else the current route pops',
    needs: 'app',
    mcp: 'core',
    run: async (ctx) => {
      const result = await (await ctx.device()).back();
      return {
        text: result?.closed
          ? `closed the ${result.closed.replace(/^(close|dismiss) /i, '')}; still on ${result.route ?? '?'}`
          : `back on ${result?.route ?? '?'}`,
        json: result,
      };
    },
  }),
  define({
    name: 'nav',
    group: 'drive',
    summary: 'Jump straight to a route (a teleport, not a user action)',
    details:
      'A screen inside a nested navigator is reached through its parents, which nav finds itself: from the path the screen had when a run last saw it, else from the route graph (`lynkeus map build`). `{ "screen": "Inner" }` in the params names the nested screen of a navigator route, as React Navigation takes it. The answer names the screen it lands on, and `via` the parents it went through.',
    positionals: [
      { name: 'route', help: 'e.g. Settings.Main', required: true },
      { name: 'params', help: 'JSON params' },
    ],
    needs: 'app',
    run: async (ctx) => {
      const route = routeOf(ctx.args[0]!);
      const params = ctx.args[1] ? (JSON.parse(ctx.args[1]) as object) : undefined;
      const chain = routeChain(route, { graph: graphOrNull(ctx), observed: screens.observed(lynkeusDir(ctx.root)) });
      const call = chain && chain.length > 1 ? nestedNavigate(chain, params) : { name: route, params };
      await (await ctx.device()).navigate(call.name, call.params);
      return { json: { route: leafOf(route, params), ...(call.name !== route ? { via: chain!.slice(0, -1) } : {}) } };
    },
  }),
  define({
    name: 'wait',
    mcp: 'core',
    mcpOmit: ['nth', 'since'],
    group: 'drive',
    summary: 'Until a route or element appears (or leaves), any of several targets appears, or a number of ms',
    positionals: [{ name: 'what', help: `Route | route:index | ${TARGET_HELP} | 800 (ms)` }],
    flags: {
      ...SCOPE_FLAGS,
      anyOf: { type: 'list', help: 'accept any of these targets (repeatable)', value: 'target' },
      gone: { type: 'boolean', help: 'until it leaves the screen' },
      scroll: { type: 'boolean', help: 'scroll until it is in the window and not covered (by a tab bar, a header)' },
      enabled: {
        type: 'boolean',
        help: 'until it is present, enabled and taking touches (a form button that waits on its fields, a pager whose last page has not landed)',
      },
      timeout: { type: 'number', help: 'give up after', default: 10000, value: 'ms' },
      since: { type: 'number', help: 'a trace mark: a route reached after it counts, even if already left', value: 'seq' },
    },
    needs: 'app',
    run: async (ctx) => {
      const raw = ctx.args[0];
      if (raw && /^\d+$/.test(raw)) {
        await new Promise((r) => setTimeout(r, Number(raw)));
        return { json: { waitedMs: Number(raw) } };
      }
      const anyOf = (ctx.flags.anyOf as string[] | undefined)?.map((target) => scopedTarget(target, ctx.flags));
      if (!raw && !anyOf?.length) throw new Error('wait needs a route, target, milliseconds, or --anyOf');
      // Which of several should leave? Ambiguous, and the agent would wait for presence instead.
      if (anyOf?.length && ctx.flags.gone) throw new Error('wait --gone takes one target, not --anyOf');
      const device = await ctx.device();
      try {
        return {
          json: await device.waitFor({
            ...(raw ? (isRoute(raw) ? { route: routeOf(raw) } : { target: scopedTarget(raw, ctx.flags) }) : {}),
            ...(anyOf?.length ? { anyOf } : {}),
            gone: ctx.flags.gone ? true : undefined,
            scroll: ctx.flags.scroll ? true : undefined,
            ...(ctx.flags.enabled ? { enabled: true } : {}),
            timeoutMs: ctx.flags.timeout as number,
            since: ctx.flags.since as number | undefined,
          }),
        };
      } catch (error) {
        const note = raw && !ctx.flags.gone ? await bareWordOnScreen(ctx, device, raw) : undefined;
        if (!note || !(error instanceof Error)) throw error;
        throw new Error(`${error.message} — ${note}`);
      }
    },
  }),
  define({
    name: 'screenshot',
    group: 'drive',
    summary: 'What the screen looks like right now, written to a file',
    details:
      'A host that draws the app (Lynkeus FastSim) captures its own frame, within the output folders it allows; a device or simulator is captured by its OS; the headless host renders nothing to capture.',
    positionals: [{ name: 'file', help: 'where to write the png', required: true }],
    needs: 'app',
    run: async (ctx) => {
      const file = path.resolve(ctx.args[0]!);
      await (await ctx.device()).screenshot(file);
      return { text: file, json: { file } };
    },
  }),
  define({
    name: 'see',
    group: 'drive',
    summary: 'Assert a route or element is on screen now (exit 1 if not)',
    positionals: [{ name: 'what', help: `Route | route:index | ${TARGET_HELP}`, required: true }],
    flags: {
      absent: { type: 'boolean', help: 'assert it is not there' },
      within: { type: 'number', help: 'allow it this long to appear', default: 0, value: 'ms' },
    },
    needs: 'app',
    run: async (ctx) => {
      const raw = ctx.args[0]!;
      const device = await ctx.device();
      try {
        const result = await device.waitFor({
          ...(isRoute(raw) ? { route: routeOf(raw) } : { target: parseTarget(raw) }),
          gone: ctx.flags.absent ? true : undefined,
          timeoutMs: Math.max(1, ctx.flags.within as number),
        });
        return { text: `${ctx.flags.absent ? 'gone' : 'on screen'}: ${raw}`, json: result };
      } catch {
        const cover = ctx.flags.absent ? undefined : await coverOf(device);
        return { text: `${ctx.flags.absent ? 'still on screen' : 'not on screen'}: ${raw}${cover ? ` (${cover})` : ''}`, json: { ok: false }, code: 1 };
      }
    },
  }),
  define({
    name: 'idle',
    group: 'drive',
    summary: 'Until the app stops committing: data arrived, animations done',
    details:
      'A screen that has not started looks exactly like one that has finished — both are quiet. `--after <commit>`, given the commit count from before whatever was supposed to happen, waits for the app to commit past it first.',
    flags: {
      quiet: { type: 'number', help: 'no commit for this long counts as settled', default: 300, value: 'ms' },
      timeout: { type: 'number', help: 'give up after (the answer says whether it settled)', default: 5000, value: 'ms' },
      after: { type: 'number', help: 'a commit count from before: quiet only counts once the app has committed past it', value: 'commit' },
    },
    needs: 'app',
    run: async (ctx) => ({
      json: await (await ctx.device()).idle({
        quietMs: ctx.flags.quiet as number,
        timeoutMs: ctx.flags.timeout as number,
        after: ctx.flags.after as number | undefined,
      }),
    }),
  }),
  define({
    name: 'requests',
    group: 'drive',
    summary: 'The HTTP requests the app made: method, path, status, ms',
    flags: { last: { type: 'number', help: 'how many', default: 30, value: 'n' } },
    needs: 'app',
    run: async (ctx) => {
      const result = await (await ctx.device()).requests();
      const list = result.requests.slice(-(ctx.flags.last as number));
      const lines = [
        `in flight: ${result.inFlight}${result.held ? `, held: ${result.held}` : ''}`,
        ...list.map(
          (r) =>
            `${String(r.status ?? '…').padStart(4)} ${String(r.ms ?? '').padStart(6)}ms ${r.method.padEnd(6)} ${r.url}${r.error ? `  (${r.error})` : ''}${r.mocked ? '  (mocked)' : ''}`,
        ),
      ];
      return { text: lines.join('\n'), json: { inFlight: result.inFlight, held: result.held ?? 0, requests: list } };
    },
  }),
  define({
    name: 'trace',
    group: 'drive',
    summary: 'What happened, in order: routes, requests, store diffs, touches, commands',
    flags: {
      since: { type: 'number', help: 'only after this seq (from a previous trace)', value: 'seq' },
      last: { type: 'number', help: 'how many', default: 60, value: 'n' },
    },
    needs: 'app',
    run: async (ctx) => {
      const result = await (await ctx.device()).trace(ctx.flags.since as number | undefined);
      const events = result.events.slice(-(ctx.flags.last as number));
      ctx.err(`last seq ${result.last}`);
      return { text: describeTrace(events), json: { last: result.last, events } };
    },
  }),
  define({
    name: 'call',
    mcp: 'core',
    group: 'drive',
    summary: 'An app command registered with qa.register (reset, busy, …)',
    positionals: [
      { name: 'command', help: 'its name', required: true },
      { name: 'params', help: 'JSON params' },
    ],
    needs: 'app',
    run: async (ctx) => ({ json: await (await ctx.device()).command(ctx.args[0]!, ctx.args[1] ? JSON.parse(ctx.args[1]) : undefined) }),
  }),
  define({
    name: 'hello',
    group: 'drive',
    summary: 'What the app said about itself: platform, native, registered commands',
    needs: 'app',
    run: async (ctx) => {
      const { language, locale } = ctx.config;
      const hello = { ...(await ctx.device()).server.hello, ...(language || locale ? { locale: { language, ...locale } } : {}) };
      return { text: JSON.stringify(hello, null, 2), json: hello };
    },
  }),
  define({
    name: 'launch',
    group: 'drive',
    summary: 'Relaunch the app and wait for the agent',
    positionals: [{ name: 'bundleId', help: 'or --app' }],
    flags: { clean: { type: 'boolean', help: "run the app's reset command first, if it is attached" } },
    needs: 'app',
    run: async (ctx) => {
      const device = await ctx.device();
      const appId = ctx.args[0] ?? (ctx.flags.app as string | undefined) ?? ctx.config.app ?? device.appId ?? undefined;
      if (!appId) throw new Error('launch needs a bundle id (argument, --app, or app in lynkeus.config.json), and the app’s agent did not say it');
      if (ctx.flags.clean) await device.command('reset').catch(() => undefined);
      await device.launchApp(appId, { fresh: true });
      await device.idle({ quietMs: 200, timeoutMs: 3000 }).catch(() => undefined);
      const screen = await device.screen();
      return { text: describeScreen(screen), json: screen };
    },
  }),
  define({
    name: 'why',
    mcp: 'core',
    mcpOmit: ['route'],
    mcpDetails:
      'Runs by itself after a failed step. With nothing given it explains the last failed case of the last case_run, on whichever lane it ran (FastSim, headless or a device), and names the lane; give what you looked for to read the app now.',
    group: 'drive',
    summary: 'Why the last thing failed: screen, requests and trace read as rules',
    details:
      'Runs by itself after a failed press, wait, type, swipe or nav. With no target it explains the last failed case of the last `case run`, on whichever lane it ran (a FastSim host, the headless host, a Simulator, emulator or phone), named in the answer, as the run read it at the failure; after a command of yours, that command. Give it what you were looking for to read the app now and sharpen the answer.',
    positionals: [{ name: 'target', help: `what was expected: Route | ${TARGET_HELP}` }],
    flags: {
      route: { type: 'string', help: 'the route that was expected', value: 'Route' },
      on: {
        type: 'string',
        help: `the lane to explain: ${WHY_LANES.join(', ')} (default: the last run's last failed case, else the attached app)`,
        value: 'lane',
      },
    },
    needs: 'app',
    run: async (ctx) => {
      const on = ctx.flags.on as string | undefined;
      if (on !== undefined && !WHY_LANES.includes(on)) return { text: `--on takes ${WHY_LANES.join(', ')}, not ${on}`, code: 2 };
      const asked = ctx.args[0] !== undefined || ctx.flags.route !== undefined;
      // A FastSim or headless host a run started is gone: what the run read at its last failure is the answer.
      const kept = asked ? undefined : keptFailure(on);
      if (kept && 'case' in kept) return { text: describeKept(kept), ...(kept.lane ? { lane: kept.lane } : {}) };
      if (kept) {
        const { cases, lanes } = kept.passed;
        const ran = `${cases} case(s)${lanes.length ? ` on ${lanes.join(', ')}` : ''}`;
        return `the last run failed nothing${on ? ` on ${on}` : ''} (${ran}): there is no failure to explain. Give what you looked for to read the app now.`;
      }
      if (on && !DEVICE_LANES.includes(on))
        return `no failed case on ${on} is kept from a run here; a host's own state can be read only while it runs (fastsim start, headless start).`;
      const expected = { ...expectedOf(ctx.args[0]), ...(ctx.flags.route ? { route: ctx.flags.route as string } : {}) };
      const device = await ctx.device();
      // About the last case or command run on this app, not whatever failed before it.
      const lane = on ?? platformOf(device);
      const scope = whyScope(device.server.port, lane);
      const read = await whyFor(ctx, Object.keys(expected).length ? expected : undefined, scope?.at, scope?.since);
      const attachedOn = platformOf(device);
      const elsewhere =
        lane && attachedOn && lane !== attachedOn
          ? `the app attached here runs on ${attachedOn}; the screen, requests and trace below are its, the case is ${lane}'s`
          : undefined;
      const failed = scope?.failed ? `the last ${scope.case ? `case (${scope.case})` : 'command'} failed at ${scope.failed}` : undefined;
      const word = ctx.args[0] ? await bareWordOnScreen(ctx, device, ctx.args[0]) : undefined;
      return [elsewhere, failed, word && `  • ${word}`, read].filter(Boolean).join('\n') || '(no evidence available)';
    },
  }),
  define({
    name: 'lint',
    group: 'drive',
    summary: 'Unlabeled controls, small targets, low-contrast text, untranslated keys, covered or clipped elements',
    flags: {
      strict: { type: 'boolean', help: 'exit 1 on any warning' },
      'no-contrast': { type: 'boolean', help: 'skip the contrast of text against its background (it takes a screenshot)' },
      save: { type: 'string', help: "keep this screen's findings in a baseline file", value: 'file' },
      baseline: { type: 'string', help: 'print only what is new against a baseline file', value: 'file' },
    },
    needs: 'app',
    run: async (ctx) => {
      const screen = await (await ctx.device()).screen();
      const { lint, lintBaseline } = ctx.config;
      let findings = lintScreen(screen, { i18nKeyPatterns: lint?.i18nKeyPatterns?.map((p) => new RegExp(p, 'i')), minTouchTarget: lint?.minTouchTarget });
      const route = screen.route ?? '?';
      const notes: string[] = [];
      if (lint?.contrast !== false && !ctx.flags['no-contrast']) {
        // Contrast is read off the pixels, so it needs a host that can take a picture of the screen.
        const file = path.join(os.tmpdir(), `lynkeus-lint-${process.pid}-${Date.now()}.png`);
        try {
          await (await ctx.device()).screenshot(file);
          const picture = PNG.sync.read(fs.readFileSync(file));
          const contrast = lint?.contrast;
          findings = [
            ...findings,
            ...lintContrast(screen, picture, { normal: contrast?.normal, large: contrast?.large, ignore: contrast?.ignore?.map((p) => new RegExp(p)) }),
          ];
        } catch {
          notes.push('contrast not measured: this host takes no screenshots');
        } finally {
          fs.rmSync(file, { force: true });
        }
      }
      const withIds = findings.map((finding) => ({ finding, testId: screen.elements[finding.element]?.testId }));
      const lines: string[] = [];
      const save = ctx.flags.save as string | undefined;
      const baselineFile = (ctx.flags.baseline as string | undefined) ?? lintBaseline;
      if (save) {
        const baseline = fs.existsSync(save) ? readJson<LintBaseline>(save) : {};
        baseline[route] = withIds.map((f) => ({ rule: f.finding.rule, testId: f.testId, subject: f.finding.subject, message: f.finding.message }));
        writeJson(save, baseline);
        lines.push(`saved ${findings.length} finding(s) for ${route} → ${save}`);
      } else if (baselineFile && fs.existsSync(baselineFile)) {
        findings = newFindings(readJson<LintBaseline>(baselineFile), route, withIds).map((f) => f.finding);
        lines.push(findings.length ? `${findings.length} new against ${baselineFile}:` : `nothing new on ${route} against ${baselineFile}`);
      }
      lines.push(describeFindings(findings, screen.route), ...notes);
      return { text: lines.join('\n'), json: findings, code: ctx.flags.strict && findings.some((f) => f.severity === 'warn') ? 1 : 0 };
    },
  }),
  define({
    name: 'perf',
    group: 'drive',
    summary: 'Per screen: requests on arrival, time to quiet, errors, stalls, the slowest call',
    flags: {
      since: { type: 'number', help: 'only after this trace seq', value: 'seq' },
      last: { type: 'number', help: 'only the last n trace events', value: 'n' },
    },
    needs: 'app',
    run: async (ctx) => {
      const { events } = await (await ctx.device()).trace(ctx.flags.since as number | undefined);
      const summary = summarize(visitsFrom(ctx.flags.last ? events.slice(-(ctx.flags.last as number)) : events));
      return { text: describePerf(summary), json: summary };
    },
  }),
  define({
    name: 'profile',
    group: 'drive',
    summary: 'What React spent rendering, per route, measured by the Profiler auto() mounts',
    details:
      '`profile start` clears and starts recording, `profile` reports what was recorded since, `profile stop` reports and stops. Recording is off until started, so an app that never asks pays nothing.',
    positionals: [{ name: 'action', help: 'start | stop (omit to report)' }],
    needs: 'app',
    run: async (ctx) => {
      const action = ctx.args[0];
      if (action !== undefined && action !== 'start' && action !== 'stop') return { text: `profile: unknown action ${action} (start | stop)`, code: 2 };
      const result = await (await ctx.device()).command<{
        recording: boolean;
        commits?: number;
        ms?: number;
        routes?: Record<string, { commits: number; ms: number; maxMs: number }>;
      }>('profile', action ? { action } : {});
      if (action === 'start') return { text: 'profile: recording', json: result };
      const routes = Object.entries(result.routes ?? {})
        .sort(([, a], [, b]) => b.ms - a.ms)
        .map(([route, r]) => `  ${route}: ${r.ms} ms in ${r.commits} commits (slowest ${r.maxMs} ms)`);
      const head = `profile: ${result.ms ?? 0} ms in ${result.commits ?? 0} commits${result.recording ? '' : ' (not recording)'}`;
      return { text: [head, ...routes].join('\n'), json: result };
    },
  }),
];

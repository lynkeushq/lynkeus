/**
 * Runs a case's setup, then its steps, stopping at the first that fails. The
 * app is driven through the terminal's own commands on one connection; the
 * backend is prepared and read through the project's fixtures. How this app
 * logs in or what a user is belongs to the project, as macros and fixtures.
 */
import { exec } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { clearTimeout as clearWallTimer, setTimeout as wallTimer } from 'node:timers';
import { promisify } from 'node:util';

import type {
  Element,
  RequestRecord,
  RunEdges,
  RunLooked,
  RunNativeValue,
  RunScroll,
  RunSighting,
  RunStepPhase as StepPhase,
  Screen,
  Target,
} from 'lynkeus-protocol';

import { lynkeusDir } from '../config.js';
import { type Device, describeScreen, NATIVE_COVER, NOT_DRAWN, nativeCover } from '../device/driver.js';
import type { Recording } from '../device/platform.js';
import { checkFilm, clearFilmLeftovers, settledFilm } from './film.js';
import { trafficEvents } from '../knowledge/analyticsTraffic.js';
import { type AppEvent, normalizeEvents, type RunEvent } from '../knowledge/events.js';
import { leafOf } from '../knowledge/nesting.js';
import { type Base, type Command, find } from '../registry.js';
import { execute, laneLabel, noteCaseEnd, notePrinted, onPhone, platformOf, scopeWhy, targetOf, unreachable, whyFor } from '../runtime.js';
import * as screens from '../knowledge/screens.js';
import { type Expected, isRoute, parseTarget, routeOf, scopedTarget } from '../targets.js';
import type { Fixtures, FixturesConfig } from './fixtures.js';
import { compactFrame } from './frames.js';
import { readsOf } from './nativeValues.js';
import { type BackendSpan, newSpanId, newTraceId, type TraceSink, traceparent } from './traces.js';
import { liveCommands } from './liveCommands.js';
import { type Case, dig, fillParams, interpolate, matcherOf, matches, type Scope, seeded, type Step, stepOf, type StepValue } from './format.js';

export type NativeMock = {
  result?: unknown;
  screen?: { title?: string; subtitle?: string; image?: string; buttons?: Record<string, unknown> };
  /** A native constant (`Module.name`) for both platforms: what the property reads as. `null` reads as null. */
  value?: unknown;
  /** The same for one platform; it wins over `value` there. */
  ios?: unknown;
  android?: unknown;
  /** The property does not exist on this platform (`true` for both, or the platforms listed): it reads as undefined. */
  absent?: boolean | ('ios' | 'android')[];
};

export type CasesConfig = {
  /** The folder of the file that declared this, set when the configuration is read. */
  base?: string;
  /**
   * What a host answers where the app reads native code it has not got, keyed `Module.method` (the native module's name, as
   * `NativeModules` has it) or `Module.name` for a constant: `value`, `ios`, `android` and `absent` set what the constant reads as, from the
   * host's start; `result` is what a call resolves with; `screen` puts up a stand-in page with a
   * `title`, an optional `subtitle` and `image` (a URI), and `buttons`, label to result, each pressable as
   * `#native-mock-<label>`. Sent to the app at the start of every case; a step changes it with
   * `app.call: { command: nativeMocks, params: { set: { … } } }`, and `null` takes a key's mock away.
   */
  nativeMocks?: Record<string, NativeMock | null>;
  /** Where cases live (default `cases`). */
  dir?: string;
  /**
   * Where a case must pass for the project, checked with `case run --on targets` and run by `lynkeus ci`: `headless`,
   * `fastsim:ios`, `fastsim:android`, `ios` (the app on the iOS Simulator or an iPhone), `android` (the app on the
   * Android emulator or a phone). A case's own `targets:` frontmatter replaces it for that case.
   */
  targets?: string[];
  /** Where the flows a case runs live (default `flows`). */
  flows?: string;
  /** The long-lived command that answers fixture steps, as JSON lines. */
  fixtures?: FixturesConfig;
  /** The fixture `assert` reads the backend through (default `inspect`). */
  inspect?: string;
  /** `{ "user": "user_id" }` turns `user: u` into `user_id: <u.user_id>`, and gives a step that names no user the latest one. */
  refs?: Record<string, string>;
  /** Steps this project adds: `{ "app.login": [...] }`. Inside, `{{param.x}}` is what the case passed. */
  /** The screen a case begins on, for drafts (`case new`): the first the app shows a signed-in person, say. */
  start?: string;
  macros?: Record<string, unknown[]>;
  /** What the app may put in the way of a step and the steps that get past it; a step whose own words match `unless` is about it, and is left alone. */
  interruptions?: { see: string; do: unknown[]; unless?: string }[];
  /**
   * What the backend told its own analytics while a step ran, for a report: after each app step the fixture is
   * asked with `{ since }` (the step's start, ISO) and answers `{ events: [{ name | event, props | payload,
   * provider? }] }`. `provider` names the service when the fixture does not (an Olympus that sends to Mixpanel).
   */
  serverEvents?: { fixture: string; provider?: string };
  /** The service the app's own event list feeds (its `events` command), so a report names it instead of "App". */
  appEvents?: { provider: string };
  /** How long a step that names no `timeoutMs` may run before it fails as stuck (default 180000); one that names one gets it plus 30 s. */
  stepCeilingMs?: number;
};

/** What a host's analytics capture saw a step send: the SDK it went to and the event. */
/** `via`: the SDK's native module (a host that stands in for it), the request it sent, or the backend's own analytics. */
export type SentEvent = { provider: string; name: string; props?: Record<string, unknown>; via?: 'sdk' | 'network' | 'server' };

/** `unsupported`: the host the case ran on has no such thing to do (it answered "Unknown method" for the step), which says nothing about the app. */
export type StepReport = {
  step: string;
  status: 'passed' | 'failed' | 'skipped' | 'unsupported';
  ms: number;
  error?: string;
  /** A frame of the screen once the step was done, an absolute path. */
  screenshot?: string;
  /** The second of the case's film at which the step began. */
  videoS?: number;
  /** What the step made the app send its analytics SDKs, where the host captures them. */
  sent?: SentEvent[];
  /** What the backend did for it, from the traces it exported to the run. */
  backend?: BackendSpan[];
  /** The requests the app sent while it ran, with headers and bodies (secrets hidden), when the run keeps evidence. */
  requests?: RequestRecord[];
  /** What the app printed while it ran: its console and the errors it did not catch, when the run keeps evidence. */
  logs?: LogLine[];
  /** The screen the app was on when the step ended, when the run collected routes. */
  route?: string;
  /** On a failed `app.see` or `app.wait` for a target: the whole listing, the scrolls made and what the target was last seen as. */
  looked?: RunLooked;
  /** Where its time went, in ms (see `RunStepPhase`); what is left of `ms` is the runner's own work. */
  phases?: Partial<Record<StepPhase, number>>;
};

/** A line the app printed: `at` in ms since the epoch, `source` where it came from (`js`, `native`, `host`). */
export type LogLine = { at: number; level: 'debug' | 'info' | 'warn' | 'error'; source: string; text: string; stack?: string };
export type CaseReport = {
  id: string;
  title?: string;
  file: string;
  /** `unsupported`: a step could not be done on this host, so the case proved nothing here; it did not fail. */
  result: 'passed' | 'failed' | 'unsupported';
  ms: number;
  steps: StepReport[];
  /**
   * What a reader needs before the steps: what the case proves (`description`), why it matters (`why`), what
   * has to be true when it starts (`given`), the ticket it covers and the outcome it expects. From its frontmatter.
   */
  about?: { description?: string; why?: string; given?: string; ticket?: string; expected?: string };
  /** When a step failed: the screen, the requests since the mark, and why. */
  evidence?: { screen?: string; requests?: string[]; why?: string };
  /** What the app told its analytics, each with the step that caused it, when the run asked for it. */
  events?: RunEvent[];
  /** The native properties the app read that this host could not answer, when it says (`nativeValues`). */
  nativeValues?: RunNativeValue[];
  /** The case's film, an absolute path, where the host films. */
  video?: string;
  /** Every screen the app went through while the case ran, when the run asked for them (`routes`). */
  routes?: string[];
  /** Why it failed, read as rules from the screen, the requests and the trace (`lynkeus why`). */
  diagnosis?: string[];
  /** What the run noticed that does not change the result: a teardown step that failed, a mock nothing asked for, a relaunch before the first step. */
  warnings?: string[];
};

/** Where a case keeps what it can show of itself: a frame per step, a film. Each is taken only where the host can. */
/** `frames`: AVIF (lossy: a fifth of a PNG's bytes where the host writes it, about 4 % where the CLI encodes a simulator's PNG), or PNG, exact, for frames two runs are compared by. */
export type Evidence = {
  dir: string;
  screenshots?: boolean;
  settleMs?: number;
  /** Wait for the screen to stand still: two frames alike this many ms apart, on a host's own clock where it offers
   * that (`still`), or taken again on a device. */
  stillMs?: number;
  /** A looking step on an unchanged screen shares the last frame instead of taking one. With `stillMs` (a comparison run)
   * the `app.see` steps right after a step run before that step's settle and picture, which they then share: a
   * toast the step shows is still there to be seen, where a settle of a second or two first would have lost it. */
  onChange?: boolean;
  frames?: 'avif' | 'png';
  video?: { fps: number; scale?: number };
};

// A host that could not write AVIF once (an older one) is asked for PNG from then on.
let avifRefused = false;

export type RunOptions = {
  base: Base;
  /** Where the backend's traces arrive during the run: each app step's requests carry its id. */
  traces?: TraceSink;
  config: CasesConfig;
  fixtures?: Fixtures;
  dry?: boolean;
  events?: boolean;
  evidence?: Evidence;
  /** The run keeps a run folder (`--out`): each step's requests with bodies and the app's console go into it, frames or not. */
  keep?: boolean;
  log?: (line: string) => void;
  /** The case's setup, already run by `case prepare`: the case starts from here. */
  prepared?: Prepared;
  /** Run only the setup and hand what it left to `keep`, for a case that will run later. */
  setupOnly?: { keep: (prepared: Prepared) => void };
  /** Keep running a case's steps after one fails, to see everything that is wrong in one pass. */
  continue?: boolean;
  /** The run's seed, from `--seed` or the config; `LYNKEUS_SEED` when absent. */
  seed?: string;
  /** Each step as it starts and as it ends, for a run's progress: where it is in the case and the section it is in. */
  onStep?: (step: StepProgress) => void;
  /** Collect the screens the app went through, for a coverage map. `fresh`: the app was started for this case. */
  routes?: boolean | 'fresh' /** The app's native log on a simulator or an emulator, read step by step into each step's logs. */;
  nativeLogs?: { take: () => LogLine[] };
  /**
   * The run started the host the app runs in (`--host`, `--host-command`): a frame comes from that host or not at
   * all, since simctl or adb would photograph some other device.
   */
  ownHost?: boolean;
  /** Aborted when the run is stopped: no step after it starts, and the case ends without its teardown. */
  signal?: AbortSignal;
  /**
   * Starts the app again the way the run starts it for a fresh case, where the run started the host itself (a host
   * per case, a kept host): `app.relaunch` and the relaunch before a covered first step use it instead of their own.
   */
  relaunch?: () => Promise<void>;
  /**
   * Mounts the app again in the process the run keeps for the job (a kept headless host), as the reset between cases
   * does: `app.relaunch` tries it before `relaunch` and starts the host again only when it answers false.
   */
  remount?: () => Promise<boolean>;
};

/**
 * A step starting (no `status`) or ended: its place among the steps the case runs (`index` from 0 of `steps`), the
 * part of the case it is in, and the numbered section of the steps it falls under.
 */
export type StepProgress = {
  index: number;
  steps: number;
  section: 'setup' | 'steps';
  heading?: string;
  step: string;
  status?: StepReport['status'];
  ms?: number;
};

/** What a case's setup leaves for its steps: the aliases and what they answered, and what ran. */
export type Prepared = { scope: Scope; latest: Record<string, unknown>; ran: string[]; steps: StepReport[] };

/** A setup made only of the project's fixtures can run before the case, with no app attached. */
export const preparable = (c: Case, config: CasesConfig): boolean =>
  c.setup.length > 0 &&
  c.setup.every((step) => !step.on && !step.verb.startsWith('app.') && !config.macros?.[step.verb] && step.verb !== 'exec' && step.verb !== 'assert');

/** What a buffer holds that it did not before, whichever end it grows from. */
export const newSince = (before: AppEvent[], now: AppEvent[]): AppEvent[] => {
  if (now.length < before.length) return now;
  if (now.length === before.length) return [];
  const same = (a: AppEvent[], b: AppEvent[]) => JSON.stringify(a) === JSON.stringify(b);
  const extra = now.length - before.length;
  if (same(now.slice(0, before.length), before)) return now.slice(before.length);
  if (same(now.slice(extra), before)) return now.slice(0, extra).reverse();
  return now;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The phases a step spent time in, in the order they happen; none when it spent none. */
const phased = (phases: Partial<Record<StepPhase, number>>): Pick<StepReport, 'phases'> => {
  const spent = Object.entries(phases).filter(([, ms]) => ms > 0);
  return spent.length > 0 ? { phases: Object.fromEntries(spent) } : {};
};

/** How a case's warnings start for a frame that shows something other than the app; `evidence` lists them. */
export const FRAME_NOT_APP = 'frame not of the app';
/** How a case's warnings start for a frame taken while the host's screen still moved after the step; `evidence` lists them. */
export const FRAME_MOVING = 'frame of a moving screen';
/** How a case's warnings start when it was asked for a film and kept none that plays. */
export const NO_FILM = 'no film';

// Below this a step's time needs no explaining in the console; the run's files keep its phases either way.
const SLOW_STEP_MS = 500;
// A step that spends longer than this finding its target is said in the case's warnings, passed or not: the time is
// usually a target that is never listed or never clear (a point on an overlay, a control the keyboard covers).
export const SLOW_TARGET_MS = 3000;

/** The warning for a step whose target took long to find, or undefined. */
export const slowTargetNote = (step: Pick<StepReport, 'step' | 'phases'>): string | undefined => {
  const ms = step.phases?.target ?? 0;
  if (ms <= SLOW_TARGET_MS) return undefined;
  return `${step.step}: ${(ms / 1000).toFixed(1)} s finding its target (listed, in the window, clear and still); a testID or a shorter timeoutMs makes it fast, a target that never clears is said by \`guide evidence slow-step\``;
};

/** `: action 380 · settle 120`, for a step slow enough to ask where its time went. */
export const phaseNote = (step: Pick<StepReport, 'ms' | 'phases'>): string => {
  if (step.ms < SLOW_STEP_MS || !step.phases) return '';
  const parts = Object.entries(step.phases).map(([phase, ms]) => `${phase} ${ms}`);
  return parts.length > 0 ? `: ${parts.join(' · ')}` : '';
};

/**
 * A host on another machine (fastsim in a Linux VM or on a server) films there: the path it was given is this
 * machine's. Its stop says how big the film is, and `record { read }` hands it over a piece at a time. Nothing here
 * may fail the case: a film that does not arrive is left out of the report.
 */
export const fetchFilm = async (d: Pick<Device, 'command'>, film: string, bytes: number): Promise<boolean> => {
  const part = `${film}.part`;
  try {
    const out = fs.openSync(part, 'w');
    try {
      for (let offset = 0; offset < bytes; ) {
        const piece = (await d.command('record', { read: offset })) as { data?: unknown; done?: unknown } | undefined;
        const data = typeof piece?.data === 'string' ? Buffer.from(piece.data, 'base64') : Buffer.alloc(0);
        if (data.length === 0) break;
        fs.writeSync(out, data);
        offset += data.length;
        if (piece?.done === true) break;
      }
    } finally {
      fs.closeSync(out);
    }
    if (fs.statSync(part).size !== bytes) throw new Error('short film');
    fs.renameSync(part, film);
    return true;
  } catch {
    fs.rmSync(part, { force: true });
    return false;
  }
};
const run = promisify(exec);

// A step that outlives its own timeout by this much is stuck, not slow: the app or its host stopped answering mid-step.
export const STEP_MARGIN_MS = 30_000;
// A step that names no timeout: the longest wait Lynkeus itself makes in one (a host started again for a relaunch, an
// exec) is 120 s. In trial 7 a stuck `app.fresh` ran 31 minutes and an `app.openDemo` 862 s.
export const STEP_CEILING_MS = 180_000;

/** How long one step may run before it is given up: its own `timeoutMs` and a margin, else the project's ceiling or 180 s. */
export const stepCeilingMs = (value: unknown, ceiling: number = STEP_CEILING_MS): number => {
  const own = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>).timeoutMs : undefined;
  return typeof own === 'number' && Number.isFinite(own) ? Math.max(own + STEP_MARGIN_MS, 0) : ceiling;
};

export const label = (step: Step): string => {
  const value = step.value;
  if (value === null || value === undefined) return step.verb;
  const text =
    typeof value === 'object'
      ? Object.entries(value)
          .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
          .join(', ')
      : String(value);
  return `${step.verb} ${text}`.slice(0, 140);
};

const FLAG_NAMES: Record<string, string> = {
  within: 'in',
  advanceMs: 'advance',
  timeoutMs: 'timeout',
  delayMs: 'delay',
  durationMs: 'duration',
  holdMs: 'hold',
};

/** `wait` holds when the case passed it; `method=phone` when it passed that value. */
const holds = (condition: string, param: Record<string, unknown>, ran: Set<string> = new Set()): boolean => {
  if (condition.startsWith('ran:')) return ran.has(condition.slice(4));
  const [name, value] = condition.split('=', 2);
  const given = param[name!];
  if (value !== undefined) return String(given) === value;
  return given !== undefined && given !== null && given !== false && given !== 'none';
};

/** A step's value as the argv of the command it names: what matches a positional by name goes in place, the rest are flags. */
// A target a case writes as an object (`{ testId: a }`, `{ text: "Done", nth: 1 }`) in the CLI's own spelling.
const targetArg = (item: unknown): string => {
  if (typeof item !== 'object' || item === null) return String(item);
  const t = item as { testId?: unknown; text?: unknown; nth?: unknown };
  const nth = typeof t.nth === 'number' ? `[${t.nth}]` : '';
  if (typeof t.testId === 'string' && t.text === undefined) return `#${t.testId}${nth}`;
  if (typeof t.text === 'string' && t.testId === undefined) return `"${t.text}"${nth}`;
  throw new Error(`a target in a list is a string, { testId } or { text }: ${JSON.stringify(item)}`);
};

/**
 * `known` says whether a bare capitalized word is a route the app has: with an explicit `target:` key, one that is not
 * is a text (`app.wait: { target: TextField }`), where a bare scalar step value stays a route.
 */
export const argvFor = (command: Command, value: StepValue, known?: (route: string) => boolean): string[] => {
  const argv = command.name.split(' ');
  if (value === null || value === undefined) return argv;
  if (typeof value === 'string' && command.flags?.[value]?.type === 'boolean') return [...argv, `--${value}`];
  if (typeof value !== 'object' || Array.isArray(value)) return [...argv, ...(Array.isArray(value) ? value.map(String) : [String(value)])];
  const given = { ...(value as Record<string, unknown>) };
  const positionals = command.positionals ?? [];
  if (known && typeof given.target === 'string' && isRoute(given.target) && !given.target.startsWith('route:') && !known(given.target))
    given.target = `"${given.target}"`;
  // A case names a control by `testId` wherever a command takes a target (`wait` calls its own `what`).
  if ('testId' in given && !('target' in given) && !('testId' in (command.flags ?? {})) && positionals.some((p) => p.name === 'target' || p.name === 'what')) {
    given.target = `#${String(given.testId)}`;
    delete given.testId;
  }
  // A case says `target` or `request` where a command may call its first argument something else.
  const first = positionals[0]?.name;
  for (const alias of ['target', 'request', 'route', 'url', 'state', 'text']) {
    if (first && !(first in given) && alias in given && !positionals.some((p) => p.name === alias) && !(alias in (command.flags ?? {}))) {
      given[first] = given[alias];
      delete given[alias];
      break;
    }
  }
  for (const p of positionals) {
    if (!(p.name in given)) {
      if (positionals.slice(positionals.indexOf(p) + 1).some((later) => later.name in given)) throw new Error(`${command.name} needs ${p.name}`);
      break;
    }
    const v = given[p.name];
    argv.push(typeof v === 'object' ? JSON.stringify(v) : String(v));
    delete given[p.name];
  }
  for (const [key, v] of Object.entries(given)) {
    const flag = FLAG_NAMES[key] ?? key;
    if (!(flag in (command.flags ?? {}))) throw new Error(`${command.name} has no ${key}`);
    if (v === false || v === undefined || v === null) continue;
    if (v === true) argv.push(`--${flag}`);
    else if (Array.isArray(v)) for (const item of v) argv.push(`--${flag}`, targetArg(item));
    else argv.push(`--${flag}`, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  return argv;
};

const presented = (screen: Screen): Element[] => screen.elements.filter((e) => !e.hidden || e.hidden === 'inert');
const textOf = (e: Element) => e.text ?? e.value ?? e.accessibilityLabel ?? '';
// Letter case aside, as the agent matches a target: a text drawn in capitals (`textTransform`) reads in capitals, and
// the words as the source writes them still find it.
/** What a failed `app.see` looked for, as `why` reads it: a step that failed on its own reading of the screen names no target otherwise. */
const soughtBy = (step: Step): Expected | undefined => {
  if (step.verb !== 'app.see') return undefined;
  const params = targetParams(step.value);
  if (params.absent === true) return undefined;
  const named = typeof params.target === 'string' ? parseTarget(params.target) : undefined;
  const text = typeof params.text === 'string' ? params.text : named && 'text' in named ? named.text : undefined;
  const testId = typeof params.testId === 'string' ? params.testId : named && 'testId' in named ? named.testId : undefined;
  const sought: Expected = {
    ...(text !== undefined ? { text } : {}),
    ...(testId !== undefined ? { testId } : {}),
  };
  return Object.keys(sought).length ? sought : undefined;
};

const says = (e: Element, text: string) => textOf(e).toLowerCase().includes(text.toLowerCase());

const MAX_SCROLLS_KEPT = 20;
const MAX_SIGHTINGS_KEPT = 8;

/** What a step that looks for something has seen so far; kept only for the step, reported only when it fails. */
type Trail = { startedMs: number; scrolls: RunScroll[]; scrollsTotal: number; seen: RunSighting[]; found: boolean; last?: string };

const NOT_IN_TREE = 'not in the tree';

/** Where a found element stands: in the window, outside it, hidden for a reason, covered or inert. */
const stateOf = (found: Element | null, window: { w: number; h: number }): string => {
  if (!found) return NOT_IN_TREE;
  const top = found.frame.y;
  const bottom = top + found.frame.h;
  const left = found.frame.x;
  const right = left + found.frame.w;
  const facts: string[] = [];
  if (top >= window.h) facts.push('below the window');
  else if (bottom <= 0) facts.push('above the window');
  else if (left >= window.w || right <= 0) facts.push('beside the window');
  else if (found.offscreen) facts.push('outside the window');
  else if (top < 0 || bottom > window.h) facts.push('cut by the window edge');
  if (found.hidden === 'inert') facts.push('inert');
  else if (found.hidden) facts.push(`hidden (${found.hidden})`);
  if (found.covered) facts.push('covered');
  return facts.join(', ') || 'on screen';
};

/**
 * An element the target names that the platform hides (a closed drawer's row, a screen behind another): the agent's
 * `find` passes over it, but it is in the tree, and the step's note says so as `why` does, not "never in the tree".
 */
const hiddenMatch = (screen: Screen, target: Target): Element | null => {
  const testId = 'testId' in target ? target.testId : undefined;
  const text = 'text' in target ? target.text.toLowerCase() : undefined;
  return (
    screen.elements.find(
      (e) =>
        e.hidden !== undefined &&
        e.hidden !== 'inert' &&
        ((testId !== undefined && e.testId === testId) ||
          (text !== undefined && ((e.text ?? '').toLowerCase() === text || (e.accessibilityLabel ?? '').toLowerCase() === text))),
    ) ?? null
  );
};

const fingerprint = (screen: Screen): string => JSON.stringify(presented(screen).map((e) => [e.testId, textOf(e), Math.round(e.frame.y)]));

const edgesOf = (screen: Screen): RunEdges => {
  const shown = presented(screen);
  const name = (e: Element) => `${e.testId ? `#${e.testId}` : textOf(e).slice(0, 40) || e.kind} @y=${Math.round(e.frame.y)}`;
  return { count: shown.length, ...(shown.length ? { first: name(shown[0]!), last: name(shown[shown.length - 1]!) } : {}) };
};

/** What a failed `see` says on top of what is missing: whether the target was ever in the tree, and where it was last. */
const sightingNote = (trail: Trail | undefined): string => {
  if (!trail) return '';
  const scrolls = trail.scrollsTotal ? `, after ${trail.scrollsTotal} scroll${trail.scrollsTotal === 1 ? '' : 's'}` : '';
  if (!trail.found) return ` (never in the tree${scrolls})`;
  const finally_ = trail.seen[trail.seen.length - 1]?.state;
  return ` (found, ${trail.last}${finally_ === NOT_IN_TREE ? ', then gone' : ''}${scrolls})`;
};

const requestMatches = (event: RequestRecord, wanted: string, status?: number): boolean => {
  if (event.status === undefined) return false;
  const [method, route] = wanted.includes(' ') ? wanted.split(/\s+/, 2) : ['*', wanted];
  let pathname = event.url;
  try {
    pathname = new URL(event.url).pathname;
  } catch {
    pathname = event.url.split('?')[0]!;
  }
  if (method !== '*' && event.method.toUpperCase() !== method!.toUpperCase()) return false;
  const normalizedPath = pathname.replace(/\/+$/, '') || '/';
  const normalizedRoute = route!.replace(/\/+$/, '') || '/';
  if (!normalizedPath.endsWith(normalizedRoute)) return false;
  return status === undefined ? true : event.status === status;
};

/**
 * Gives each step that ran the screen the app was on when it ended: the last one reached before the next step acted
 * (`actedAt`, a trace mark per step, absent for a step that only looked). A look keeps the screen it found.
 */
export const stepRoutes = (ran: StepReport[], actedAt: (number | undefined)[], reached: { seq: number; route: string }[]): void => {
  let bound = Number.POSITIVE_INFINITY;
  const bounds: number[] = [];
  for (let i = ran.length - 1; i >= 0; i--) {
    bounds[i] = bound;
    if (actedAt[i] !== undefined) bound = actedAt[i]!;
  }
  let current: string | undefined;
  let next = 0;
  for (const [i, step] of ran.entries()) {
    while (next < reached.length && reached[next]!.seq <= bounds[i]!) current = reached[next++]!.route;
    if (current && step.status !== 'skipped') step.route = current;
  }
};

const aboutOf = (c: Case): { about?: CaseReport['about'] } => {
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const about = Object.fromEntries(
    Object.entries({
      description: text(c.meta.description),
      why: text(c.meta.why),
      given: text(c.meta.given),
      ticket: text(c.meta.ticket),
      expected: c.expected,
    }).filter(([, v]) => v !== undefined),
  );
  return Object.keys(about).length ? { about } : {};
};

// Steps that look at the app rather than act on it: a request they wait for was caused by the action before them.
const LOOKING = new Set(['see', 'wait', 'event', 'requests', 'events']);
/** Steps whose effect reaches the screen through the platform, a render or more after they return. */
const ACTING = /^app\.(press|type|swipe|back|nav|deeplink)$/;

const BUILT_IN = ['press', 'type', 'swipe', 'see', 'requests', 'wait', 'nav', 'call', 'run', 'events', 'event', 'relaunch'];

/** A step's value as named parameters: a bare target (`"#save"`, or an index written as a number) is `target`. */
const targetParams = (value: StepValue): Record<string, unknown> =>
  typeof value === 'string' || typeof value === 'number'
    ? { target: String(value) }
    : value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};

/** How long after the app attached `app.call` waits for it to register a command it does not have yet: an app registers them as it starts. */
const REGISTRATION_MS = 5000;

const unknownStep = (step: Step, config: CasesConfig): string | undefined => {
  if (config.macros?.[step.verb] || !step.verb.startsWith('app.')) return undefined;
  const name = step.verb.slice(4);
  if (BUILT_IN.includes(name)) return undefined;
  const command = find(name) ?? find(`os ${name}`);
  if (!command) return `${step.verb} is not a step: Lynkeus has no command ${name}, and the project declares no macro for it`;
  try {
    argvFor(command, step.value);
  } catch (error) {
    return (error as Error).message;
  }
  return undefined;
};

const listStep = (step: Step, config: CasesConfig, within: string[]): string[] => {
  const macro = config.macros?.[step.verb];
  const problem = macro ? (within.includes(step.verb) ? `${step.verb} calls itself` : undefined) : unknownStep(step, config);
  const head = `${step.on ? `[on ${step.on}] ` : ''}${label(step)}${problem ? `  ✗ ${problem}` : ''}`;
  if (!macro || problem) return [head];
  const given = step.value && typeof step.value === 'object' && !Array.isArray(step.value) ? (step.value as Record<string, unknown>) : { value: step.value };
  const lines = [head];
  for (const raw of macro) {
    const entry = raw as Record<string, unknown>;
    const block = entry && typeof entry === 'object' && 'do' in entry;
    const when = block
      ? (['on', 'when', 'unless'] as const).filter((k) => k in entry).map((k) => `${k} ${(Array.isArray(entry[k]) ? entry[k] : [entry[k]]).join(', ')}`)
      : [];
    for (const inner of block ? (Array.isArray(entry.do) ? entry.do : [entry.do]) : [entry]) {
      let sub: Step;
      try {
        sub = stepOf(inner, `a step of ${step.verb}`);
      } catch (error) {
        lines.push(`  ↳ ✗ ${(error as Error).message}`);
        continue;
      }
      const [first = '', ...rest] = listStep({ ...sub, value: fillParams(sub.value, given) as StepValue }, config, [...within, step.verb]);
      lines.push(`  ↳ ${when.length ? `[${when.join('; ')}] ` : ''}${first}`, ...rest.map((l) => `    ${l}`));
    }
  }
  return lines;
};

/**
 * A case's steps as a dry run lists them: numbered as a run counts them, each macro opened into the steps it stands for
 * (its `{{param.*}}` filled with what the case passed), each `on`, `when` or `unless` named, and what cannot run marked ✗.
 */
export const expandSteps = (c: Pick<Case, 'setup' | 'steps' | 'teardown'>, config: CasesConfig): string[] => {
  let n = 0;
  const part = (name: string, list: Step[], numbered: boolean) =>
    list.length
      ? [
          `  ${name}:`,
          ...list.flatMap((step) => {
            const [first = '', ...rest] = listStep(step, config, []);
            const mark = numbered ? `${++n}.` : '-';
            return [`    ${mark} ${first}`, ...rest.map((l) => `    ${' '.repeat(mark.length + 1)}${l}`)];
          }),
        ]
      : [];
  return [...part('setup', c.setup, true), ...part('steps', c.steps, true), ...part('teardown', c.teardown, false)];
};

/**
 * The fixtures a case names that the project's server did not list. A macro's
 * own steps are the project's to keep right; these are the ones written in the case.
 */
export const missingFixtures = (c: Case, config: CasesConfig, known: string[]): string[] => {
  const names = [...c.setup, ...c.steps].flatMap((step) => {
    if (step.verb.startsWith('app.') || config.macros?.[step.verb] || step.verb === 'exec') return [];
    return [step.verb === 'assert' ? (config.inspect ?? 'inspect') : step.verb];
  });
  return [...new Set(names)].filter((name) => !known.includes(name));
};

/** What the app or its host answers to a method it does not have; the name is what it lacks. */
export const lacking = (message: string): string | undefined => /Unknown method (\S+)/.exec(message)?.[1];

/** A step this host cannot do for a reason of its own (no window to scroll out of), said as `this host has no <missing> (<why>)`. */
class HostLacks extends Error {
  constructor(
    readonly missing: string,
    readonly why: string,
  ) {
    super(`this host has no ${missing} (${why})`);
  }
}

// A request is read from the app at the end of the step after the one that sent it when it leaves at the very
// end of a step (a GET the app sends as an action finishes): its trace, carrying the step it left in, says where
// it belongs. Each request without a trace in its own step moves to the step whose trace served the same method
// and path at the same moment.
export const fileRequestsByTrace = (steps: StepReport[], spans: Map<string, { index: number; startedMs: number }>) => {
  const started = new Map([...spans.values()].map((v) => [v.index, v.startedMs]));
  const pathOf = (u: unknown) => {
    try {
      return new URL(String(u)).pathname;
    } catch {
      return String(u ?? '').split('?')[0]!;
    }
  };
  const roots = steps.flatMap((st, index) =>
    (st.backend ?? [])
      .filter((sp) => sp.depth === 0)
      .map((sp) => ({
        index,
        method: String(sp.attributes?.['http.method'] ?? sp.attributes?.['http.request.method'] ?? '').toUpperCase(),
        path: pathOf(sp.attributes?.['http.target'] ?? sp.attributes?.['url.path'] ?? ''),
        at: (started.get(index) ?? 0) + sp.at,
      })),
  );
  if (!roots.length) return;
  steps.forEach((st, index) => {
    const keep: RequestRecord[] = [];
    for (const q of st.requests ?? []) {
      const method = String(q.method).toUpperCase(),
        path = pathOf(q.url);
      const same = roots.filter((r) => r.method === method && r.path === path);
      const here = same.some((r) => r.index === index);
      const near = same
        .filter((r) => typeof q.startedAt === 'number' && Math.abs(r.at - q.startedAt) < 1500)
        .sort((a, b) => Math.abs(a.at - q.startedAt!) - Math.abs(b.at - q.startedAt!))[0];
      if (here || !near || near.index === index || !steps[near.index]) keep.push(q);
      else steps[near.index]!.requests = [...(steps[near.index]!.requests ?? []), q].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
    }
    if (st.requests) st.requests = keep.length ? keep : undefined;
    if (st.requests === undefined) delete st.requests;
  });
};

/** Why a case failed when it ended with another app in front of its app: this case, not the ones after it. */
export const leftOutside = (opened: string | undefined): string =>
  `this case left the app in the background${opened ? `: a press opened ${opened}` : ' (another app or a system screen is in front)'}; the next case brings it back to the front before it starts`;

export const runCase = async (c: Case, options: RunOptions): Promise<CaseReport> => {
  const { base, config } = options;
  const log = options.log ?? (() => undefined);
  let routesKnown: Set<string> | undefined;
  const isKnownRoute = (route: string): boolean => {
    if (!routesKnown) {
      routesKnown = new Set(screens.observed(lynkeusDir(base.root)).keys());
      try {
        for (const r of Object.keys(base.graph()?.screens ?? {})) routesKnown.add(r);
      } catch {
        // No route graph: only the routes observed so far count.
      }
    }
    return routesKnown.has(route);
  };
  const scope: Scope = structuredClone(options.prepared?.scope ?? {});
  seeded(scope, c.id, options.seed);
  const ran = new Set<string>(options.prepared?.ran ?? []);
  const latest: Record<string, unknown> = structuredClone(options.prepared?.latest ?? {});
  const started = Date.now();
  const steps: StepReport[] = [];
  const warnings: string[] = [];
  const warn = (line: string) => {
    warnings.push(line);
    log(`  ⚠ ${line}`);
  };
  // A host's film: a host started again for a relaunch is a new process, so the film so far is finished first (kept as
  // video.<n>.mp4) and a new one begins in video.mp4. `from` is the first step the film in video.mp4 holds.
  const hostFilm: { file?: string; on: boolean; from?: number; parts: string[]; start?: () => Promise<boolean> } = { on: false, parts: [] };
  let mark: number | undefined;
  // Where the trace stood as the last action began: a screen it led to that closes itself (a success screen) can
  // come and go while that step's frame settles or a wait for a request runs, and a wait for it still counts it.
  // Waits and looks change nothing, so they keep the mark of the action before them.
  let actedFrom: number | undefined;
  // With routes asked for, where the trace stood as each step first acted, by its place among the steps run: the
  // screens reached before the next one acted are where that step left the app. Read off marks the steps take anyway.
  const actedAt: (number | undefined)[] = [];
  let stepAt = -1;
  let lastFrame: { file: string; shape?: string } | undefined;
  // The app numbers its requests as they start. A step that looks for one counts only those started after the
  // action before it began: an earlier screen's request to the same path would otherwise pass for the one the
  // action caused. `app.requests` marks by hand, and holds until a step has looked for a request.
  let requestsAfter: number | undefined;
  let markedByHand = false;
  let why: string | undefined;
  let sought: Expected | undefined;
  const recorded: RunEvent[] = [];
  let buffer: AppEvent[] = [];
  // A host that records what each SDK was handed (fastsim, the headless host) already has every event. Asking the
  // app for its own list as well turns on the app's tracking debug, which may draw on the screen (a counter in
  // every frame of the film).
  let sdkRecorded = false;
  // Read, never emptied: a case may be asserting on the buffer.
  const collect = async (index: number) => {
    if (!options.events || sdkRecorded) return;
    const d = await base.device().catch(() => undefined);
    if (!d?.server.connected || away || unreachable(d.server)) return;
    const now = normalizeEvents(await d.command('events').catch(() => []));
    const route = (await d.screen().catch(() => undefined))?.route;
    const provider = config.appEvents?.provider;
    for (const e of newSince(buffer, now)) recorded.push({ ...e, step: index, route, ...(provider ? { provider } : {}) });
    buffer = now;
  };

  const device = () => base.device();
  // The current step's phases; a macro's steps add to the step that runs it.
  let phases: Partial<Record<StepPhase, number>> = {};
  const timed = async <T>(phase: StepPhase, work: () => Promise<T>): Promise<T> => {
    const started = Date.now();
    try {
      return await work();
    } finally {
      phases[phase] = (phases[phase] ?? 0) + Date.now() - started;
    }
  };
  // A phone's app in the background is suspended: its socket may stay open, but nothing answers, so every call to it
  // waits out its whole timeout (20 s). An app away that long meets its screen lock when it comes back.
  let away = false;
  let mocksSet = false;
  // The app's last request when the case set its first mock: what it asked for after that is what the mocks were for.
  let mockedFrom: number | undefined;
  const lastRequest = async (d: Device): Promise<number> => Math.max(0, ...(await d.requests()).requests.map((r) => r.id));
  const markRequests = async (d: Device, byHand = false): Promise<void> => {
    if (markedByHand && !byHand) return;
    requestsAfter = await lastRequest(d);
    markedByHand = byHand;
  };
  const requestsSinceMark = async (): Promise<RequestRecord[]> => {
    const d = await device();
    const { requests } = await d.requests(requestsAfter);
    // An app started again numbers its requests from 1.
    if (requests.length === 0 && requestsAfter && (await lastRequest(d)) < requestsAfter) requestsAfter = 0;
    return requests;
  };
  const cli = async (argv: string[], waited = false) => {
    const outcome = await execute(argv, waited ? { ...base, waited } : base);
    if (outcome.error || outcome.code !== 0) {
      why = outcome.why;
      throw new Error(outcome.error || outcome.text || `${argv.join(' ')} failed`);
    }
    return outcome;
  };

  const withRefs = (params: Record<string, unknown>): Record<string, unknown> => {
    const out = { ...params };
    for (const [param, field] of Object.entries(config.refs ?? {})) {
      const alias = out[param];
      delete out[param];
      if (typeof alias === 'string') {
        if (!(alias in scope)) throw new Error(`no alias '${alias}'`);
        const found = dig(scope[alias], field);
        if (found === undefined) throw new Error(`alias '${alias}' has no ${field}`);
        out[field] = found;
      } else if (!(field in out) && latest[field] !== undefined) out[field] = latest[field];
    }
    return out;
  };

  const fixture = async (name: string, value: StepValue): Promise<void> => {
    if (!options.fixtures) throw new Error(`${name} is not a step Lynkeus has, and the project declares no fixtures (cases.fixtures in lynkeus.config.json)`);
    const given = value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
    const as = typeof given.as === 'string' ? given.as : undefined;
    delete given.as;
    const answer = await options.fixtures.call(name, withRefs(given), c.id);
    if (as) scope[as] = answer;
    for (const field of Object.values(config.refs ?? {})) if (answer[field] !== undefined) latest[field] = answer[field];
  };

  // What the backend answered, until a step that can change it.
  const inspected = new Map<string, Record<string, unknown>>();

  const assert = async (value: StepValue): Promise<void> => {
    const params = (value ?? {}) as Record<string, unknown>;
    const matcher = matcherOf(params);
    if (!matcher || typeof params.path !== 'string') throw new Error('assert needs a path and a matcher (equals, includes, gte, …)');
    if (!options.fixtures) throw new Error('assert reads the backend through fixtures, and the project declares none');
    const rest = Object.fromEntries(Object.entries(params).filter(([k]) => k !== 'path' && !(k in matcher)));
    // `section` is the part of the answer the path reads: a server that works its answer out part by part
    // need only do that part. Asserts in a row on the same section read one answer.
    const ask = withRefs({ ...rest, section: params.path.split('.')[0] });
    const key = JSON.stringify(ask);
    let answer = inspected.get(key);
    if (!answer) {
      answer = await options.fixtures.call(config.inspect ?? 'inspect', ask, c.id);
      inspected.set(key, answer);
    }
    const got = dig(answer, params.path);
    if (!matches(got, matcher)) throw new Error(`${params.path} is ${JSON.stringify(got)}`);
  };

  const targetIn = (params: Record<string, unknown>): Target | undefined => {
    const raw = typeof params.target === 'string' ? params.target : params.testId ? `#${String(params.testId)}` : undefined;
    return raw === undefined ? undefined : scopedTarget(raw, { in: params.within, nth: params.nth });
  };

  let trail: Trail | undefined;
  const startTrail = (): Trail => (trail = { startedMs: Date.now(), scrolls: [], scrollsTotal: 0, seen: [], found: false });
  const note = (found: Element | null, window: { w: number; h: number }) => {
    if (!trail) return;
    const state = stateOf(found, window);
    if (state !== NOT_IN_TREE) {
      trail.found = true;
      trail.last = state;
    }
    if (trail.seen[trail.seen.length - 1]?.state === state) return;
    if (trail.seen.length === MAX_SIGHTINGS_KEPT) trail.seen.shift();
    trail.seen.push({ atMs: Date.now() - trail.startedMs, scrolls: trail.scrollsTotal, state });
  };

  /**
   * `contains: true`: the element whose own text holds the target's, ignoring case, where a target otherwise matches
   * a whole text. Inside `within`'s element when it names one; `nth` counts among those that hold it.
   */
  const containing = async (screen: Screen, target: Extract<Target, { text: string }>): Promise<Element | null> => {
    const d = await device();
    const scope = target.within ? ((await d.server.call('find', target.within)) as Element | null) : undefined;
    if (scope === null) return null;
    const inside = (e: Element) => {
      if (!scope) return true;
      for (let at: number | undefined = e.i; at !== undefined; at = screen.elements[at]?.parent) if (at === scope.i) return true;
      return false;
    };
    return presented(screen).filter((e) => inside(e) && says(e, target.text))[target.nth ?? 0] ?? null;
  };

  /** Every condition a `see` names, read off one screen and the trace since the mark; what is missing, or nothing. */
  const seen = async (params: Record<string, unknown>): Promise<string | undefined> => {
    const d = await device();
    const screen = await d.screen();
    const elements = presented(screen);
    if (typeof params.route === 'string' && screen.route !== params.route) return `on ${screen.route ?? 'no route'}, not ${params.route}`;
    if ('layer' in params) {
      const open = screen.presenting;
      const wanted = params.layer;
      const ok = wanted === true ? !!open : wanted === false ? !open : !!open && `${open.testId ?? ''}`.includes(String(wanted));
      if (!ok) return wanted === false ? 'a layer is open' : `no layer${wanted === true ? '' : ` ${String(wanted)}`} is open`;
    }
    const target = targetIn(params);
    const text = typeof params.text === 'string' ? params.text : undefined;
    if (target && params.contains === true && 'text' in target) {
      const found = await containing(screen, target);
      note(found, screen.window);
      if (!found) return `not on screen: ${JSON.stringify(target)} (inside any text)`;
    } else if (target) {
      const found = (await d.server.call('find', target)) as Element | null;
      note(found ?? hiddenMatch(screen, target), screen.window);
      if (!found || (found.hidden && found.hidden !== 'inert')) return `not on screen: ${JSON.stringify(target)}`;
      if (text !== undefined && !says(found, text) && !elements.some((e) => e.parent === found.i && says(e, text))) {
        return `${JSON.stringify(target)} says ${JSON.stringify(textOf(found))}, not ${JSON.stringify(text)}`;
      }
    } else if (text !== undefined && !elements.some((e) => says(e, text))) return `not on screen: ${JSON.stringify(text)}`;
    if (typeof params.request === 'string') {
      const status = typeof params.status === 'number' ? params.status : undefined;
      const made = (await requestsSinceMark()).filter((e) => requestMatches(e, params.request as string, status));
      if (made.length === 0) return `not requested since ${markedByHand ? 'the mark' : 'the step before began'}: ${params.request}`;
      // Made is not answered: a request that never got a response (status 0: no network, refused, aborted) passed this
      // check in trial run 10. It wants an answer unless the step names a status or says `answered: false`.
      if (status === undefined && params.answered !== false && !made.some((e) => (e.status ?? 0) > 0)) {
        const lost = made.at(-1)!;
        return `${params.request} was requested but got no answer (status 0${lost.error ? `: ${lost.error}` : ''}); a check that it was only sent says \`answered: false\`, one for a status names it (\`status: 500\`)`;
      }
      markedByHand = false;
    }
    if (typeof params.event === 'string') {
      const wanted = (params.props ?? params.properties ?? {}) as Record<string, unknown>;
      const events = normalizeEvents(await d.command('events'));
      const hit = events.some((e) => e.name === params.event && Object.entries(wanted).every(([k, v]) => String(e.props?.[k]) === String(v)));
      if (!hit) return `no ${params.event} event${Object.keys(wanted).length ? ` with ${JSON.stringify(wanted)}` : ''}`;
    }
    return undefined;
  };

  /**
   * A device, and a host that draws like one, lists what is in the window: what
   * a step looks for may be further down the page. This scrolls the window
   * itself, most of a screenful at a time, until `there` holds or the screen
   * stops changing; then back up in short pulls (at the top of a sheet a short
   * pull springs back, where a long one would drag the sheet shut).
   */
  const scrollTo = async (there: () => Promise<boolean>, upward = false, until?: number): Promise<boolean> => {
    const d = await device();
    if (!d.server.hello?.native) return false;
    const { w, h } = (await d.screen()).window;
    const x = Math.round(w / 2);
    const listing = async () => fingerprint(await d.screen());
    const pull = async (from: number, to: number, times: number, direction: RunScroll['direction']): Promise<boolean> => {
      let before: string | undefined;
      for (let i = 0; i < times; i++) {
        if (await there()) return true;
        if (until !== undefined && Date.now() > until) return false;
        const now = await listing();
        if (now === before) return false;
        before = now;
        const shown = trail ? await d.screen() : undefined;
        const edges = shown ? edgesOf(shown) : undefined;
        await execute(['swipe', '--from', `${x},${from}`, '--to', `${x},${to}`], base);
        await d.idle({ quietMs: 150, timeoutMs: 1500 }).catch(() => undefined);
        if (trail && edges) {
          trail.scrollsTotal += 1;
          if (trail.scrolls.length < MAX_SCROLLS_KEPT) {
            const now = await d.screen();
            // Moved is read off every element, not the two at the edges: a fixed header or tab bar stays put.
            trail.scrolls.push({
              atMs: Date.now() - trail.startedMs,
              direction,
              moved: fingerprint(now) !== fingerprint(shown!),
              before: edges,
              after: edgesOf(now),
            });
          }
        }
      }
      return there();
    };
    if (!upward && (await pull(Math.round(h * 0.75), Math.round(h * 0.3), 12, 'down'))) return true;
    if (until !== undefined && Date.now() > until) return there();
    const middle = Math.round(h * 0.5);
    return pull(middle, middle + 110, 30, 'up');
  };

  /** On a headless host, whether what an `absent` check names is still in the tree inside a list or scroll view. */
  const inListHeadless = async (params: Record<string, unknown>): Promise<boolean> => {
    const d = await device();
    if (d.server.hello?.native !== false) return false;
    const screen = await d.screen().catch(() => undefined);
    if (!screen) return false;
    const target = targetIn(params);
    const text = typeof params.text === 'string' ? params.text : undefined;
    const found = target
      ? ((await d.server.call('find', target).catch(() => null)) as Element | null)
      : text !== undefined
        ? presented(screen).find((e) => says(e, text))
        : undefined;
    for (let p = found?.parent; p !== undefined; p = screen.elements[p]?.parent) if (screen.elements[p]?.kind === 'scroll') return true;
    return false;
  };

  const see = async (value: StepValue): Promise<void> => {
    const params = targetParams(value);
    const absent = params.absent === true;
    startTrail();
    const given = typeof params.timeoutMs === 'number';
    const wait = given ? (params.timeoutMs as number) : 3000;
    const deadline = Date.now() + wait;
    // A step that names its own timeout is held to it, busy screen or not.
    const hard = given ? deadline : Date.now() + Math.max(wait, 12_000);
    // Where the listing is what the window shows, something missing gets three more looks before the
    // deadline counts: a short wait (it may be arriving), a scroll (it may be further down), and a long
    // wait (a carousel shows it a few seconds from now, and a host with its own clock gets there fast).
    const what = targetIn(params) ?? (typeof params.text === 'string' ? ({ text: params.text } as Target) : undefined);
    let looks = absent || !what || !(await device()).server.hello?.native ? 3 : 0;
    while (true) {
      await interrupted(value);
      const missing = await seen(params);
      if (absent ? missing !== undefined : missing === undefined) return;
      if (looks < 3 && what && missing?.startsWith('not on screen')) {
        const d = await device();
        looks += 1;
        // The agent's own wait matches a whole text: a part of one is looked for here, through the app's idle so a
        // host with its own clock still moves on.
        const arriving = async (timeoutMs: number) => {
          if (params.contains !== true) return void (await d.waitFor({ target: what, timeoutMs }).catch(() => undefined));
          const until = Date.now() + timeoutMs;
          while (Date.now() < until && (await seen(params)) !== undefined) await d.idle({ quietMs: 100, timeoutMs: 300 }).catch(() => sleep(150));
        };
        if (looks === 1) await arriving(given ? Math.min(1500, Math.max(0, deadline - Date.now())) : 1500);
        else if (looks === 2) {
          if (await scrollTo(async () => (await seen(params)) === undefined, false, given ? deadline : undefined)) return;
        } else {
          // A step that names its own timeout gets no more than what is left of it; one that does not may
          // wait for a carousel to come round.
          await arriving(given ? Math.max(0, deadline - Date.now()) : 20_000);
        }
        continue;
      }
      if (Date.now() > deadline && Date.now() < hard && (await (await device()).screen()).busy) {
        await sleep(150);
        continue;
      }
      if (Date.now() > deadline) {
        if (!absent) throw new Error(`${missing!}${targetIn(params) && missing!.startsWith('not on screen') ? sightingNote(trail) : ''}`);
        const { absent: _, ...what } = params;
        const named = label({ verb: '', value: what as StepValue }).trim();
        // Headless lays out every item of a list and scrolls nothing: what a device's window lost is still there.
        if (await inListHeadless(what)) {
          throw new HostLacks(
            'window',
            `headless renders every item of a list and scrolls none, so ${named} cannot leave the window here; check it on a device or FastSim`,
          );
        }
        throw new Error(`still on screen: ${named}`);
      }
      await sleep(150);
    }
  };

  const waitForRequest = async (params: Record<string, unknown>): Promise<void> => {
    const timeoutMs = typeof params.timeoutMs === 'number' ? params.timeoutMs : 10_000;
    const deadline = Date.now() + timeoutMs;
    const status = typeof params.status === 'number' ? params.status : undefined;
    while (true) {
      const events = await requestsSinceMark();
      const hit = events.some((e) => requestMatches(e, String(params.request), status) && (status !== undefined || String(e.status).startsWith('2')));
      if (hit) {
        markedByHand = false;
        return;
      }
      if (Date.now() > deadline) {
        if (status !== undefined) throw new Error(`no ${status} ${String(params.request)} within ${timeoutMs} ms`);
        const other = events.find((e) => requestMatches(e, String(params.request)) && e.status !== undefined);
        const answered = other ? `; it answered ${other.status}${other.error ? ` (${other.error})` : ''}` : '';
        throw new Error(
          `no 2xx ${String(params.request)} within ${timeoutMs} ms${answered} — a request wait wants a 2xx unless it names another: pass status to wait for that one`,
        );
      }
      await sleep(300);
    }
  };

  const press = async (value: StepValue): Promise<'skipped' | undefined> => {
    const given = targetParams(value);
    const { text, ...named } = given;
    const params: Record<string, unknown> = 'target' in given || 'testId' in given || typeof text !== 'string' ? given : { ...named, target: text };
    const target = targetIn(params);
    if (!target) throw new Error('app.press needs a target');
    const d = await device();
    if (params.optional === true) {
      // Decided once the app has gone quiet: what it presses (a one-time question, a promo) arrives a moment
      // after the screen before it, and a fast host gets here first.
      const there = await timed('target', async () => {
        await d.idle({ quietMs: 150, timeoutMs: 1000 }).catch(() => undefined);
        return d.waitFor({ target, timeoutMs: 300 }).then(
          () => true,
          () => false,
        );
      });
      if (!there) return 'skipped';
    }
    await timed('target', () => pressable(d, target, params));
    const { optional: _optional, timeoutMs: _timeout, ...rest } = params;
    try {
      const outcome = await timed('action', () => cli(argvFor(find('press')!, rest as StepValue, isKnownRoute), true));
      const part = (outcome.json as { part?: unknown } | undefined)?.part;
      if (typeof part === 'string') warn(`app.press ${part}: if that is not the one, write its whole label or its testID`);
    } catch (error) {
      // A one-time sheet can disappear between the presence check and the native press.
      if (params.optional === true && error instanceof Error && error.message.includes('No element matches')) return 'skipped';
      throw error;
    }
    return undefined;
  };

  /** Until the target is listed, in the window and clear of what covers it, and (by testId) enabled and still. */
  const pressable = async (d: Device, target: Target, params: Record<string, unknown>): Promise<void> => {
    // A point is where the case asked to press, whatever covers it: there is nothing to find, scroll to or wait for.
    if ('x' in target) return;
    // A step that names its own timeout is held to it in every wait below; one that does not keeps the defaults.
    const asked = typeof params.timeoutMs === 'number' ? (params.timeoutMs as number) : undefined;
    const given = asked === undefined ? undefined : Date.now() + asked;
    // Not listed at all: arriving, or further down a page that only lists its window. A short wait, then
    // a scroll, rather than spending the whole deadline on something that is below the fold.
    const listed = async () => !!(await d.server.call('find', target));
    if (!(await listed())) {
      await d.waitFor({ target, timeoutMs: Math.min(500, asked ?? 500) }).catch(() => undefined);
      if (!(await listed())) await scrollTo(listed, false, given);
    }
    // Listed, but scrolled out of the window, cut by its edge or under the header or tab bar (a page left
    // further down than the control): towards it, until it is clear.
    const outside = async (): Promise<'above' | 'below' | undefined> => {
      const found = (await d.server.call('find', target)) as Element | null;
      if (!found) return undefined;
      const { h } = (await d.screen()).window;
      // Covered near an edge is the screen's own header or tab bar over a scrolled page, not an overlay.
      const top = found.frame.y,
        bottom = found.frame.y + found.frame.h;
      if (top < 0 || (found.covered && top < h * 0.2)) return 'above';
      if (bottom > h || (found.covered && bottom > h * 0.8)) return 'below';
      return undefined;
    };
    const side = await outside();
    if (side) await scrollTo(async () => (await outside()) === undefined, side === 'above', given);
    // The control may still be disabled while what it depends on loads. The waits go through the app,
    // so a host with its own clock moves it on instead of standing still while this one sleeps.
    const deadline = given ?? Date.now() + 3000;
    const hard = given ?? Date.now() + 15_000;
    let was: string | undefined;
    while (Date.now() < hard && 'testId' in target) {
      const found = (await d.server.call('find', target)) as Element | null;
      // Covered or still moving is often for a moment (a screen or button sliding in, a sheet still
      // closing), and a press then lands on whatever covers it or where the control no longer is.
      const at = found ? JSON.stringify(found.frame) : undefined;
      // A control the keyboard covers stays covered until the press: the agent closes the keyboard before it
      // presses anything but a field, and measures again. Waiting for it to clear only ran out the deadline.
      const underKeyboard = async (e: Element) => e.kind !== 'input' && (await d.screen()).elements.some((x) => x.focused);
      // Still is two reads alike, a quiet window apart; a host that draws nothing has no transition to wait out, and
      // the agent's own press waits for the target to hold still anyway.
      const still = at === was || (at !== undefined && !helloOf(d)?.native);
      if (found?.enabled && still && (!found.covered || (await underKeyboard(found)))) break;
      was = at;
      if (Date.now() > deadline && !(await d.screen()).busy) break;
      await d.idle({ quietMs: 50, timeoutMs: 200 }).catch(() => undefined);
    }
  };

  const call = async (params: Record<string, unknown> | undefined): Promise<void> => {
    if (!params?.command) throw new Error('app.call needs a command');
    const d = await device();
    const deadline = Date.now() + (typeof params.timeoutMs === 'number' ? params.timeoutMs : 3000);
    const expect = (params.expect ?? {}) as Record<string, unknown>;
    // Only an app that has just attached may still be registering; one that attached long ago never will.
    const registeredBy = (d.attachedAt ?? 0) + REGISTRATION_MS;
    for (;;) {
      let answer: unknown;
      try {
        answer = await d.command(String(params.command), params.params);
      } catch (error) {
        // Right after a launch the app may not have registered its commands yet: an unknown one is asked for again
        // for a while, as a press waits for its control. A release bundle that never registers it says so at once.
        const message = error instanceof Error ? error.message : String(error);
        if (lacking(message) !== String(params.command) || message.includes('release bundle') || Date.now() > registeredBy) throw error;
        await d.idle({ quietMs: 100, timeoutMs: 300 }).catch(() => sleep(200));
        continue;
      }
      if (typeof params.as === 'string') scope[params.as] = answer;
      const miss = Object.entries(expect).find(([p, wanted]) => {
        const got = dig(answer, p);
        return wanted === null ? got !== undefined && got !== null : String(got) !== String(wanted);
      });
      if (!miss) return;
      if (Date.now() > deadline)
        throw new Error(`${String(params.command)}: ${miss[0]} is ${JSON.stringify(dig(answer, miss[0]))}, expected ${JSON.stringify(miss[1])}`);
      await sleep(250);
    }
  };

  // A host that keeps its own clock lets an animation finish before it answers. A phone runs on the
  // wall's and keeps moving after the last render, so only there is a pause worth its time; and a case's
  // `on: device` steps are written for that phone.
  // What the app said when it last attached: a phone's app sent to the background lets go of the driver, but the
  // host is the same kind it was, and a block's steps after that one are still its own.
  let lastHello: Device['server']['hello'] = null;
  const helloOf = (d: Device) => {
    lastHello = d.server.hello ?? lastHello;
    return lastHello;
  };
  const onWallClock = (d: Device) => {
    const hello = helloOf(d);
    return !!hello?.native && !hello.commands?.includes('clock');
  };

  let handling = false;
  const interrupted = async (value: StepValue): Promise<void> => {
    if (handling || !config.interruptions?.length) return;
    const d = await device();
    const about = JSON.stringify(value ?? '');
    for (const one of config.interruptions) {
      if (one.unless && new RegExp(one.unless, 'i').test(about)) continue;
      const target = parseTarget(one.see);
      const found = (await d.server.call('find', target).catch(() => null)) as Element | null;
      if (!found || found.hidden) continue;
      handling = true;
      try {
        await performAll(one.do);
      } catch (error) {
        const still = (await d.server.call('find', target).catch(() => null)) as Element | null;
        if (still && !still.hidden) throw error;
      } finally {
        handling = false;
      }
    }
  };

  const app = async (name: string, value: StepValue): Promise<'skipped' | undefined> => {
    const params = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
    const d = await device();
    // An app in the background has no connection to answer with: the step that brings it back must still run.
    const lastSeq = () =>
      away
        ? Promise.resolve(undefined)
        : d.trace().then(
            (t) => t.last,
            () => undefined,
          );
    await timed('marks', async () => {
      mark ??= await lastSeq();
      if (!LOOKING.has(name)) actedFrom = await lastSeq();
      if (options.routes && stepAt >= 0 && actedAt[stepAt] === undefined && !LOOKING.has(name)) actedAt[stepAt] = actedFrom;
      // An interruption handled inside a wait is not the action the wait is about.
      if (!away && ((!LOOKING.has(name) && !handling && macroDepth === 0) || requestsAfter === undefined)) await markRequests(d).catch(() => undefined);
    });
    switch (name) {
      case 'press': {
        await interrupted(value);
        const outcome = await press(value);
        // One touch, one render: the next step reads what this one caused.
        await timed('settle', () => d.idle({ quietMs: 50, timeoutMs: 400 }).catch(() => undefined));
        return outcome;
      }
      case 'type':
      case 'swipe': {
        await interrupted(value);
        // A field that arrives with its screen (a code input that mounts a moment after the keyboard) takes
        // what is typed only once it is there: under load that moment is longer than the step's own wait.
        const field = name === 'type' && params ? targetIn(params) : undefined;
        if (field)
          await timed('target', async () => {
            await d.waitFor({ target: field, timeoutMs: typeof params?.timeoutMs === 'number' ? params.timeoutMs : 5000 }).catch(() => undefined);
            // A device's field may still be sliding in with its screen; a host's is where it will be once it is listed.
            if (helloOf(d)?.native) await d.idle({ quietMs: 100, timeoutMs: 800 }).catch(() => undefined);
          });
        // A swipe's target still landing (a pager's page arriving, a sheet sliding in) reads as inert for a moment. The
        // agent waits for it too, but on a host with a virtual clock its wait runs out in no real time, so the wait
        // for the target to be presented happens here, on the wall clock, with the app moving on between looks.
        const swiped = name === 'swipe' && params ? targetIn(params) : undefined;
        if (swiped && 'testId' in swiped)
          await timed('target', async () => {
            const until = Date.now() + (typeof params?.timeoutMs === 'number' ? params.timeoutMs : 5000);
            while (Date.now() < until) {
              const found = (await d.server.call('find', swiped).catch(() => null)) as Element | null;
              if (found && found.hidden !== 'inert') break;
              await d.idle({ quietMs: 50, timeoutMs: 200 }).catch(() => undefined);
            }
          });
        const { timeoutMs: _timeout, ...typed } = params ?? {};
        await timed('action', () => cli(argvFor(find(name)!, name === 'type' && params ? (typed as StepValue) : value, isKnownRoute)));
        // A pager on a device keeps moving after the finger lifts, and swallows a swipe sent into that momentum.
        if (name === 'swipe' && onWallClock(d)) await timed('settle', () => d.idle({ quietMs: 700, timeoutMs: 8000 }).catch(() => undefined));
        return undefined;
      }
      case 'see':
        await timed('look', () => see(value));
        return undefined;
      case 'requests':
        mark = (await d.trace()).last;
        await markRequests(d, true);
        return undefined;
      case 'wait': {
        startTrail();
        if (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))) await timed('wait', () => sleep(Number(value)));
        else if (params?.request) await timed('wait', () => waitForRequest(params));
        else {
          const what = typeof value === 'string' ? value : String(params?.what ?? '');
          const since = isRoute(what) && actedFrom !== undefined ? { since: actedFrom } : {};
          if (config.interruptions?.length) {
            const asked: Record<string, unknown> = { ...(typeof value === 'string' ? { what: value } : (params ?? {})), ...since };
            const deadline = Date.now() + (typeof asked.timeoutMs === 'number' ? asked.timeoutMs : 10_000);
            for (;;) {
              await interrupted(value);
              const left = deadline - Date.now();
              const outcome = await timed('wait', () =>
                execute(argvFor(find('wait')!, { ...asked, timeoutMs: Math.max(Math.min(left, 1000), 100) } as StepValue, isKnownRoute), base),
              );
              if (!outcome.error && outcome.code === 0) break;
              if (Date.now() >= deadline) {
                why = outcome.why;
                throw new Error(outcome.error ?? outcome.text ?? 'wait failed');
              }
            }
          } else
            await timed('wait', () =>
              cli(
                argvFor(
                  find('wait')!,
                  'since' in since ? { ...(typeof value === 'string' ? { what: value } : (params ?? {})), ...since } : value,
                  isKnownRoute,
                ),
              ),
            );
          // A screen that just arrived on a device is still sliding in, which no render shows: a press then lands on the one it left.
          if (onWallClock(d) && isRoute(what)) await timed('settle', () => d.idle({ quietMs: 700, timeoutMs: 8000 }).catch(() => undefined));
        }
        return undefined;
      }
      case 'nav': {
        const route = leafOf(routeOf(typeof value === 'string' ? value : String(params?.route)), params?.params);
        await timed('action', () => cli(argvFor(find('nav')!, value)));
        // A navigator's own name is reached once the focused screen is inside it; an agent from before 0.7.7 only
        // compares the focused screen, so its timeout is checked against the path.
        await timed('wait', () =>
          d.waitFor({ route, timeoutMs: 8000 }).catch(async (error: unknown) => {
            const path = (await d.screen().catch(() => undefined))?.path;
            if (!path?.includes(route)) throw error;
          }),
        );
        await timed('settle', () => d.idle({ quietMs: 300, timeoutMs: 8000 }));
        return undefined;
      }
      case 'call':
        await timed('action', () => call(params));
        return undefined;
      case 'relaunch':
        log(`  ↺ ${await relaunch()}`);
        return undefined;
      case 'run': {
        const flow = typeof value === 'string' ? value : String(params?.flow);
        const file = path.isAbsolute(flow) ? flow : path.resolve(config.base ?? base.root, config.flows ?? 'flows', flow);
        const vars = Object.entries((params?.vars ?? {}) as Record<string, unknown>).flatMap(([k, v]) => ['--var', `${k}=${String(v)}`]);
        await cli(['run', file, ...vars]);
        return undefined;
      }
      case 'events':
        await collect(steps.length + 1);
        await d.command('events', { clear: true });
        buffer = [];
        return undefined;
      case 'event':
        await see({ ...(params ?? {}), event: typeof value === 'string' ? value : params?.name, name: undefined } as StepValue);
        return undefined;
      default: {
        const command = find(name) ?? find(`os ${name}`);
        if (!command) throw new Error(`app.${name} is not a step: Lynkeus has no command ${name}, and the project declares no macro for it`);
        if (name === 'mock') {
          mocksSet = true;
          if (mockedFrom === undefined) mockedFrom = await lastRequest(d).catch(() => undefined);
        }
        // A case's rule is the case's until it ends (the runner clears them before and after each case): an app reset
        // inside it (a sign-in macro calling the app's `reset`) must not drop it on a host, as it does not on a device
        // (trial run 12: headless lost the feed's mock to app.signedIn and the request went to the network).
        const kept =
          name !== 'mock'
            ? value
            : typeof value === 'string'
              ? ({ route: value, sticky: true } as StepValue)
              : value && typeof value === 'object' && !Array.isArray(value) && 'route' in value && !('sticky' in value)
                ? ({ ...value, sticky: true } as StepValue)
                : value;
        await timed('action', () => cli(argvFor(command, kept, isKnownRoute)));
        if (name === 'appstate') away = (params?.state ?? value) === 'background' && onWallClock(d);
        return undefined;
      }
    }
  };

  const shell = async (value: StepValue): Promise<void> => {
    const params = typeof value === 'string' ? { run: value } : ((value ?? {}) as Record<string, unknown>);
    // A stopped run takes its command down with it.
    const { stdout } = await run(String(params.run), { cwd: config.base ?? base.root, env: process.env, timeout: 120_000, signal: options.signal });
    if (typeof params.as !== 'string') return;
    const json = /\{[\s\S]*\}/.exec(stdout)?.[0];
    scope[params.as] = json ? JSON.parse(json) : { out: stdout.trim() };
  };

  /**
   * Starts the app again as a fresh case finds it: the host started again where the run started one for the case, the
   * app terminated and launched on a simulator or an emulator, and mounted again (`reset`) on a host it did not start.
   * The native mocks of the config are sent again; the case's own mocks went with the app on a device.
   */
  const relaunch = async (): Promise<string> => {
    let how: string;
    // The same process goes on, and so does its film.
    const remounted = !!options.remount && (await options.remount());
    if (remounted) how = 'mounted the app again (the host is kept for the run)';
    else if (options.relaunch) {
      if (hostFilm.on && hostFilm.file) {
        const file = hostFilm.file;
        const d = await device();
        const stopped = (await d.command('record', { stop: true }).catch(() => undefined)) as { bytes?: unknown } | undefined;
        if (!fs.existsSync(file) && typeof stopped?.bytes === 'number' && stopped.bytes > 0) await fetchFilm(d, file, stopped.bytes);
        const checked = checkFilm(file);
        clearFilmLeftovers(file);
        // Filmed before the case's first step started the host again, it is only the screen the case began on.
        if ('seconds' in checked && steps.length > 0) {
          const part = file.replace(/\.mp4$/, `.${hostFilm.parts.length + 1}.mp4`);
          fs.renameSync(file, part);
          hostFilm.parts.push(part);
        } else fs.rmSync(file, { force: true });
        hostFilm.on = false;
        hostFilm.from = steps.length;
      }
      await options.relaunch();
      how = 'started the host again';
    } else {
      const d = await device();
      if (onWallClock(d)) {
        await d.relaunch();
        how = 'relaunched the app';
      } else {
        await d.command('reset').catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          if (!/no command reset registered|Unknown method reset/.test(message)) throw error;
          throw new Error(
            'Unknown method relaunch (this host cannot start the app again by itself: run the case with host_command, which starts a host per case and again for a relaunch)',
          );
        });
        how = 'mounted the app again';
      }
    }
    away = false;
    requestsAfter = 0;
    const d = await device();
    // A remount in a kept host is the reset between cases, and takes its quiet: modules, fonts and i18n are loaded already.
    await d.idle({ quietMs: remounted ? 100 : 300, timeoutMs: 8000 }).catch(() => undefined);
    if (config.nativeMocks) await d.command('nativeMocks', { replace: config.nativeMocks }).catch(() => undefined);
    if (hostFilm.start && !hostFilm.on) hostFilm.on = await hostFilm.start();
    return how;
  };

  /** A host's film once stopped: fetched when the host is on another machine, then whether it plays (a warning when not). */
  const finishHostFilm = async (d: Device, file: string, stopped: { bytes?: unknown } | undefined): Promise<boolean> => {
    if (!fs.existsSync(file) && typeof stopped?.bytes === 'number' && stopped.bytes > 0) await fetchFilm(d, file, stopped.bytes);
    return keepFilm(file, checkFilm(file));
  };
  const keepFilm = (file: string, checked: ReturnType<typeof checkFilm>): boolean => {
    clearFilmLeftovers(file);
    if ('seconds' in checked) return true;
    fs.rmSync(file, { force: true });
    warn(`${NO_FILM}: ${checked.missing}`);
    return false;
  };

  // A macro is one step of the case: the requests it waits for are the ones it set off, from its first
  // action on, not only those of its last (`app.refresh` asks for a refresh, then waits for it to settle).
  let macroDepth = 0;
  const macro = async (steps: unknown[], value: StepValue): Promise<void> => {
    if (macroDepth === 0 && !handling) {
      const d = await device().catch(() => undefined);
      if (d) await markRequests(d);
    }
    macroDepth++;
    try {
      await runMacro(steps, value);
    } finally {
      macroDepth--;
    }
  };
  const runMacro = async (steps: unknown[], value: StepValue): Promise<void> => {
    const given = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : { value };
    // A parameter that names an alias is that alias: `as: u` makes `{{param.as.user_id}}` the user's.
    const param = Object.fromEntries(Object.entries(given).map(([k, v]) => [k, typeof v === 'string' && v in scope ? scope[v] : v]));
    const outer = scope.param;
    scope.param = param;
    try {
      await performAll(steps, param);
    } finally {
      scope.param = outer;
    }
  };

  /** A list of steps as a macro or an interruption writes them: a step, or a `do` block (one step or a list) under `when`, `unless` or `on`. */
  const performAll = async (steps: unknown[], param: Record<string, unknown> = {}): Promise<void> => {
    for (const raw of steps) {
      const entry = raw as Record<string, unknown>;
      if (entry && typeof entry === 'object' && 'do' in entry) {
        const all = (v: unknown) => (Array.isArray(v) ? v : [v]).map(String);
        if ('when' in entry && !all(entry.when).every((c) => holds(c, param, ran))) continue;
        if ('unless' in entry && all(entry.unless).some((c) => holds(c, param, ran))) continue;
        if ('on' in entry && !(await runsHere(String(entry.on)))) continue;
        for (const inner of Array.isArray(entry.do) ? entry.do : [entry.do]) await perform(stepOf(inner));
      } else await perform(stepOf(entry));
    }
  };

  /**
   * `device` (a Simulator, an emulator, a phone), `headless` (the app in Node), `fastsim` (a FastSim host), `host`
   * (either host), a platform, or `has:<command>` for a host whose app registered that command (a hosted build often
   * has commands a store build does not); `!` in front turns any of them around. One case then carries the way each
   * host does a thing, and runs on all of them.
   */
  const runsHere = async (on: string): Promise<boolean> => {
    if (on.startsWith('!')) return !(await runsHere(on.slice(1)));
    const hello = helloOf(await device());
    const phone = onWallClock(await device());
    if (on === 'device') return phone;
    if (on === 'host') return !phone;
    // A FastSim host draws natively, with real layout and frames: it is not the Node host a headless step is for.
    if (on === 'headless') return !phone && !hello?.native;
    if (on === 'fastsim') return !phone && !!hello?.native;
    if (on.startsWith('has:')) {
      const name = on.slice(4);
      const live = await liveCommands(await device(), hello);
      const held = !!live?.includes(name);
      // Said when it matters: the app answers otherwise than its hello did, or the command is not there.
      if (!held || live?.length !== hello?.commands?.length)
        log(
          `  ℹ️ has:${name} is ${held} (the hello listed ${hello?.commands?.length ?? 'no'} commands, the app now ${live?.length ?? 'no'}${hello?.commands?.includes(name) ? '' : `; the hello had no ${name}`})`,
        );
      return held;
    }
    return hello?.platform === on;
  };

  const perform = async (step: Step): Promise<'skipped' | undefined> => {
    if (step.on && !(await runsHere(step.on))) return 'skipped';
    ran.add(step.verb);
    if (!['assert', 'app.see', 'app.wait'].includes(step.verb)) inspected.clear();
    const value = interpolate(step.value, scope);
    const custom = config.macros?.[step.verb];
    if (custom) {
      await macro(custom, value);
      return undefined;
    }
    return bounded(step, value, async () => {
      if (step.verb.startsWith('app.')) return app(step.verb.slice(4), value);
      if (step.verb === 'assert') return void (await assert(value));
      if (step.verb === 'exec') return void (await shell(value));
      return void (await fixture(step.verb, value));
    });
  };

  // A step ends by its ceiling or by the run being stopped, whatever it waits on: a run that is cancelled or stuck
  // would otherwise sit in one step for as long as that wait lasts. A macro's own steps are each held to theirs.
  const bounded = <T>(step: Step, value: unknown, work: () => Promise<T>): Promise<T> => {
    const signal = options.signal;
    if (signal?.aborted) return Promise.reject(new Error(`stopped (${String(signal.reason ?? 'the run was stopped')}) before this step`));
    const ms = stepCeilingMs(value, typeof config.stepCeilingMs === 'number' ? config.stepCeilingMs : undefined);
    return new Promise<T>((resolve, reject) => {
      const own = typeof (value as { timeoutMs?: unknown } | null | undefined)?.timeoutMs === 'number';
      const seconds = ms < 10_000 ? (ms / 1000).toFixed(1) : String(Math.round(ms / 1000));
      // On the wall clock, whatever clock the app's waits run on (a test's virtual one).
      const timer = wallTimer(
        () =>
          reject(
            new Error(
              `${label(step)}: still running after ${seconds} s (${own ? `its timeoutMs and ${STEP_MARGIN_MS / 1000} s` : 'the step ceiling, cases.stepCeilingMs'}), so it was given up: the app or its host stopped answering`,
            ),
          ),
        ms,
      );
      const stop = () => reject(new Error(`stopped (${String(signal?.reason ?? 'the run was stopped')}) during this step`));
      signal?.addEventListener('abort', stop, { once: true });
      work()
        .then(resolve, reject)
        .finally(() => {
          clearWallTimer(timer);
          signal?.removeEventListener('abort', stop);
        });
    });
  };

  // A case before this one may have left the app behind another app (a link it opened): every step of this one would
  // wait out its whole timeout on an app that answers nothing. Known from what the app said last, at no cost.
  if (!options.dry) {
    const d = await base.device().catch(() => undefined);
    if (d?.inBackground) {
      await d.foreground().then(
        (how) =>
          log(
            `  ↺ the app was in the background, left there before this case: brought it back to the front${how === 'relaunched' ? ' by relaunching it' : ''}`,
          ),
        (error: unknown) => log(`  ⚠ the app is in the background and could not be brought back: ${error instanceof Error ? error.message : String(error)}`),
      );
    }
  }

  // A view the app did not draw over it before the first step (iOS's Save Password prompt after the case before signed
  // in, an alert that case left open) would fail every press of this one: the case starts on a fresh launch instead.
  // Only a phone's app outlives the case before it; a host has no other process to draw over it.
  if (!options.dry && !options.setupOnly && !options.signal?.aborted) {
    const d = await base.device().catch(() => undefined);
    const phone = d?.server.connected && !unreachable(d.server) && onWallClock(d);
    const covered = phone
      ? await d.screen().then(
          (sc) => sc.system,
          () => undefined,
        )
      : undefined;
    if (covered) {
      const said = await relaunch().then(
        async (how) => {
          const again = await (await device()).screen().then(
            (sc) => sc.system,
            () => undefined,
          );
          return `a view the app did not draw covered it before the first step (a system prompt or alert left from before): ${how}${again ? '; it is there again, so the launch itself shows it: answer it in the case' : ''}`;
        },
        (error: unknown) =>
          `a view the app did not draw covers it before the first step, and starting it again failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      warn(said);
    }
  }

  if (options.events && !options.dry) {
    const d = await base.device().catch(() => undefined);
    sdkRecorded = !!d?.server.hello?.commands?.includes('analytics');
    if (d?.server.connected && !sdkRecorded) buffer = normalizeEvents(await d.command('events').catch(() => []));
  }

  const evidence = options.dry ? undefined : options.evidence;
  const offers = async (command: string) => !away && !!(await base.device().catch(() => undefined))?.server.hello?.commands?.includes(command);
  const film = evidence?.video && (await offers('record')) ? path.join(evidence.dir, 'video.mp4') : undefined;
  // Asked when the run keeps events or a report: it is a call per step.
  const capturing = !options.dry && (!!options.events || !!options.evidence) && (await offers('analytics'));
  if (evidence) fs.mkdirSync(evidence.dir, { recursive: true });
  const keeping = !options.dry && (!!evidence || !!options.keep);
  // A simulator or emulator the app runs on, as against a host that films itself: its OS films it (simctl, screenrecord).
  let osFilm: Recording | undefined;
  if (evidence?.video && !film && !options.ownHost) {
    const d = await device().catch(() => undefined);
    if (d && onPhone(d.server))
      osFilm = await d.recordVideo(path.join(evidence.dir, 'video.mp4')).catch((error: unknown) => {
        warn(`${NO_FILM}: the device's recorder did not start (${error instanceof Error ? error.message : String(error)})`);
        return undefined;
      });
  }
  if (film && evidence?.video) {
    const video = evidence.video;
    hostFilm.file = film;
    // A host that films at one size only ignores the scale.
    hostFilm.start = async () =>
      (await device()).command('record', { path: film, fps: video.fps, ...(video.scale ? { scale: video.scale } : {}) }).then(
        () => true,
        (error: unknown) => {
          warn(`${NO_FILM}: the host would not start one (${error instanceof Error ? error.message : String(error)})`);
          return false;
        },
      );
    hostFilm.on = await hostFilm.start();
  }
  // What the app sent before the case began is not the case's.
  if (capturing) await (await device()).command('analytics', { take: true }).catch(() => undefined);
  // The same for what it printed.
  const logging = keeping && (await offers('logs'));
  if (logging) await (await device()).command('logs', { take: true }).catch(() => undefined);
  options.nativeLogs?.take();
  // A report shows what each request sent and got: the app keeps headers and bodies only while this case runs.
  let requestsSeen: number | undefined;
  // Requests filed while still waiting for an answer: read again later and completed where they were filed.
  const inFlight = new Map<number, RequestRecord>();
  const answered = (r: RequestRecord) => r.status !== undefined || !!r.error;
  const completeInFlight = async (d: Device) => {
    if (!inFlight.size) return;
    const again = await d.requests(Math.min(...inFlight.keys()) - 1).then(
      (r) => r.requests,
      () => [],
    );
    for (const r of again) {
      const kept = inFlight.get(r.id);
      if (kept && answered(r)) {
        Object.assign(kept, r);
        inFlight.delete(r.id);
      }
    }
  };
  // Frames the host is still encoding: the case waits for them before it says it is done.
  const encoding: string[] = [];
  // Frames a simulator or emulator gave as PNG, being encoded again as AVIF while the case goes on.
  const compacting: Promise<void>[] = [];
  if (keeping && (await offers('networkBodies'))) {
    const d = await device();
    await d.command('networkBodies', { on: true }).catch(() => undefined);
    requestsSeen = await d.requests().then(
      (r) => r.requests.at(-1)?.id ?? 0,
      () => undefined,
    );
  }
  const frameAt = async (): Promise<number | undefined> => {
    if (osFilm) return Math.max(0, Math.round((Date.now() - osFilm.startedAt) / 10) / 100);
    if (!hostFilm.on || !evidence?.video) return undefined;
    const answer = (await (await device()).command('record', { frames: true }).catch(() => undefined)) as { frames?: number } | undefined;
    return typeof answer?.frames === 'number' ? Math.round((answer.frames / evidence.video.fps) * 100) / 100 : undefined;
  };
  // A touch reaches the app through the platform, and what it renders can come after the step has returned: a frame
  // taken once the app is merely quiet then shows the screen from before the step. Waiting for a commit past the one
  // the step began on makes the frame the step's; a step that rendered nothing takes the quiet screen instead.
  const idleAfter = async (d: Device, quietMs: number, before: number | undefined): Promise<boolean> => {
    const timeoutMs = Math.max(1000, quietMs * 4);
    if (before !== undefined) {
      const after = await d.idle({ quietMs, timeoutMs, after: before }).catch(() => undefined);
      if (after?.idle) return true;
      if (after && after.commit > before) return false;
    }
    return d.idle({ quietMs, timeoutMs }).then(
      (r) => r.idle,
      () => false,
    );
  };
  // What a step leaves for a report: the frame after it and what it sent. Nothing here may fail the case.
  const record = async (report: StepReport, index: number, startedAt: number | undefined, begunMs: number, commitBefore?: number) => {
    if (startedAt !== undefined) report.videoS = startedAt;
    if (config.serverEvents && options.fixtures) {
      const { fixture: name, provider } = config.serverEvents;
      const answer = await options.fixtures.call(name, { since: new Date(begunMs).toISOString() }, c.id).catch(() => undefined);
      const list = Array.isArray(answer?.events) ? (answer.events as Record<string, unknown>[]) : [];
      const server = list.flatMap((e) => {
        const named = typeof e?.name === 'string' ? e.name : typeof e?.event === 'string' ? e.event : undefined;
        const props = (e?.props ?? e?.payload) as Record<string, unknown> | undefined;
        return named
          ? [
              {
                provider: String(e.provider ?? provider ?? 'backend'),
                name: named,
                ...(props && typeof props === 'object' ? { props } : {}),
                via: 'server' as const,
              },
            ]
          : [];
      });
      if (server.length > 0) report.sent = [...(report.sent ?? []), ...server];
    }
    const d = await device().catch(() => undefined);
    if (!d?.server.connected || away || unreachable(d.server)) return;
    if (capturing) {
      const raw = (await d.command('analytics', { take: true }).catch(() => [])) as { sdk?: string; name?: string; properties?: Record<string, unknown> }[];
      const sent = (Array.isArray(raw) ? raw : []).flatMap((e) =>
        e?.name ? [{ provider: String(e.sdk ?? 'unknown'), name: String(e.name), ...(e.properties ? { props: e.properties } : {}), via: 'sdk' as const }] : [],
      );
      // Added to what the backend told its analytics, read above for the same step, not in its place.
      if (sent.length > 0) report.sent = [...(report.sent ?? []), ...sent];
    }
    if (logging) {
      const raw = (await d.command('logs', { take: true }).catch(() => [])) as Partial<LogLine>[];
      const logs = (Array.isArray(raw) ? raw : []).flatMap((l): LogLine[] =>
        typeof l?.text === 'string' && typeof l.at === 'number'
          ? [
              {
                at: l.at,
                level: l.level === 'debug' || l.level === 'warn' || l.level === 'error' ? l.level : 'info',
                source: typeof l.source === 'string' ? l.source : 'js',
                text: l.text,
                ...(typeof l.stack === 'string' ? { stack: l.stack } : {}),
              },
            ]
          : [],
      );
      if (logs.length > 0) report.logs = logs;
      notePrinted(d.server.port, logs, platformOf(d));
    }
    const native = options.nativeLogs?.take() ?? [];
    // In the order they were printed, whichever side printed them.
    if (native.length > 0) report.logs = [...(report.logs ?? []), ...native].sort((x, y) => x.at - y.at);
    if (requestsSeen !== undefined) {
      await completeInFlight(d);
      const made = await d.requests(requestsSeen).then(
        (r) => r.requests,
        () => [],
      );
      // A reload (app.refresh) turns the app's keeping of bodies off with everything else it held: ask again.
      await d.command('networkBodies', { on: true }).catch(() => undefined);
      if (made.length > 0) {
        report.requests = made;
        requestsSeen = made.at(-1)!.id;
        for (const r of made) if (!answered(r)) inFlight.set(r.id, r);
        // A JS SDK (Segment, PostHog…) never reaches a native module: what it sent is in its requests.
        const traffic = trafficEvents(made).map((e) => ({ ...e, via: 'network' as const }));
        if (traffic.length > 0) report.sent = [...(report.sent ?? []), ...traffic];
      }
    }
    // A step that only looks (app.see, app.wait) on a screen no different from the last frame's shares that frame:
    // its wait and capture are what make a frame per step slow on a device. The shape is the route and each
    // element's id, text and place, read from the app, so a change in any of them still takes a frame.
    let shape: string | undefined;
    if (evidence?.screenshots && evidence.onChange && !away) {
      shape = await d.screen().then(
        (sc) => `${sc.route}|${sc.elements.map((e) => `${e.testId ?? ''}:${e.text ?? ''}:${Math.round(e.frame.x)},${Math.round(e.frame.y)}`).join(';')}`,
        () => undefined,
      );
      if (shape !== undefined && shape === lastFrame?.shape && /^app\.(see|wait)\b/.test(report.step)) {
        report.screenshot = lastFrame.file;
        return;
      }
    }
    if (evidence?.screenshots) {
      // A step may end mid-transition (a screen fading in, the splash fading out): the frame is of where the
      // step left the app, so two runs' frames of the same step show the same screen.
      // A screen that never settles (an animation that keeps going) is noted as such, and its frame is of a
      // moment, not of a state. The wait is paid on every step: short for a report, and long enough for what
      // arrives after a short delay (700 ms) where two runs' frames are compared pixel by pixel.
      const quietMs = evidence.settleMs ?? 150;
      const settled = away ? false : await idleAfter(d, quietMs, commitBefore);
      const stem = path.join(
        evidence.dir,
        `${String(index).padStart(2, '0')}-${report.step
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .slice(0, 48)
          .replace(/^-|-$/g, '')}`,
      );
      // A host on another machine writes the file there; `inline` asks it for the picture as well.
      // A host that knows what was still animating says so, as frames in points.
      let moving: unknown;
      // A host that waits for a still screen on its own clock signs each picture, so it can say whether the screen
      // it settled on is still the one in the picture.
      const hostStill = !!evidence.stillMs && (await offers('still'));
      let signature: string | undefined;
      const hostShot = async (file: string) =>
        d.command('screenshot', { path: file, inline: true, ...(hostStill ? { sign: true } : {}) }).then(
          (answer) => {
            const { png, moving: animating, signature: signed } = (answer ?? {}) as { png?: unknown; moving?: unknown; signature?: unknown };
            if (typeof png === 'string' && !fs.existsSync(file)) fs.writeFileSync(file, Buffer.from(png, 'base64'));
            if (Array.isArray(animating)) moving = animating;
            if (typeof signed === 'string') signature = signed;
            return fs.existsSync(file);
          },
          () => false,
        );
      let still: boolean | undefined;
      // The tree can be settled while the picture is not: a keyboard inset or a layout animation the host runs on its
      // own clock (trial run 10: the login button a thin bar after app.type, its frame h: 56). A host that can say
      // when its screen stands still is waited for, on its clock (no real time passes), before the picture.
      if (!hostStill && !away && helloOf(d)?.commands?.includes('clock') && (await offers('still'))) {
        const painted = (await d.command('still', { stepMs: 100, timeoutMs: 1500 }).catch(() => undefined)) as
          | { still?: unknown; moving?: unknown }
          | undefined;
        if (painted?.still === false) {
          still = false;
          if (Array.isArray(painted.moving)) moving = painted.moving;
          warn(`${FRAME_MOVING} at step ${index} (${report.step}): the host's screen still moved 1.5 s after the step, so the frame is of a moment`);
        }
      }
      let file = `${stem}.png`;
      let taken: boolean;
      if (await offers('screenshot')) {
        const avif = evidence.frames !== 'png' && !avifRefused;
        file = `${stem}.${avif ? 'avif' : 'png'}`;
        // A host on this machine encodes an AVIF frame after it answers, so the step does not wait for it;
        // the case waits for all its frames once, at its end.
        const later = avif
          ? await d.command('screenshot', { path: file, background: true }).then(
              (answer) => {
                const { background, moving: animating } = (answer ?? {}) as { background?: unknown; moving?: unknown };
                if (Array.isArray(animating)) moving = animating;
                return background === true;
              },
              () => false,
            )
          : false;
        if (later) encoding.push(file);
        taken = later || (await hostShot(file));
        if (!taken && avif) {
          avifRefused = true;
          file = `${stem}.png`;
          taken = await hostShot(file);
        }
      } else taken = !options.ownHost && (await execute(['screenshot', file], base)).code === 0;
      // An animation the agent cannot see (a device's native transition, a host's printer running on its own clock)
      // leaves a quiet app on a moving screen: the picture itself says when it stopped. Two frames alike, taken
      // stillMs apart, are a still screen. Frames still being encoded (AVIF on a host) are left as they are.
      if (taken && hostStill && signature !== undefined && !encoding.includes(file)) {
        // No real time passes and no picture is made while the host waits; the picture is taken again only when
        // the screen it settled on is another one.
        const stillMs = evidence.stillMs!;
        const answer = (await d.command('still', { stepMs: stillMs, timeoutMs: Math.max(2000, stillMs * 8), since: signature }).catch(() => undefined)) as
          | { still?: unknown; changed?: unknown; moving?: unknown }
          | undefined;
        if (answer) {
          still = answer.still === true;
          if (answer.changed === true) {
            fs.rmSync(file, { force: true });
            taken = await hostShot(file);
          }
          // A screen that never stood still: what moved during the wait is of a moment too.
          if (Array.isArray(answer.moving)) moving = [...(Array.isArray(moving) ? moving : []), ...answer.moving];
        }
      } else if (taken && evidence.stillMs && !encoding.includes(file)) {
        const stillMs = evidence.stillMs;
        const take = async (to: string) => ((await offers('screenshot')) ? hostShot(to) : (await execute(['screenshot', to], base)).code === 0);
        still = false;
        const until = Date.now() + Math.max(2000, stillMs * 8);
        let last = fs.readFileSync(file);
        while (!still && Date.now() < until) {
          await sleep(stillMs);
          const again = `${file}.again${path.extname(file)}`;
          if (!(await take(again))) break;
          const now = fs.readFileSync(again);
          fs.renameSync(again, file);
          still = now.equals(last);
          last = now;
        }
      }
      if (taken && (encoding.includes(file) || fs.existsSync(file))) {
        report.screenshot = file;
        lastFrame = { file, shape };
        // The OS tells the agent when something covers the app (a permission prompt, another app): a frame then is
        // not of the app. Read from what the app last said, so it costs no call.
        const state = onPhone(d.server) ? d.server.appState : undefined;
        if (state === 'inactive' || state === 'background')
          warn(`${FRAME_NOT_APP} at step ${index} (${report.step}): the app was ${state}, so a system view or another app is in front`);
        if (file.endsWith('.png') && evidence.frames !== 'png') {
          const taken = file;
          compacting.push(
            compactFrame(taken).then((compact) => {
              if (report.screenshot === taken) report.screenshot = compact;
            }),
          );
        }
        // What each pixel shows: comparing two runs' frames needs to tell the data they were given (a name,
        // a balance) from how it was drawn.
        const screen = away ? undefined : await d.screen().catch(() => undefined);
        if (screen)
          fs.writeFileSync(
            file.replace(/\.(png|avif)$/, '.json'),
            JSON.stringify({ ...screen, settled, ...(still === undefined ? {} : { still }), ...(moving ? { moving } : {}) }),
          );
      }
    }
  };

  let failed = false;
  // A setup that failed leaves the steps nothing to stand on, with or without `continue`.
  let setupFailed = false;
  let unsupported = false;
  let routesFrom: number | undefined;
  // The screen a reused app was left on: a reset reports it once more before the case's own screens.
  let routesStale: string | undefined;
  if (options.prepared) {
    steps.push(...options.prepared.steps);
    log(`  ⚡ setup made ahead (${options.prepared.steps.length} steps)`);
  }
  // What the case mocked that the app never asked for, and what it asked the network for instead: a rule with a path
  // the app does not use passes quietly and leaves the case testing the real server.
  const unmatchedMocks = async (): Promise<string[]> => {
    if (options.dry || away) return [];
    const d = await device().catch(() => undefined);
    if (!d?.server.connected || unreachable(d.server)) return [];
    const listed = (await d.command('netmock', { action: 'list' }).catch(() => undefined)) as
      | { rules?: { method?: string; path?: string; hits?: number }[]; holds?: { method?: string; path?: string; hits?: number }[] }
      | undefined;
    const idle = [
      ...(listed?.rules ?? []).filter((r) => r.hits === 0).map((r) => `mock rule ${r.method && r.method !== '*' ? `${r.method} ` : ''}${r.path}`),
      ...(listed?.holds ?? []).filter((r) => r.hits === 0).map((r) => `mock hold ${r.method && r.method !== '*' ? `${r.method} ` : ''}${r.path}`),
    ];
    if (idle.length === 0) return [];
    const asked =
      mockedFrom === undefined
        ? []
        : await d.requests(mockedFrom).then(
            (r) => r.requests,
            () => [],
          );
    const pathOf = (url: string) => {
      try {
        return new URL(url).pathname;
      } catch {
        return url.split('?')[0]!;
      }
    };
    const real = [...new Set(asked.filter((r) => !r.mocked).map((r) => `${r.method.toUpperCase()} ${pathOf(r.url)}`))];
    const network = real.length ? `; ${real.slice(0, 3).join(', ')}${real.length > 3 ? ` and ${real.length - 3} more` : ''} went to the network` : '';
    return idle.map((rule) => `${rule} never matched${network}`);
  };
  // A mock answers for the case that set it: one an earlier case or a hand left on the app would make this case pass
  // or fail on an answer it never asked for. Cleared again once a case that set one is done, so neither the next case
  // nor the app driven by hand meets it.
  const clearMocks = async () => {
    if (options.setupOnly || options.dry || away) return;
    mocksSet = false;
    const d = await device().catch(() => undefined);
    if (d?.server.connected) await d.command('netmock', { action: 'clear' }).catch(() => undefined);
  };
  await clearMocks();
  // What native SDKs answer in this case starts as the config says, whatever the last case on this app set.
  if (config.nativeMocks && !options.setupOnly && !options.dry) {
    const d = await device().catch(() => undefined);
    await d?.command('nativeMocks', { replace: config.nativeMocks }).catch(() => undefined);
  }
  // Each app step gets a span id the host puts in the `traceparent` of every request the app sends while it
  // runs; a backend that exports traces to the run files what it did under that step.
  const tracing =
    options.traces && !options.dry && !options.setupOnly && (await offers('traceContext'))
      ? { traceId: newTraceId(), steps: new Map<string, { index: number; startedMs: number }>() }
      : undefined;
  // A failed `see` or `wait` for a target keeps the whole listing, the scrolls it made and what the target was
  // last seen as: enough to tell a button off the window from one not mounted yet or one covered.
  let lookedScreen: Screen | undefined;
  const lookedAfter = async (step: Step): Promise<RunLooked | undefined> => {
    if (options.dry || !trail || (step.verb !== 'app.see' && step.verb !== 'app.wait')) return undefined;
    const d = await device().catch(() => undefined);
    if (!d?.server.connected || unreachable(d.server)) return undefined;
    const screen = await d.screen().catch(() => undefined);
    if (!screen) return undefined;
    lookedScreen = screen;
    const params = (typeof step.value === 'string' ? { target: step.value } : (step.value ?? {})) as Record<string, unknown>;
    const wanted =
      step.verb === 'app.wait' ? (typeof params.what === 'string' || typeof params.target === 'string' ? targetOfWait(params) : undefined) : targetIn(params);
    // A wait is the CLI's own loop: all it can say is where the target stands now.
    if (step.verb === 'app.wait' && wanted) note((await d.server.call('find', wanted).catch(() => null)) as Element | null, screen.window);
    const listing = describeScreen(screen, { all: true, limit: 150 });
    return {
      listing: listing.length > 16_000 ? `${listing.slice(0, 16_000)}\n… cut` : listing,
      scrolls: trail.scrolls,
      scrollsTotal: trail.scrollsTotal,
      ...(wanted ? { target: { found: trail.found, ...(trail.last ? { last: trail.last } : {}), seen: trail.seen } } : {}),
    };
  };
  const coverNow = async (): Promise<string | undefined> => {
    if (options.dry) return undefined;
    const d = await device().catch(() => undefined);
    return d?.server.connected ? d.screen().then(nativeCover, () => undefined) : undefined;
  };
  const targetOfWait = (params: Record<string, unknown>): Target | undefined => {
    const what = typeof params.what === 'string' ? params.what : typeof params.target === 'string' ? params.target : undefined;
    return what && !isRoute(what) && !/^\d+$/.test(what) ? targetIn({ target: what, within: params.within, nth: params.nth }) : undefined;
  };

  const todo = options.setupOnly ? c.setup : options.prepared ? c.steps : [...c.setup, ...c.steps];
  const setupLength = todo === c.steps ? 0 : c.setup.length;
  const looksFirst = !!evidence?.onChange && !!evidence.stillMs;
  let held: { report: StepReport; n: number; at: number | undefined; t0: number; looks: StepReport[]; commit?: number } | undefined;
  const flush = async () => {
    if (!held) return;
    const h = held;
    held = undefined;
    await record(h.report, h.n, h.at, h.t0, h.commit);
    if (h.report.screenshot) for (const l of h.looks) l.screenshot = h.report.screenshot;
  };
  const firstRun = steps.length;
  for (const [index, step] of todo.entries()) {
    if (!(held && step.verb === 'app.see')) await flush();
    stepAt = index;
    const text = label(step);
    if (unsupported || setupFailed || (failed && !options.continue) || options.signal?.aborted) {
      steps.push({ step: text, status: 'skipped', ms: 0 });
      continue;
    }
    if (options.dry) {
      const unknown = unknownStep(step, config);
      steps.push({ step: text, status: unknown ? 'failed' : 'passed', ms: 0, ...(unknown ? { error: unknown } : {}) });
      if (unknown) log(`  ❌ ${text}  — ${unknown}`);
      continue;
    }
    const t0 = Date.now();
    phases = {};
    const place = {
      index,
      steps: todo.length,
      section: index < setupLength ? ('setup' as const) : ('steps' as const),
      ...(index >= setupLength && c.sections?.[index - setupLength] ? { heading: c.sections[index - setupLength] } : {}),
      step: text,
    };
    options.onStep?.(place);
    const ended = (status: StepReport['status']) => options.onStep?.({ ...place, status, ms: Date.now() - t0 });
    // Where the app's trace stood before the case first touched it: the screens after it are the case's.
    if (options.routes && routesFrom === undefined && (step.verb.startsWith('app.') || config.macros?.[step.verb])) {
      const d = await device().catch(() => undefined);
      routesFrom = await d?.trace().then(
        (t) => t.last,
        () => undefined,
      );
      // An app started for this case begins where it begins; one reused from a case before was left elsewhere.
      if (options.routes !== 'fresh')
        routesStale = await d?.screen().then(
          (sc) => sc.route,
          () => undefined,
        );
    }
    const at = step.verb.startsWith('app.') || config.macros?.[step.verb] ? await frameAt() : undefined;
    if (tracing && (step.verb.startsWith('app.') || config.macros?.[step.verb])) {
      const spanId = newSpanId();
      tracing.steps.set(spanId, { index: steps.length, startedMs: t0 });
      await (await device()).command('traceContext', { traceparent: traceparent(tracing.traceId, spanId) }).catch(() => undefined);
    }
    const acts = ACTING.test(step.verb) || !!config.macros?.[step.verb];
    const commitBefore =
      evidence?.screenshots && acts && !away
        ? await (await device().catch(() => undefined))?.screen().then(
            (sc) => sc.commit,
            () => undefined,
          )
        : undefined;
    trail = undefined;
    try {
      const outcome = await perform(step);
      if (step.verb.startsWith('app.') || config.macros?.[step.verb]) await timed('events', () => collect(steps.length + 1));
      const done: StepReport = { step: text, status: outcome === 'skipped' ? 'skipped' : 'passed', ms: Date.now() - t0, ...phased(phases) };
      steps.push(done);
      const slow = slowTargetNote(done);
      if (slow) warn(slow);
      log(`  ${outcome === 'skipped' ? '⏭️' : '✅'} ${text}  (${Date.now() - t0}ms${phaseNote(done)})`);
      ended(done.status);
      if ((keeping || capturing) && outcome !== 'skipped' && (step.verb.startsWith('app.') || config.macros?.[step.verb])) {
        if (held && step.verb === 'app.see') held.looks.push(done);
        else if (looksFirst && todo[index + 1]?.verb === 'app.see') held = { report: done, n: steps.length, at, t0, looks: [], commit: commitBefore };
        else await record(done, steps.length, at, t0, commitBefore);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const missing = error instanceof HostLacks ? error.missing : lacking(message);
      if (missing) {
        // Not the app's doing: the rest of the case would be standing on a step that never happened.
        unsupported = true;
        // The agent says why when it can (a release bundle, where commands registered behind __DEV__ never ran).
        const why = error instanceof HostLacks ? `(${error.why})` : /Unknown method \S+ (\(.+\))$/.exec(message)?.[1];
        const said = `this host has no ${missing}${why ? ` ${why}` : ''}`;
        steps.push({ step: text, status: 'unsupported', ms: Date.now() - t0, error: said });
        log(`  🚫 ${text}  — ${said}`);
        ended('unsupported');
        continue;
      }
      if (!failed && !why) sought = soughtBy(step);
      failed = true;
      if (index < setupLength) setupFailed = true;
      const broke: StepReport = { step: text, status: 'failed', ms: Date.now() - t0, error: message, ...phased(phases) };
      lookedScreen = undefined;
      const looked = await lookedAfter(step);
      // A see or wait has just read the screen; a press or a type reads it once more, only when it fails.
      const cover =
        message.includes(NATIVE_COVER) || message.includes(NOT_DRAWN)
          ? undefined
          : lookedScreen
            ? nativeCover(lookedScreen)
            : step.verb === 'app.press' || step.verb === 'app.type'
              ? await coverNow()
              : undefined;
      if (cover) broke.error = `${message} (${cover})`;
      if (looked) broke.looked = looked;
      if (step.verb === 'app.wait' && looked?.target) {
        const [first = '', ...more] = message.split('\n');
        broke.error = [`${first}${sightingNote(trail)}${cover ? ` (${cover})` : ''}`, ...more].join('\n');
      }
      steps.push(broke);
      log(`  ❌ ${text}  — ${(broke.error ?? message).split('\n')[0]}  (${Date.now() - t0}ms${phaseNote(broke)})`);
      ended('failed');
      await flush();
      if (keeping || capturing) await record(broke, steps.length, at, t0, commitBefore);
    }
  }

  await flush();
  stepAt = -1;
  // A case that changes what the next one runs on (a face enrolled on a shared Simulator) puts it back here, whether
  // its steps passed, failed or were skipped. A teardown step that fails is said and does not change the result.
  if (!options.dry && !options.setupOnly && !options.signal?.aborted) {
    for (const step of c.teardown) {
      try {
        const outcome = await perform(step);
        log(`  ${outcome === 'skipped' ? '⏭️' : '↩️'} teardown ${label(step)}`);
      } catch (error) {
        warn(`teardown ${label(step).trim()} failed: ${(error instanceof Error ? error.message : String(error)).split('\n')[0]}`);
      }
    }
  }
  if (mocksSet) {
    for (const line of await unmatchedMocks()) warn(line);
    await clearMocks();
  }
  if (requestsSeen !== undefined) {
    const d = await device().catch(() => undefined);
    // The last answers of the case, given a moment to arrive.
    for (let i = 0; d && inFlight.size && i < 5; i++) {
      await sleep(200);
      await completeInFlight(d);
    }
    await d?.command('networkBodies', { on: false }).catch(() => undefined);
  }
  await Promise.all(compacting);
  if (encoding.length > 0) {
    const until = Date.now() + 15_000;
    while (encoding.some((f) => !fs.existsSync(f)) && Date.now() < until) await sleep(25);
    // A frame that never arrived is not offered to a report.
    for (const s of steps) if (s.screenshot && encoding.includes(s.screenshot) && !fs.existsSync(s.screenshot)) delete s.screenshot;
  }
  if (tracing && options.traces) {
    await (await device().catch(() => undefined))?.command('traceContext', { traceparent: null }).catch(() => undefined);
    // A backend exports in batches, a moment after the requests it served.
    await options.traces.settle(tracing.traceId);
    for (const [index, spans] of options.traces.take(tracing.traceId, tracing.steps)) {
      const s = steps[index];
      // A step that set off thousands of spans keeps the first ones; a report is not a profiler.
      if (s) s.backend = spans.slice(0, 1500);
    }
    fileRequestsByTrace(steps, tracing.steps);
  }
  if (options.setupOnly && !failed) options.setupOnly.keep({ scope, latest, ran: [...ran], steps });
  if (options.dry) failed = steps.some((s) => s.status === 'failed');
  const report: CaseReport = {
    id: c.id,
    title: c.title,
    ...aboutOf(c),
    file: c.file,
    result: failed ? 'failed' : unsupported ? 'unsupported' : 'passed',
    ms: Date.now() - started,
    steps,
    ...(warnings.length ? { warnings } : {}),
  };
  if (options.events) report.events = recorded;
  if (routesFrom !== undefined) {
    const events = await device()
      .then((d) => d.trace(routesFrom))
      .then((t) => t.events)
      .catch(() => []);
    const walked = events.flatMap((e) => (e.kind === 'route' && e.route ? [e.route] : []));
    while (walked.length > 0 && walked[0] === routesStale) walked.shift();
    report.routes = [...new Set(walked)].sort();
    stepRoutes(
      steps.slice(firstRun),
      actedAt,
      events.flatMap((e) => (e.kind === 'route' && e.route ? [{ seq: e.seq, route: e.route }] : [])),
    );
  }
  if (!options.dry && !options.setupOnly && (await offers('nativeValues'))) {
    const reads = readsOf(await (await device().catch(() => undefined))?.command('nativeValues').catch(() => undefined));
    if (reads.length > 0) report.nativeValues = reads;
  }
  if (hostFilm.on && film) {
    const d = await device();
    const stopped = (await d.command('record', { stop: true }).catch(() => undefined)) as { bytes?: unknown } | undefined;
    if (await finishHostFilm(d, film, stopped)) report.video = film;
  }
  if (hostFilm.from !== undefined) {
    // A step's second counts in video.mp4: those before the relaunch are not in it, and the step that relaunched goes on at its start.
    const from = hostFilm.from;
    for (const step of steps.slice(0, from)) delete step.videoS;
    if (steps[from]?.videoS !== undefined) steps[from]!.videoS = 0;
    if (from > 0)
      warn(
        `the film ${report.video ? `in ${path.basename(film!)} starts during step ${from + 1}` : 'after the relaunch is missing'}: the host was started again there (a relaunch), and what it filmed before ${hostFilm.parts.length ? `is in ${hostFilm.parts.map((f) => path.basename(f)).join(', ')}` : 'did not play and was not kept'}`,
      );
  }
  if (osFilm) {
    await osFilm.stop().catch(() => false);
    if (keepFilm(osFilm.file, await settledFilm(osFilm.file))) report.video = osFilm.file;
    for (const note of osFilm.notes ?? []) warn(note);
  }
  // What the film said came after the report was made.
  if (warnings.length) report.warnings = warnings;
  if (failed && !options.dry && !options.setupOnly && !options.signal?.aborted) {
    const d = await device().catch(() => undefined);
    const away = unreachable(d?.server);
    // A step that failed on its own reading of the screen left no reasons; ask for them, about this case only.
    if (away) why = `  • ${d?.inBackground ? leftOutside(d.opened) : away}`;
    else if (!why && d?.server.connected) why = (await whyFor(base, sought, started, mark).catch(() => '')) || undefined;
    if (d?.server.connected && !away) {
      const screen = await d.screen().catch(() => undefined);
      const events = await d.trace(mark).catch(() => undefined);
      report.evidence = {
        screen: screen ? describeScreen(screen, { limit: 40 }) : undefined,
        requests: events?.events
          .flatMap((e) => (e.kind === 'request' ? [`${e.status ?? '…'} ${e.method} ${e.url}${e.mocked ? ' (mocked)' : ''}`] : []))
          .slice(-8),
        why,
      };
    } else if (away) report.evidence = { why };
    const reasons = (why ?? '')
      .split('\n')
      .map((l) => l.replace(/^\s*•\s*/, '').trim())
      .filter((l) => l.length > 0);
    if (reasons.length > 0) report.diagnosis = reasons;
  }
  if (!failed && !options.dry) {
    const d = await device().catch(() => undefined);
    if (d?.inBackground) log(`  ↪ ${leftOutside(d.opened)}`);
  }
  if (!options.dry && !options.setupOnly) {
    const broke = steps.find((s) => s.status === 'failed');
    const ran = await device().catch(() => undefined);
    const hello = ran?.server?.hello;
    noteCaseEnd(
      { case: c.id, target: targetOf(hello), lane: laneLabel(hello, ran?.info?.type) },
      broke && report.result === 'failed'
        ? {
            at: Date.now(),
            failed: `${broke.step}: ${(broke.error ?? '').split('\n')[0]}`,
            ...(report.evidence?.why ? { why: report.evidence.why } : {}),
            ...(report.evidence?.requests?.length ? { requests: report.evidence.requests } : {}),
          }
        : undefined,
    );
    scopeWhy(
      ran?.server?.port,
      {
        at: started,
        since: mark,
        case: c.id,
        ...(broke ? { failed: `${broke.step}: ${(broke.error ?? '').split('\n')[0]}` } : {}),
      },
      platformOf(ran),
    );
  }
  return report;
};

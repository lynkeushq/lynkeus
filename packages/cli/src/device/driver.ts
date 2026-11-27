/**
 * An app running the agent. The screen is the React tree the app hands over and
 * touches are synthesized inside its process, so an action costs milliseconds;
 * only launching, screenshots and the status bar go through simctl or adb.
 */
import { AgentServer } from 'lynkeus-client';
import type { CoreMethods, HelloEvent, Screen, TraceEvent } from 'lynkeus-protocol';

import { portFromEnv, readToken } from '../config.js';
import { withoutHost } from '../knowledge/problems.js';
import { viaOf, type Walk } from '../knowledge/walk.js';
import { onPhone } from '../runtime.js';
import type { DeviceInfo } from './devices.js';
import { lifecycleFor, type PlatformLifecycle } from './platform.js';

// The OS brings an app back to the front in well under a second; a suspended one may take a few to answer again.
const FOREGROUND_MS = 8000;

/** Whether the app says it is in front again within the time, from an AppState event or the hello of a reconnect. */
const untilActive = (server: AgentServer, timeoutMs: number): { done: Promise<boolean>; cancel: () => void } => {
  let finish: (back: boolean) => void = () => undefined;
  const done = new Promise<boolean>((resolve) => {
    const check = (event: { state?: string; appState?: string }) => {
      const state = event.state ?? event.appState;
      // An agent older than AppState says hello without one: being back on the line is all it can say.
      if (state === undefined || state === 'active') finish(true);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    finish = (back) => {
      clearTimeout(timer);
      server.off('appstate', check);
      server.off('hello', check);
      resolve(back);
    };
    server.on('appstate', check);
    server.on('hello', check);
  });
  return { done, cancel: () => finish(false) };
};

const OBSERVING = new Set([
  'events',
  'logs',
  'analytics',
  'networkBodies',
  'traceContext',
  'record',
  'screenshot',
  'still',
  'nativeValues',
  'netmock',
  'nativeMocks',
]);

export class Device {
  info: DeviceInfo;
  readonly server: AgentServer;

  #lifecycle: PlatformLifecycle;
  #appId: string | null;
  #resolving?: Promise<DeviceInfo>;
  #walk?: Walk;
  // A phone's app that let go of the driver in the background says hello no more; what it said last tells it was a phone.
  #hello: HelloEvent | null = null;
  #opened?: string;

  constructor(info: DeviceInfo, options: { server?: AgentServer; appId?: string | null; resolving?: Promise<DeviceInfo>; lifecycle?: PlatformLifecycle } = {}) {
    this.info = info;
    this.#resolving = options.resolving;
    // The app serves commands only to a driver that presents its token; without one, anything on the loopback could drive a dev build.
    this.server = options.server ?? new AgentServer({ token: readToken(), port: portFromEnv() });
    this.#lifecycle = options.lifecycle ?? lifecycleFor(info.platform);
    this.#appId = options.appId ?? null;
  }

  /** The device as the OS knows it: reading the screen needs none of it; launching, screenshots and OS commands do. */
  async resolved(): Promise<DeviceInfo> {
    if (this.#resolving) {
      this.info = await this.#resolving;
      this.#resolving = undefined;
    }
    return this.info;
  }

  get appId(): string | null {
    return this.#appId;
  }

  /** Learns where presses lead from what this connection reads anyway (see knowledge/walk.ts). */
  learn(walk: Walk): void {
    this.#walk = walk;
    this.server.on('navigation', (event: { route?: string }) => this.#walk?.routed(event.route));
  }

  /** Drives the app without learning from it, for a caller that records what it learns itself (a crawl). */
  async unlearned<T>(fn: () => Promise<T>): Promise<T> {
    const walk = this.#walk;
    this.#walk = undefined;
    try {
      return await fn();
    } finally {
      walk?.forget();
      this.#walk = walk;
    }
  }

  async stop(): Promise<void> {
    this.#walk?.settle();
    await this.server.close();
  }

  async launchApp(appId: string, options: { fresh?: boolean } = {}): Promise<void> {
    this.#appId = appId;
    await this.server.listen();
    await this.#lifecycle.launchApp((await this.resolved()).id, appId, options.fresh ?? true);
    await this.server.waitForApp();
  }

  /** The OS put another app in front of this one (a press opened a link, say). Only a phone's app: a host stands in for the OS. */
  get inBackground(): boolean {
    this.#hello = this.server.hello ?? this.#hello;
    return this.server.appState === 'background' && onPhone({ hello: this.#hello });
  }

  /** The last URL a press made the app hand the OS, until the app is brought back: what is in front of it. */
  get opened(): string | undefined {
    return this.#opened;
  }

  /**
   * Brings the app back to the front after the OS put another app there, the way it is launched (simctl launch,
   * the launcher intent), which keeps it as it was; only if it does not come back is it relaunched, losing its state.
   */
  async foreground(timeoutMs = FOREGROUND_MS): Promise<'returned' | 'relaunched'> {
    const appId = this.#appId;
    if (!appId)
      throw new Error(
        'the app is in the background and Lynkeus does not know its bundle id or application id to bring it back: set app in lynkeus.config.json, or pass --app',
      );
    const id = (await this.resolved()).id;
    this.#opened = undefined;
    const active = untilActive(this.server, timeoutMs);
    const launched = await this.#lifecycle.launchApp(id, appId, false).then(
      () => true,
      () => false,
    );
    if (!launched) active.cancel();
    if (await active.done) return 'returned';
    // The old connection can outlive the relaunch for a moment and answer for an app that is not there any more.
    const relaunched = untilActive(this.server, timeoutMs);
    await this.launchApp(appId, { fresh: true }).catch((error: unknown) => {
      relaunched.cancel();
      throw error;
    });
    if (this.server.appState === 'background') await relaunched.done;
    else relaunched.cancel();
    return 'relaunched';
  }

  async openUrl(url: string): Promise<void> {
    this.#walk?.acted(true);
    await this.server.call('deepLink', { url });
  }

  /** Pins the clock, battery and radios so a pixel baseline survives the calendar. */
  async freezeChrome(): Promise<void> {
    await this.#lifecycle.freezeChrome((await this.resolved()).id);
  }

  /** A host that draws the app itself (fastsim) captures its own frame; a device or simulator is captured by its OS. */
  async screenshot(destination: string): Promise<void> {
    if (this.server.hello?.commands?.includes('screenshot')) {
      await this.command('screenshot', { path: destination });
      return;
    }
    await this.#lifecycle.screenshot((await this.resolved()).id, destination);
  }

  async screen(): Promise<Screen> {
    const screen = await this.server.call<Screen>('screen');
    this.#walk?.saw(screen);
    return screen;
  }

  async press(params: CoreMethods['press']['params']): Promise<CoreMethods['press']['result']> {
    this.#walk?.pressing();
    try {
      const result = await this.server.call<CoreMethods['press']['result']>('press', params);
      if (result.opened) this.#opened = result.opened;
      this.#walk?.pressed(viaOf(result.element) ?? ('testId' in params || 'text' in params ? viaOf(params) : undefined));
      return result;
    } catch (error) {
      this.#walk?.pressed(undefined);
      throw error;
    }
  }

  type(params: CoreMethods['type']['params']): Promise<CoreMethods['type']['result']> {
    this.#walk?.acted(false);
    return this.server.call('type', params);
  }

  swipe(params: CoreMethods['swipe']['params']): Promise<CoreMethods['swipe']['result']> {
    this.#walk?.acted(true);
    return this.server.call('swipe', params);
  }

  async back(): Promise<CoreMethods['back']['result']> {
    this.#walk?.acted(true);
    const result = await this.server.call<CoreMethods['back']['result']>('back');
    this.#walk?.routed(result?.route);
    return result;
  }

  async navigate(name: string, params?: object): Promise<void> {
    this.#walk?.acted(true);
    await this.server.call('navigate', { name, params });
  }

  // The agent's own timeout governs; the transport waits a little longer so it hears the agent's answer.
  async waitFor(params: CoreMethods['waitFor']['params']): Promise<CoreMethods['waitFor']['result']> {
    const result = await this.server.call<CoreMethods['waitFor']['result']>('waitFor', params, (params.timeoutMs ?? 5000) + 2000);
    if (!result?.passed) this.#walk?.routed(result?.route);
    return result;
  }

  idle(params?: CoreMethods['idle']['params']): Promise<CoreMethods['idle']['result']> {
    return this.server.call('idle', params, (params?.timeoutMs ?? 3000) + 2000);
  }

  requests(since?: number): Promise<CoreMethods['requests']['result']> {
    return this.server.call('requests', { since });
  }

  trace(since?: number): Promise<CoreMethods['trace']['result']> {
    return this.server.call('trace', { since });
  }

  /** A command the app registered with `qa.register`. */
  command<T = unknown>(name: string, params?: unknown): Promise<T> {
    // An app's own command may move it anywhere (a reset, a sign-in); Lynkeus's own observers move nothing.
    if (!OBSERVING.has(name)) this.#walk?.acted(true);
    return this.server.call<T>(name, params);
  }
}

const quote = (value: string) => JSON.stringify(value);

// The agent sends a text whole, so a check can name all of it; a listing only needs enough to recognize it.
const PRINTED_TEXT = 200;
const shortened = (text: string) => (text.length > PRINTED_TEXT ? `${text.slice(0, PRINTED_TEXT - 1)}…` : text);

export const describeTrace = (events: TraceEvent[]): string => {
  if (events.length === 0) return '(no events)';
  const t0 = events[0]!.t;
  const rel = (t: number) => `+${String(t - t0).padStart(6)}ms`;
  return events
    .map((e) => {
      if (e.kind === 'route') return `${rel(e.t)}  route    ${e.route ?? '?'}  (${e.path.join(' > ')})`;
      if (e.kind === 'request')
        return `${rel(e.t)}  request  ${String(e.status ?? '…').padStart(3)} ${e.method.padEnd(5)} ${withoutHost(e.url)}${e.error ? `  (${e.error})` : ''}${e.mocked ? '  (mocked)' : ''}`;
      if (e.kind === 'stall')
        return `${rel(e.t)}  stall    render loop broken: ${e.renders} updates${e.component ? ` to ${e.component}` : ''} in ${e.windowMs}ms`;
      if (e.kind === 'touch')
        return `${rel(e.t)}  touch    ${e.testId ? `#${e.testId}` : e.text ? JSON.stringify(e.text) : `${e.x},${e.y}`}  on ${e.route ?? '?'}`;
      if (e.kind === 'crash') return `${rel(e.t)}  crash    ${e.message}`;
      if (e.kind === 'event') return `${rel(e.t)}  event    ${e.name}${e.props ? ` ${JSON.stringify(e.props)}` : ''}`;
      if (e.kind === 'store')
        return `${rel(e.t)}  store    ${e.store}: ${Object.entries(e.changed)
          .map(([k, v]) => `${k} ${JSON.stringify(v.from)}→${JSON.stringify(v.to)}`)
          .join(', ')}`;
      return `${rel(e.t)}  command  ${e.method} ${e.ms}ms${e.error ? `  ✗ ${e.error}` : ''}`;
    })
    .join('\n');
};

type DescribeOptions = {
  limit?: number;
  /** Also what the platform is not presenting: behind a layer, out of the accessibility tree. */
  all?: boolean;
  /** Each element's centre, in points. */
  frames?: boolean;
  /** The commit count and the read's cost in the header. */
  verbose?: boolean;
};

export const NATIVE_COVER =
  'a native view outside React Native covers the app (the Expo dev menu’s sheet, a system alert, a permission prompt): every control reads ~covered, and that view’s own buttons are not in the tree; close it on the device, or relaunch the app';

/** How the agent and these notes name a view outside the app's React tree; a message that has it already says why. */
export const NOT_DRAWN = 'the app did not draw';

export const SYSTEM_VIEW = `a view ${NOT_DRAWN} is in front of it (a system alert, a native sheet): its words are listed ~system, and its buttons are pressed by their text`;

export const REMOTE_SYSTEM_VIEW = `a view ${NOT_DRAWN} is in front of it, drawn by another process (iOS's Save Password prompt after a login form, a permission prompt): Lynkeus can neither read nor tap it, and presses under it fail; relaunch the app, or answer it on the device`;

/**
 * Whether something outside the app's React tree is over it. The agent marks a control covered when a touch at its
 * centre would land elsewhere; when every presented control is covered at once and the tree shows nothing on top,
 * what is over them is a native view of its own (expo-dev-client's onboarding sheet on a first launch, say).
 */
export const nativeCover = (screen: Pick<Screen, 'elements' | 'presenting' | 'system'>): string | undefined => {
  if (screen.system) return screen.elements.some((e) => e.system) ? SYSTEM_VIEW : REMOTE_SYSTEM_VIEW;
  const controls = screen.elements.filter((e) => !e.hidden && (e.kind === 'button' || e.kind === 'input'));
  return !screen.presenting && controls.length > 0 && controls.every((e) => e.covered) ? NATIVE_COVER : undefined;
};

export const describeScreen = (screen: Screen, options: DescribeOptions = {}): string => {
  const { limit = 80, all = false, frames = false, verbose = false } = options;
  const layer = `${screen.presenting ? ` +${screen.presenting.modal ? 'modal' : 'overlay'}${screen.presenting.testId ? `#${screen.presenting.testId}` : ''}` : ''}${screen.system ? ' +system' : ''}`;
  // Plain views are layout; one that names itself (a testID, a label) is content.
  const named = screen.elements.filter((e) => e.kind !== 'view' || e.accessibilityLabel !== undefined || e.testId !== undefined);
  // What sits inside a button is the button: its icon is not something else to read or press.
  const insideButton = (e: Screen['elements'][number]) => {
    for (let p = e.parent; p !== undefined; p = screen.elements[p]?.parent) if (screen.elements[p]?.kind === 'button') return true;
    return false;
  };
  // An inert control is still read, even though it cannot be touched.
  const listed = all ? named : named.filter((e) => (!e.hidden || e.hidden === 'inert') && !(e.kind === 'view' && insideButton(e)));
  const counts = new Map<string, number>();
  if (!all) for (const e of named) if (e.hidden && e.hidden !== 'inert') counts.set(e.hidden, (counts.get(e.hidden) ?? 0) + 1);
  const hiddenTotal = [...counts.values()].reduce((sum, n) => sum + n, 0);
  const hiddenNote = hiddenTotal ? ` · ${hiddenTotal} hidden: ${[...counts].map(([reason, n]) => `${n} ${reason}`).join(', ')}` : '';
  const stats = verbose ? ` commit=${screen.commit}${screen.busy ? ' busy' : ''} ${screen.costMs}ms` : screen.busy ? ' busy' : '';
  // The path says which navigators hold the route; alone, it only repeats it.
  const trail = screen.path.join(' > ');
  const header = `${screen.route ?? '?'}${trail === screen.route ? '' : ` (${trail})`}${layer}${stats}${hiddenNote}`;
  // An index is how to point at what has no name of its own, or shares it: a control
  // with a testID nothing else carries is pointed at by that.
  const nameOf = (e: Screen['elements'][number]) => (e.testId ? `#${e.testId}` : (e.text ?? e.accessibilityLabel));
  const uses = new Map<string, number>();
  for (const e of listed) {
    const name = nameOf(e);
    if (name !== undefined) uses.set(name, (uses.get(name) ?? 0) + 1);
  }
  const lines = listed.slice(0, limit).map((e) => {
    const id = e.testId ? ` #${e.testId}` : '';
    const name = nameOf(e);
    const index = name !== undefined && uses.get(name) === 1 ? '' : `${e.i} `;
    // A label that only repeats the testID says nothing new.
    const label = (e.text ?? e.accessibilityLabel) === e.testId ? undefined : (e.text ?? e.accessibilityLabel);
    const value =
      e.kind === 'input'
        ? ` value=${quote(e.value ?? '')}${e.placeholder ? ` placeholder=${quote(e.placeholder)}` : ''}${e.focused ? ' *focused' : ''}`
        : e.value !== undefined
          ? ` value=${quote(e.value)}` // a QR's encoded string, say
          : '';
    const state = `${e.enabled ? '' : ' !disabled'}${e.covered ? ' ~covered' : ''}${e.hidden ? ` ~${e.hidden}` : ''}${e.system ? ' ~system' : ''}`;
    const at = frames ? ` @${Math.round(e.frame.x + e.frame.w / 2)},${Math.round(e.frame.y + e.frame.h / 2)}` : '';
    return `${index}${e.kind}${id}${label ? ` ${quote(shortened(label))}` : ''}${value}${state}${at}`;
  });
  const rest = listed.length - lines.length;
  const cover = nativeCover(screen);
  return [header, cover ? `! ${cover}` : '', ...lines, rest > 0 ? `… ${rest} more` : ''].filter(Boolean).join('\n');
};

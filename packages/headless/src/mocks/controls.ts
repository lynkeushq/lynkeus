// What a device gets from the OS, set by the driver at run time as `qa`
// commands: deep links, app state, the clock, the network and its answers,
// and the sensors, camera, picker and WebViews the factories stand in for.
import { countHeldFrom, qa } from 'lynkeus-agent';
import { AppState, Linking } from 'react-native';

import { log, onReset } from '../runtime.js';
import { cameras, pickerQueue, sensor, webviews, type BiometricOutcome } from './factories.js';

type Listener = (payload: unknown) => void;
const listeners = { url: new Set<Listener>(), appState: new Set<Listener>() };

export const listenerCounts = () => ({ url: listeners.url.size, appState: listeners.appState.size });

// The jest preset's Linking is jest.fn()s, so an opened URL would reach no one.
const installLinking = (initialUrl: string | null) => {
  const linking = Linking as unknown as Record<string, unknown>;
  linking.addEventListener = (type: string, handler: Listener) => {
    if (type === 'url') listeners.url.add(handler);
    return { remove: () => listeners.url.delete(handler) };
  };
  linking.removeEventListener = (_type: string, handler: Listener) => listeners.url.delete(handler);
  linking.getInitialURL = () => Promise.resolve(initialUrl);
  linking.canOpenURL = () => Promise.resolve(true);
  linking.openURL = (url: string) => {
    log(`deep link: ${url} → ${listeners.url.size} listener(s)`);
    for (const listener of [...listeners.url]) listener({ url });
    return Promise.resolve();
  };
  // The agent's `deepLink` calls Linking.openURL itself; this serves hosts started without a driver flow.
  qa.register('deeplink', (params) => {
    const url = String((params as { url?: string } | undefined)?.url ?? '');
    if (!url) throw new Error('deeplink needs { url }');
    Linking.openURL(url);
    return { opened: url, listeners: listeners.url.size };
  });
};

const installAppState = () => {
  const appState = AppState as unknown as Record<string, unknown>;
  appState.currentState = 'active';
  onReset(() => {
    appState.currentState = 'active';
  });
  appState.addEventListener = (type: string, handler: Listener) => {
    if (type === 'change') listeners.appState.add(handler);
    return { remove: () => listeners.appState.delete(handler) };
  };
  appState.removeEventListener = (_type: string, handler: Listener) => listeners.appState.delete(handler);
  qa.register('appstate', (params) => {
    const next = String((params as { state?: string } | undefined)?.state ?? 'active');
    if (!['active', 'background', 'inactive'].includes(next)) throw new Error(`appstate: "${next}" is not active, background or inactive`);
    appState.currentState = next;
    log(`app state → ${next} (${listeners.appState.size} listener(s))`);
    for (const listener of [...listeners.appState]) listener(next);
    return { state: next, listeners: listeners.appState.size };
  });
};

// LYNKEUS_EPOCH (set by `case run --epoch`): Date starts at that instant and runs on from there.
const launchOffset = (): number => {
  const epoch = process.env.LYNKEUS_EPOCH;
  if (!epoch) return 0;
  const at = Date.parse(epoch);
  return Number.isNaN(at) ? 0 : at - Date.now();
};

// What `clock --advance` moves: the app's timers. They run on real time as ever (a countdown still ticks in real
// seconds), but each is also written down here with the moment it is due, so an advance can run the ones that fall
// inside it, each at its own due time, without waiting. A library such as @sinonjs/fake-timers stops time or moves it in
// steps of its own and swaps Date for its own, which would fight the epoch and the offsets Date answers with.
const ADVANCE_RUN_LIMIT = 100_000;

type VirtualTimer = {
  id: number;
  callback: (...args: unknown[]) => void;
  args: unknown[];
  dueMs: number;
  delayMs: number;
  periodMs: number | null;
  real: ReturnType<typeof setTimeout> | null;
  refed: boolean;
  seq: number;
};

// What setTimeout returns for the app, standing in for Node's Timeout: the real one behind it changes when an advance
// re-arms it, the app's reference to it must not.
class VirtualHandle {
  constructor(
    private readonly timer: VirtualTimer,
    private readonly onRefresh: (timer: VirtualTimer) => void,
    private readonly onClose: (timer: VirtualTimer) => void,
  ) {}
  ref() {
    this.timer.refed = true;
    this.timer.real?.ref();
    return this;
  }
  unref() {
    this.timer.refed = false;
    this.timer.real?.unref();
    return this;
  }
  hasRef() {
    return this.timer.refed;
  }
  refresh() {
    this.onRefresh(this.timer);
    return this;
  }
  close() {
    this.onClose(this.timer);
    return this;
  }
  [Symbol.toPrimitive]() {
    return this.timer.id;
  }
}

// Installed before the app loads, so a module that captures `Date` or `setTimeout` captures these.
const installClock = () => {
  const RealDate = Date;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const realSetImmediate = globalThis.setImmediate;
  const launched = launchOffset();
  let offsetMs = launched;
  // While an advance runs, the instant Date answers, exactly, whatever the real clock reads meanwhile.
  let frozenDateMs: number | null = null;
  class ControlledDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(ControlledDate.now());
      else super(...(args as [number]));
    }
    static now() {
      return frozenDateMs ?? RealDate.now() + offsetMs;
    }
  }
  (globalThis as { Date: unknown }).Date = ControlledDate;

  // The timers' own clock: the real one plus everything advanced so far. `--now` and `--reset` do not touch it.
  let skewMs = 0;
  let frozenTimerMs: number | null = null;
  const timerNow = () => frozenTimerMs ?? RealDate.now() + skewMs;
  const timers = new Map<number, VirtualTimer>();
  let nextId = 1;
  let nextSeq = 0;

  const arm = (timer: VirtualTimer) => {
    timer.real = realSetTimeout(() => runReal(timer), Math.max(timer.dueMs - timerNow(), 0));
    if (!timer.refed) timer.real.unref();
  };
  const disarm = (timer: VirtualTimer) => {
    if (timer.real !== null) realClearTimeout(timer.real);
    timer.real = null;
  };
  // A timer coming due: a one-shot is forgotten first, an interval is set for its next turn first, so the callback
  // can clear its own.
  const fire = (timer: VirtualTimer) => {
    if (timer.periodMs === null) {
      timers.delete(timer.id);
    } else {
      timer.dueMs += timer.periodMs;
      if (frozenTimerMs === null) arm(timer);
    }
    timer.callback(...timer.args);
  };
  const runReal = (timer: VirtualTimer) => {
    timer.real = null;
    // An interval that was blocked for a while runs once, not once for every turn it missed.
    if (timer.periodMs !== null) timer.dueMs = Math.max(timer.dueMs, timerNow());
    fire(timer);
  };
  const forget = (timer: VirtualTimer) => {
    disarm(timer);
    timers.delete(timer.id);
  };
  const refresh = (timer: VirtualTimer) => {
    if (!timers.has(timer.id)) return;
    disarm(timer);
    timer.dueMs = timerNow() + timer.delayMs;
    if (frozenTimerMs === null) arm(timer);
  };
  const create = (callback: unknown, delay: unknown, args: unknown[], repeat: boolean) => {
    if (typeof callback !== 'function') throw new TypeError('The "callback" argument must be of type function');
    const wait = Math.max(Number(delay) || 1, 1);
    const timer: VirtualTimer = {
      id: nextId++,
      callback: callback as VirtualTimer['callback'],
      args,
      delayMs: wait,
      dueMs: timerNow() + wait,
      periodMs: repeat ? wait : null,
      real: null,
      refed: true,
      seq: nextSeq++,
    };
    timers.set(timer.id, timer);
    // During an advance nothing runs on real time: the advance re-arms what is left when it ends.
    if (frozenTimerMs === null) arm(timer);
    return new VirtualHandle(timer, refresh, forget);
  };
  const clear = (handle: unknown) => {
    const id = typeof handle === 'number' ? handle : handle instanceof VirtualHandle ? Number(handle) : null;
    const timer = id === null ? undefined : timers.get(id);
    if (timer) forget(timer);
  };
  const g = globalThis as Record<string, unknown>;
  g.setTimeout = (callback: unknown, delay?: unknown, ...args: unknown[]) => create(callback, delay, args, false);
  g.setInterval = (callback: unknown, delay?: unknown, ...args: unknown[]) => create(callback, delay, args, true);
  g.clearTimeout = clear;
  g.clearInterval = clear;

  const nextDue = (): VirtualTimer | undefined => {
    let next: VirtualTimer | undefined;
    for (const timer of timers.values()) {
      if (!next || timer.dueMs < next.dueMs || (timer.dueMs === next.dueMs && timer.seq < next.seq)) next = timer;
    }
    return next;
  };
  const nextDueIn = (): number | null => {
    const next = nextDue();
    return next ? Math.max(next.dueMs - timerNow(), 0) : null;
  };

  // Moves the clock `ms` forward and runs every timer that falls due inside it, in due order, each at its own due
  // time: Date answers that instant in the callback, and a timer it sets for later is due relative to it. Promise
  // work a callback sets off runs before the next timer does. A timer that keeps re-arming itself inside the window
  // would never let it end: after ADVANCE_RUN_LIMIT runs the advance stops and says so.
  let advancing = false;
  const advance = async (ms: number) => {
    if (!Number.isFinite(ms) || ms < 0) throw new Error(`clock: cannot advance by ${ms} ms`);
    if (advancing) throw new Error('clock: an advance is already running');
    advancing = true;
    const startTimer = timerNow();
    const startDate = RealDate.now() + offsetMs;
    const endTimer = startTimer + ms;
    for (const timer of timers.values()) disarm(timer);
    let cursor = startTimer;
    frozenTimerMs = cursor;
    frozenDateMs = startDate;
    let runs = 0;
    let failure: { error: unknown } | null = null;
    let looped = false;
    try {
      for (;;) {
        const next = nextDue();
        if (!next || next.dueMs > endTimer) break;
        if (runs >= ADVANCE_RUN_LIMIT) {
          looped = true;
          break;
        }
        cursor = Math.max(next.dueMs, cursor);
        frozenTimerMs = cursor;
        frozenDateMs = startDate + (cursor - startTimer);
        runs += 1;
        try {
          fire(next);
        } catch (error) {
          failure ??= { error };
        }
        await new Promise<void>((resolve) => realSetImmediate(resolve));
      }
    } finally {
      const reached = looped ? cursor : endTimer;
      frozenTimerMs = null;
      frozenDateMs = null;
      skewMs = reached - RealDate.now();
      offsetMs = startDate + (reached - startTimer) - RealDate.now();
      for (const timer of timers.values()) arm(timer);
      advancing = false;
    }
    if (looped) {
      throw new Error(
        `clock: advance stopped after ${ADVANCE_RUN_LIMIT} timer runs, ${Math.round(cursor - startTimer)} of ${ms} ms in: a timer that sets itself again keeps the window open (a setInterval with a short period, or a setTimeout that calls itself)`,
      );
    }
    if (failure) throw failure.error;
    return ms;
  };

  onReset(() => {
    offsetMs = launched;
  });
  qa.register('clock', async (params) => {
    const p = (params ?? {}) as { now?: string; advanceMs?: number; reset?: boolean; settle?: boolean };
    if (p.reset) offsetMs = launched;
    if (p.now) {
      const target = RealDate.parse(p.now);
      if (Number.isNaN(target)) throw new Error(`clock: cannot parse "${p.now}"`);
      offsetMs = target - RealDate.now();
    }
    const moved = typeof p.advanceMs === 'number' ? await advance(p.advanceMs) : 0;
    const answer = () => ({ now: new ControlledDate().toISOString(), offsetMs, advancedMs: moved, nextDueMs: nextDueIn() });
    if (!p.settle) {
      const done = answer();
      log(`clock → ${done.now} (offset ${Math.round(offsetMs / 1000)}s${moved ? `, advanced ${moved} ms` : ''})`);
      return done;
    }
    const settled = await settle();
    const done = { ...answer(), ...settled };
    log(`clock → ${done.now} (offset ${Math.round(offsetMs / 1000)}s), ${settled.settled ? 'settled' : 'not settled'}`);
    return done;
  });
};

// LYNKEUS_SEED (set by `case run --seed`): Math.random repeats from the same place at launch and after every reset,
// so the app draws the same ids and names in every run. crypto's generators are left alone.
const installSeed = () => {
  const seed = process.env.LYNKEUS_SEED;
  if (!seed) return;
  const start = (): number => {
    let hash = 2166136261;
    for (const char of seed) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    return hash >>> 0;
  };
  let state = start();
  Math.random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  onReset(() => {
    state = start();
  });
};

/** What `clock --settle` reads from the host: how many commits the screen has had, how many requests are out and how many are held. */
export type SettleProbe = { commits: () => number; inFlight: () => number; held?: () => number };
let probe: SettleProbe | undefined;
export const setSettleProbe = (next: SettleProbe | undefined): void => {
  probe = next;
};

const SETTLE_TURN_MS = 2;
const SETTLE_QUIET_TURNS = 3;
const SETTLE_MAX_TURNS = 100;

// Timers here are real, so time cannot be held still. What settle does not do is wait for the app's delayed work: it
// gives the event loop a few short turns (microtasks, immediates, a zero-delay timer or two) and stops once the screen
// has not committed for three in a row. A timer due later stays pending; a loop that re-arms itself never goes quiet
// and the answer says so.
const settle = async () => {
  if (!probe) throw new Error('clock: settle needs the host running');
  let quiet = 0;
  let turns = 0;
  while (quiet < SETTLE_QUIET_TURNS && turns < SETTLE_MAX_TURNS) {
    const before = probe.commits();
    await new Promise((resolve) => setTimeout(resolve, SETTLE_TURN_MS));
    turns += 1;
    quiet = probe.commits() === before ? quiet + 1 : 0;
  }
  return { settled: quiet >= SETTLE_QUIET_TURNS, turns, commit: probe.commits(), inFlight: probe.inFlight(), held: probe.held?.() ?? 0 };
};

export type NetRule = {
  method: string;
  path: string;
  status: number;
  body?: string;
  headers?: Record<string, string>;
  delayMs?: number;
  times?: number;
  hits: number;
  sticky?: boolean;
  lost?: boolean;
};
type Recorded = { method: string; path: string; status: number; body: string };
/** A gate: requests that match wait where they are until `release`, then go on to a rule or the network. */
type Hold = { method: string; path: string; times?: number; hits: number; sticky?: boolean };
type Held = { method: string; path: string; since: number; go: () => void };
const net = { rules: [] as NetRule[], holds: [] as Hold[], held: [] as Held[], recording: false, recorded: [] as Recorded[] };

const releaseHeld = (route?: { method: string; path: string }): number => {
  const [released, kept] = [[], []] as [Held[], Held[]];
  for (const h of net.held) (!route || matches(route, h.method, h.path) ? released : kept).push(h);
  net.held = kept;
  for (const h of released) h.go();
  return released.length;
};

export const pathOf = (url: string) => {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
};

const matches = (rule: Pick<NetRule, 'method' | 'path'>, method: string, path: string) =>
  (rule.method === '*' || rule.method === method) && (rule.path.startsWith('^') ? new RegExp(rule.path).test(path) : path.includes(rule.path));

// Consulted by the fetch fence before the real network.
export const netControls = {
  match(method: string, url: string): NetRule | null {
    const path = pathOf(url);
    const rule = net.rules.find((r) => (r.times === undefined || r.hits < r.times) && matches(r, method.toUpperCase(), path));
    if (rule) rule.hits += 1;
    return rule ?? null;
  },
  /** A promise that settles once the driver releases this request, or undefined when no hold applies to it. */
  hold(method: string, url: string): Promise<void> | undefined {
    const path = pathOf(url);
    const gate = net.holds.find((h) => (h.times === undefined || h.hits < h.times) && matches(h, method.toUpperCase(), path));
    if (!gate) return undefined;
    gate.hits += 1;
    log(`netmock: holding ${method.toUpperCase()} ${path}`);
    return new Promise<void>((go) => {
      net.held.push({ method: method.toUpperCase(), path, since: Date.now(), go });
    });
  },
  async respond(rule: NetRule, ResponseCtor: new (body: string | null, init: { status: number; headers?: Record<string, string> }) => unknown) {
    if (rule.delayMs) await new Promise((resolve) => setTimeout(resolve, rule.delayMs));
    // The agent reads this to tell a mocked answer from the server's (lynkeus-agent requests.ts, MOCKED_HEADER).
    const headers = { 'content-type': 'application/json', ...rule.headers, 'x-lynkeus-mocked': '1' };
    return new ResponseCtor(rule.body ?? (rule.status === 204 ? null : '{}'), { status: rule.status, headers });
  },
  recording: () => net.recording,
  record(entry: Recorded) {
    net.recorded.push(entry);
  },
};

const installNetMock = () => {
  countHeldFrom(() => net.held.length);
  onReset(() => {
    // A sticky rule outlives a reset: it is how a case makes the first load fail, since a login starts with one.
    net.rules = net.rules.filter((r) => r.sticky);
    net.holds = net.holds.filter((h) => h.sticky);
    // What the last app was waiting for goes on, so no promise is left hanging; the new app never sees the answers.
    releaseHeld();
    net.recording = false;
  });
  qa.register('netmock', (params) => {
    const p = (params ?? {}) as Partial<NetRule> & { action?: string; entries?: Recorded[] };
    switch (p.action ?? 'add') {
      case 'add': {
        if (!p.path) throw new Error('netmock: add needs a path (substring, or ^regex)');
        const rule: NetRule = {
          method: (p.method ?? '*').toUpperCase(),
          path: p.path,
          status: p.status ?? 200,
          body: p.body,
          headers: p.headers,
          delayMs: p.delayMs,
          times: p.times,
          hits: 0,
          sticky: p.sticky,
          lost: p.lost,
        };
        net.rules.unshift(rule);
        log(
          `netmock: ${rule.method} ${rule.path} → ${rule.lost ? 'lost' : rule.status}${rule.delayMs ? ` after ${rule.delayMs}ms` : ''}${rule.times ? ` ×${rule.times}` : ''}`,
        );
        return { rules: net.rules.length };
      }
      case 'hold': {
        if (!p.path) throw new Error('netmock: hold needs a path (substring, or ^regex)');
        net.holds.unshift({ method: (p.method ?? '*').toUpperCase(), path: p.path, times: p.times, hits: 0, sticky: p.sticky });
        return { holds: net.holds.length, held: net.held.length };
      }
      case 'release': {
        const released = releaseHeld(p.path ? { method: (p.method ?? '*').toUpperCase(), path: p.path } : undefined);
        log(`netmock: released ${released} held request(s)`);
        return { released, held: net.held.length };
      }
      case 'clear':
        net.rules = [];
        net.holds = [];
        releaseHeld();
        return { rules: 0 };
      case 'list':
        return {
          rules: net.rules,
          holds: net.holds,
          held: net.held.map((h) => ({ method: h.method, path: h.path, heldMs: Date.now() - h.since })),
        };
      case 'record':
        net.recording = true;
        net.recorded = [];
        return { recording: true };
      case 'dump':
        net.recording = false;
        return { recorded: net.recorded };
      case 'replay':
        for (const e of p.entries ?? []) net.rules.push({ method: e.method, path: e.path, status: e.status, body: e.body, hits: 0 });
        return { rules: net.rules.length };
      default:
        throw new Error(`netmock: unknown action "${p.action}"`);
    }
  });
};

type Closable = { close?: (code?: number) => void; terminate?: () => void; readyState?: number };
type NetInfoState = { type: string; isConnected: boolean; isInternetReachable: boolean; details: null };
const connectivity = { offline: false, sockets: new Set<Closable>(), netInfoListeners: new Set<(state: NetInfoState) => void>() };

const netInfoState = (): NetInfoState =>
  connectivity.offline
    ? { type: 'none', isConnected: false, isInternetReachable: false, details: null }
    : { type: 'wifi', isConnected: true, isInternetReachable: true, details: null };

// Airplane mode, as the fences and NetInfo see it.
export const connectivityControls = {
  offline: () => connectivity.offline,
  track(socket: Closable) {
    connectivity.sockets.add(socket);
  },
  netInfo: netInfoState,
  subscribe(listener: (state: NetInfoState) => void) {
    connectivity.netInfoListeners.add(listener);
    return () => connectivity.netInfoListeners.delete(listener);
  },
};

const setOffline = (offline: boolean) => {
  if (connectivity.offline === offline) return;
  connectivity.offline = offline;
  if (offline) {
    for (const socket of connectivity.sockets) {
      if (socket.readyState === 3) continue;
      if (typeof socket.terminate === 'function') socket.terminate();
      else socket.close?.(1006);
    }
    connectivity.sockets.clear();
  }
  const state = netInfoState();
  for (const listener of connectivity.netInfoListeners) listener(state);
  log(`network: ${offline ? 'off (requests fail, sockets dropped)' : 'on'}`);
};

const installConnectivity = () => {
  onReset(() => setOffline(false));
  qa.register('network', (params) => {
    const state = (params as { state?: string } | undefined)?.state;
    if (state !== 'on' && state !== 'off') throw new Error('network needs { state: "on" | "off" }');
    setOffline(state === 'off');
    return { offline: connectivity.offline, listeners: connectivity.netInfoListeners.size };
  });
};

// Registered with the rest rather than in their factories: a factory runs when
// its module is first required, which for a screen-local import is after the
// driver already asked.
const installDevices = () => {
  onReset(() => {
    sensor.queue = [];
    sensor.fallback = 'fail';
    sensor.keys = false;
    sensor.prompts = 0;
    pickerQueue.length = 0;
  });
  qa.register('biometrics', (params) => {
    const p = (params ?? {}) as { available?: string | null; next?: BiometricOutcome | BiometricOutcome[]; fallback?: BiometricOutcome };
    if (p.available !== undefined) sensor.available = p.available === 'none' || p.available === null ? null : (p.available as typeof sensor.available);
    if (p.next) sensor.queue.push(...([] as BiometricOutcome[]).concat(p.next));
    if (p.fallback) sensor.fallback = p.fallback;
    if (!sensor.mocked)
      log(
        "biometrics: no biometrics mock loaded; pass `biometrics` from 'lynkeus-headless/mocks' in installDefaultMocks({ overrides: { 'react-native-biometrics': biometrics } })",
      );
    return { available: sensor.available, queue: [...sensor.queue], fallback: sensor.fallback, prompts: sensor.prompts };
  });
  qa.register('webview', (params) => {
    const p = (params ?? {}) as { action?: string; data?: unknown; url?: string };
    if (p.action === 'list') return { mounted: webviews.map((w) => w.props.source?.uri ?? 'about:blank') };
    const target = webviews[webviews.length - 1];
    if (!target) throw new Error('webview: none mounted');
    const uri = target.props.source?.uri ?? '';
    if (p.action === 'message') {
      const data = typeof p.data === 'string' ? p.data : JSON.stringify(p.data ?? '');
      target.props.onMessage?.({ nativeEvent: { data, url: uri } });
      log(`webview: message → ${uri || 'about:blank'}`);
      return { delivered: true, to: uri };
    }
    if (p.action === 'navigate') {
      const url = String(p.url ?? '');
      const allowed = target.props.onShouldStartLoadWithRequest?.({ url }) ?? true;
      if (allowed) target.props.onNavigationStateChange?.({ url, loading: false, canGoBack: true, canGoForward: false, title: '' });
      return { navigated: allowed, url };
    }
    throw new Error(`webview: unknown action "${p.action}" (message | navigate | list)`);
  });
  qa.register('scan', (params) => {
    const p = (params ?? {}) as { value?: string; type?: string };
    if (!p.value) throw new Error('scan needs { value }');
    const camera = cameras[cameras.length - 1];
    if (!camera)
      throw new Error(
        "scan: no camera mounted (is the scanner open? react-native-vision-camera needs the opt-in mock: installDefaultMocks({ overrides: { 'react-native-vision-camera': visionCamera } }))",
      );
    const scanner = camera.props.codeScanner;
    if (!scanner?.onCodeScanned) throw new Error('scan: the mounted camera has no codeScanner');
    const type = p.type ?? 'qr';
    scanner.onCodeScanned([{ value: p.value, type, frame: { x: 0, y: 0, width: 100, height: 100 } }], { width: 1080, height: 1920 });
    log(`scan: ${type} "${p.value.slice(0, 60)}" → codeScanner`);
    return { scanned: p.value, cameras: cameras.length };
  });
  qa.register('gallery', (params) => {
    const p = (params ?? {}) as { uri?: string; cancel?: boolean; fileName?: string; type?: string; width?: number; height?: number };
    if (p.cancel) pickerQueue.push(null);
    else if (p.uri) pickerQueue.push({ uri: p.uri, fileName: p.fileName, type: p.type, width: p.width, height: p.height });
    else throw new Error('gallery needs { uri } or { cancel: true }');
    return { queued: pickerQueue.length };
  });
};

export const installControls = (initialUrl: string | null = null): void => {
  installLinking(initialUrl);
  installAppState();
  installClock();
  installSeed();
  installNetMock();
  installConnectivity();
  installDevices();
};

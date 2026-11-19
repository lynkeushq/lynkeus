// What a device gets from the OS, set by the driver at run time as `qa`
// commands: deep links, app state, the clock, the network and its answers,
// and the sensors, camera, picker and WebViews the factories stand in for.
import { qa } from 'lynkeus-agent';
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

// Timers stay real, so a countdown still ticks in real seconds. Installed
// before the app loads, so a module that captures `Date` captures this one.
const installClock = () => {
  const RealDate = Date;
  const launched = launchOffset();
  let offsetMs = launched;
  class ControlledDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(RealDate.now() + offsetMs);
      else super(...(args as [number]));
    }
    static now() {
      return RealDate.now() + offsetMs;
    }
  }
  (globalThis as { Date: unknown }).Date = ControlledDate;
  onReset(() => {
    offsetMs = launched;
  });
  qa.register('clock', (params) => {
    const p = (params ?? {}) as { now?: string; advanceMs?: number; reset?: boolean; settle?: boolean };
    if (p.reset) offsetMs = launched;
    if (p.now) {
      const target = RealDate.parse(p.now);
      if (Number.isNaN(target)) throw new Error(`clock: cannot parse "${p.now}"`);
      offsetMs = target - RealDate.now();
    }
    if (typeof p.advanceMs === 'number') offsetMs += p.advanceMs;
    const answer = () => ({ now: new ControlledDate().toISOString(), offsetMs });
    if (!p.settle) {
      const done = answer();
      log(`clock → ${done.now} (offset ${Math.round(offsetMs / 1000)}s)`);
      return done;
    }
    return settle().then((settled) => {
      const done = { ...answer(), ...settled };
      log(`clock → ${done.now} (offset ${Math.round(offsetMs / 1000)}s), ${settled.settled ? 'settled' : 'not settled'}`);
      return done;
    });
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

/** What `clock --settle` reads from the host: how many commits the screen has had and how many requests are out. */
export type SettleProbe = { commits: () => number; inFlight: () => number };
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
  return { settled: quiet >= SETTLE_QUIET_TURNS, turns, commit: probe.commits(), inFlight: probe.inFlight() };
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
const net = { rules: [] as NetRule[], recording: false, recorded: [] as Recorded[] };

export const pathOf = (url: string) => {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
};

const matches = (rule: NetRule, method: string, path: string) =>
  (rule.method === '*' || rule.method === method) && (rule.path.startsWith('^') ? new RegExp(rule.path).test(path) : path.includes(rule.path));

// Consulted by the fetch fence before the real network.
export const netControls = {
  match(method: string, url: string): NetRule | null {
    const path = pathOf(url);
    const rule = net.rules.find((r) => (r.times === undefined || r.hits < r.times) && matches(r, method.toUpperCase(), path));
    if (rule) rule.hits += 1;
    return rule ?? null;
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
  onReset(() => {
    // A sticky rule outlives a reset: it is how a case makes the first load fail, since a login starts with one.
    net.rules = net.rules.filter((r) => r.sticky);
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
      case 'clear':
        net.rules = [];
        return { rules: 0 };
      case 'list':
        return { rules: net.rules };
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
    if (!camera) throw new Error('scan: no camera mounted (is the scanner open?)');
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

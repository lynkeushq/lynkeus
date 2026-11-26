import { installRuntime, log, resolvable } from '../runtime.js';
import { installAnalytics } from './analytics.js';
import { installNativeMocks } from './native.js';
import { installNativeValues } from './nativeValues.js';
import { connectivityControls, installControls, netControls, pathOf } from './controls.js';
import {
  asyncStorage,
  deviceInfo,
  keychain,
  localize,
  mmkv,
  pagerView,
  safeAreaContext,
  webView,
  worklets,
  type DeviceVersion,
  type LocaleDefault,
  type MockFactory,
} from './factories.js';
import { shippedMocks } from './shipped.js';

// jest injects `jest` as a module-scoped local, not onto globalThis.
declare const jest: {
  doMock(name: string, factory: () => unknown): void;
  requireMock(name: string): Record<string, unknown>;
  requireActual(name: string): unknown;
};

export type InstallOptions = {
  /** Modules to leave alone, to mock yourself. */
  skip?: string[];
  /**
   * Module name → factory: the app's own mocks, and the opt-in ones this package ships (`biometrics`, `visionCamera`,
   * `imagePicker`, `video`, `fastImage`, `inAppReview`, `vectorIconsNative` from 'lynkeus-headless/mocks'). Wins over
   * every default and applies even when the module is not installed.
   */
  overrides?: Record<string, MockFactory>;
  /** 'real' swaps jest's banned fetch for Node's own, fenced by `networkHosts`. */
  network?: 'real' | 'banned';
  /** Hosts real network and sockets may reach; anything else is refused at once. Default: local hosts only. */
  networkHosts?: string[];
  /**
   * What `WebSocket` is: 'stub' (default) connects and stays silent, 'real' is
   * Node's `ws` fenced by `networkHosts`, 'none' leaves jest's undefined. A
   * realtime layer that throws on connect can unwind a login.
   */
  websocket?: 'stub' | 'real' | 'none';
  /**
   * reanimated's mock completes withTiming/withSpring synchronously, so an
   * overlay that flips a store on completion animates again in the same tick,
   * forever. 'deferred' (default) moves completions to the next tick; 'sync'
   * leaves the mock as the app registered it.
   */
  animations?: 'deferred' | 'sync';
  /** Default 9.9.9 / 9999 / iOS. */
  deviceVersion?: DeviceVersion;
  /** Default US / en-US / en. */
  locale?: LocaleDefault;
  /** What Linking.getInitialURL answers: the deep link the app was opened with. */
  initialUrl?: string | null;
};

// `case run --locale` and `--time-zone` reach the host as LYNKEUS_LOCALE and LYNKEUS_TIME_ZONE and win over the entry's defaults.
export const launchLocale = (base: LocaleDefault = {}, env: NodeJS.ProcessEnv = process.env): LocaleDefault => {
  const tag = env.LYNKEUS_LOCALE;
  const parsed = tag ? new Intl.Locale(tag) : undefined;
  return {
    ...base,
    ...(parsed ? { languageTag: parsed.toString(), languageCode: parsed.language, ...(parsed.region ? { country: parsed.region } : {}) } : {}),
    ...(env.LYNKEUS_TIME_ZONE ? { timeZone: env.LYNKEUS_TIME_ZONE } : {}),
  };
};

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '10.0.2.2'];

// A hosted app must not reach third parties (analytics, auth providers): refuse
// fast and say so once per host.
const hostFence = (hosts: string[], kind: string, protocols?: Set<string>) => {
  const allowed = new Set(hosts);
  const refused = new Set<string>();
  return (url: string): string | undefined => {
    let parsed: URL | undefined;
    try {
      parsed = new URL(url);
    } catch {
      // The network implementation rejects malformed URLs without connecting.
    }
    if (protocols && (!parsed || !protocols.has(parsed.protocol))) return parsed?.protocol ?? 'invalid URL';
    const host = parsed?.hostname ?? '';
    if (!host || allowed.has(host)) return undefined;
    if (!refused.has(host)) {
      refused.add(host);
      log(`${kind}: refused ${host} (not in networkHosts)`);
    }
    return host;
  };
};

type Fetch = (input: unknown, init?: unknown) => Promise<unknown>;

/** The cause a failed fetch carries (undici puts the socket's error under `cause`, sometimes several). */
const unreachable = (error: unknown): string | undefined => {
  const cause = (error as { cause?: { code?: string; errors?: { code?: string }[] } } | null)?.cause;
  const code = cause?.code ?? cause?.errors?.find((e) => e.code)?.code;
  return code && ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ETIMEDOUT', 'ECONNRESET'].includes(code) ? code : undefined;
};

// Node's fetch parses a body in Node's own realm, so a body that is not JSON rejects with Node's SyntaxError, not
// the SyntaxError of jest's sandbox the app runs in: an app's `error instanceof SyntaxError` (an empty 404, say)
// failed here and holds on a phone. The answer's json() rethrows such an error as the sandbox's own.
const ownErrors = (response: unknown): unknown => {
  const r = response as { json?: () => Promise<unknown> } | null;
  if (typeof r?.json !== 'function') return response;
  const json = r.json.bind(r);
  r.json = () =>
    json().catch((error: unknown) => {
      const outer = error as { name?: unknown; message?: unknown } | null;
      if (error instanceof SyntaxError || outer?.name !== 'SyntaxError') throw error;
      throw Object.assign(new SyntaxError(String(outer.message)), { cause: error });
    });
  return response;
};

const REDIRECTS = [301, 302, 303, 307, 308];
const MAX_REDIRECTS = 5;

// The fence must see every hop, so redirects are followed here one at a time instead of by the underlying fetch.
// Method and body follow what fetch does: 303 (and 301/302 after a POST) become a GET without a body.
const followAllowed = async (
  fetchImpl: Fetch,
  refuse: (url: string) => string | undefined,
  input: Parameters<Fetch>[0],
  init: RequestInit | undefined,
  firstUrl: string,
  firstMethod: string,
): Promise<Awaited<ReturnType<Fetch>>> => {
  const mode = init?.redirect ?? (input as { redirect?: string } | null)?.redirect ?? 'follow';
  let target: Parameters<Fetch>[0] = input;
  let options: RequestInit = { ...init, redirect: 'manual' };
  let url = firstUrl;
  let method = firstMethod;
  for (let hop = 0; ; hop++) {
    const response = await fetchImpl(target, options);
    const r = response as { status: number; url: string; headers: { get(name: string): string | null } };
    const location = REDIRECTS.includes(r.status) ? r.headers.get('location') : null;
    if (!location) return response;
    const next = new URL(location, r.url || url).toString();
    const refusedNext = refuse(next);
    if (refusedNext) throw new Error(`lynkeus headless: network to ${refusedNext} is off (networkHosts)`);
    if (mode === 'manual') return response;
    if (mode === 'error') throw new TypeError('Network request failed: unexpected redirect');
    if (hop >= MAX_REDIRECTS) throw new TypeError(`Network request failed: more than ${MAX_REDIRECTS} redirects`);
    const toGet = r.status === 303 ? method !== 'HEAD' : (r.status === 301 || r.status === 302) && method === 'POST';
    const headers = new Headers(
      options.headers ?? (typeof input === 'object' && input !== null ? (input as { headers?: RequestInit['headers'] }).headers : undefined),
    );
    if (new URL(next).origin !== new URL(url).origin) {
      headers.delete('authorization');
      headers.delete('cookie');
    }
    options = { ...options, headers };
    options.method = method;
    if (toGet) {
      method = 'GET';
      options.method = 'GET';
      delete options.body;
      headers.delete('content-type');
      headers.delete('content-length');
    }
    target = next;
    url = next;
  }
};

const fencedFetch = (fetchImpl: Fetch, hosts: string[]): Fetch => {
  const refuse = hostFence(hosts, 'network');
  // A backend that is not up, or an API base the app took from its default because the env var was not set,
  // otherwise shows only as screens that never load: say it once per address.
  const silent = new Set<string>();
  const told = (url: string) => (error: unknown) => {
    const code = unreachable(error);
    let origin = url;
    try {
      origin = new URL(url).origin;
    } catch {
      // not a URL; keep it whole
    }
    if (code && !silent.has(origin)) {
      silent.add(origin);
      log(
        `network: ${origin} did not answer (${code}). Is the backend up, and is that the address the app should use? An app reads it from the env var lynkeus.config.json names in apiEnv.`,
      );
    }
    throw error;
  };
  const send: Fetch = (input, init) => {
    const url = typeof input === 'string' ? input : ((input as { url?: string } | null)?.url ?? String(input));
    const method = String((init as { method?: string } | undefined)?.method ?? (input as { method?: string } | null)?.method ?? 'GET').toUpperCase();
    const rule = connectivityControls.offline() ? undefined : netControls.match(method, url);
    // A request a case answers never leaves the process, so the fence has nothing to keep it from: an app whose API is
    // a third party's (a public feed) is still driven through its mocked answers.
    if (rule && !rule.lost)
      return netControls.respond(rule, (globalThis as unknown as { Response: Parameters<typeof netControls.respond>[1] }).Response).then(ownErrors);
    const refused = refuse(url);
    if (refused) return Promise.reject(new Error(`lynkeus headless: network to ${refused} is off (networkHosts)`));
    if (connectivityControls.offline()) return Promise.reject(new TypeError('Network request failed'));
    if (rule?.lost) {
      const lost = (response?: unknown) => {
        log(`network: lost the answer to ${method} ${url} (${(response as { status?: number } | undefined)?.status ?? 'no answer'})`);
        // Marked for the agent: a lost answer is the case's doing, not the backend's.
        throw Object.assign(new TypeError('Network request failed'), { lynkeusMocked: true });
      };
      return fetchImpl(input, init).then(lost, () => lost());
    }
    const guarded = followAllowed(fetchImpl, refuse, input, init as RequestInit | undefined, url, method);
    const result = guarded.then(ownErrors, told(url));
    if (!netControls.recording()) return result;
    return result.then(async (response) => {
      const r = response as { clone: () => { text: () => Promise<string> }; status: number };
      try {
        netControls.record({ method, path: pathOf(url), status: r.status, body: await r.clone().text() });
      } catch {
        // a body that cannot be read twice is not worth failing the request for
      }
      return response;
    });
  };
  // A request the driver holds waits here, before any rule or the network sees it: the app shows its loading state
  // for as long as the case wants.
  return (input, init) => {
    const url = typeof input === 'string' ? input : ((input as { url?: string } | null)?.url ?? String(input));
    const method = String((init as { method?: string } | undefined)?.method ?? (input as { method?: string } | null)?.method ?? 'GET');
    const held = netControls.hold(method, url);
    return held ? held.then(() => send(input, init)) : send(input, init);
  };
};

// Connects on the next tick and never delivers; `offline` is a socket opened in airplane mode.
class SilentWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = SilentWebSocket.CONNECTING;
  protocol = '';
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  private failing = false;
  private readonly listeners = new Map<string, Set<(e: unknown) => void>>();

  static offline(url: string): SilentWebSocket {
    const socket = new SilentWebSocket(url);
    socket.failing = true;
    socket.readyState = SilentWebSocket.CLOSED;
    return socket;
  }

  constructor(readonly url: string) {
    setTimeout(() => {
      if (this.failing) {
        this.emit('error', { type: 'error', message: 'offline' });
        this.emit('close', { type: 'close', code: 1006, reason: 'offline', wasClean: false });
        return;
      }
      this.readyState = SilentWebSocket.OPEN;
      this.emit('open', { type: 'open' });
    }, 0);
  }

  send() {}

  close() {
    if (this.readyState === SilentWebSocket.CLOSED) return;
    this.readyState = SilentWebSocket.CLOSED;
    this.emit('close', { type: 'close', code: 1000, reason: '', wasClean: true });
  }

  addEventListener(type: string, fn: (e: unknown) => void) {
    (this.listeners.get(type) ?? this.listeners.set(type, new Set()).get(type)!).add(fn);
  }

  removeEventListener(type: string, fn: (e: unknown) => void) {
    this.listeners.get(type)?.delete(fn);
  }

  private emit(type: 'open' | 'error' | 'close', event: unknown) {
    this[`on${type}`]?.(event);
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
}

type SocketClass = new (url: string, protocols?: string | string[], options?: unknown) => unknown;

// A socket to production would be worse than a stray fetch, since it stays
// open. A refused host gets the silent stub, so the realtime layer sees
// "connected" and nothing more.
const fencedWebSocket = (Real: SocketClass, hosts: string[]) => {
  const refuse = hostFence(hosts, 'websocket', new Set(['ws:', 'wss:']));
  // A client compares readyState against the constants on the class it was
  // handed, so the fence must carry them.
  return class FencedWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    // biome-ignore-start lint/correctness/noConstructorReturn: the fence hands back the real socket, a stub or a dead one
    constructor(url: string, protocols?: string | string[], options?: unknown) {
      if (refuse(url)) return new SilentWebSocket(url) as unknown as FencedWebSocket;
      if (connectivityControls.offline()) return SilentWebSocket.offline(url) as unknown as FencedWebSocket;
      const socket = new Real(url, protocols, { ...(options as object | undefined), maxRedirects: 0 }) as FencedWebSocket;
      connectivityControls.track(socket);
      return socket;
    }
    // biome-ignore-end lint/correctness/noConstructorReturn: the fence hands back the real socket, a stub or a dead one
  };
};

const installWebSocket = (mode: InstallOptions['websocket'], hosts: string[]) => {
  const g = globalThis as { WebSocket?: unknown };
  if (mode === 'real' && resolvable('ws')) {
    g.WebSocket = fencedWebSocket((require('ws') as { WebSocket: SocketClass }).WebSocket, hosts);
    log(`websocket: real (ws, fenced to ${hosts.join(', ')})`);
  } else if (mode === 'real') {
    g.WebSocket = SilentWebSocket;
    log('websocket: "real" requested but `ws` is not installed; stub instead');
  } else if (mode === 'stub' && g.WebSocket === undefined) {
    g.WebSocket = SilentWebSocket;
    log('websocket: stub (connects, never delivers)');
  }
};

// jest's sandbox shadows fetch with a rejecting stub, and even `Function()`
// resolves globals inside it. vm.runInThisContext evaluates in the process
// context, the one path out to Node's own fetch (undici), which handles
// Request objects and streams where node-fetch v2 does not.
const installRealNetwork = (hosts: string[]) => {
  const g = globalThis as Record<string, unknown>;
  const vm = require('node:vm') as typeof import('node:vm');
  const outer = (name: string): unknown => {
    try {
      return vm.runInThisContext(`globalThis.${name}`);
    } catch {
      return undefined;
    }
  };
  const native = outer('fetch');
  if (typeof native === 'function') {
    g.fetch = fencedFetch(native as Fetch, hosts);
    for (const name of ['Headers', 'Request', 'Response', 'FormData']) {
      const value = outer(name);
      if (typeof value === 'function') g[name] = value;
    }
    log(`network: real (native fetch, node ${process.versions.node})`);
    return;
  }
  if (!resolvable('node-fetch')) {
    log('network: "real" requested but neither native fetch nor node-fetch is available; leaving fetch as-is');
    return;
  }
  const nodeFetch = require('node-fetch');
  g.fetch = fencedFetch(nodeFetch.default ?? nodeFetch, hosts);
  g.Headers ??= nodeFetch.Headers;
  g.Request ??= nodeFetch.Request;
  g.Response ??= nodeFetch.Response;
  log('network: real (node-fetch fallback)');
};

// requireMock returns the very object later requires receive, so patching it reaches the app.
const registeredMock = (name: string): Record<string, unknown> | undefined => {
  if (!resolvable(name)) return undefined;
  try {
    return jest.requireMock(name);
  } catch {
    return undefined;
  }
};

// NetInfo's mock reports wifi forever and never calls a listener; route it
// through the host's connectivity so `network off` reaches every subscriber.
const installNetInfo = () => {
  const mock = registeredMock('@react-native-community/netinfo');
  if (!mock) return;
  for (const target of [mock, mock.default]) {
    if (!target || typeof target !== 'object') continue;
    Object.assign(target, {
      addEventListener: (listener: (state: unknown) => void) => {
        listener(connectivityControls.netInfo());
        return connectivityControls.subscribe(listener);
      },
      fetch: async () => connectivityControls.netInfo(),
      refresh: async () => connectivityControls.netInfo(),
    });
  }
  log('netinfo: follows `network on|off`');
};

const deferAnimationCompletions = () => {
  const mock = registeredMock('react-native-reanimated');
  if (!mock) return;
  const patched = ['withTiming', 'withSpring', 'withDecay', 'withDelay', 'withSequence', 'withRepeat'].filter((name) => {
    const original = mock[name];
    if (typeof original !== 'function') return false;
    mock[name] = (...args: unknown[]) => {
      const at = args.findIndex((a) => typeof a === 'function');
      if (at === -1) return original(...args);
      const callback = args[at] as (...a: unknown[]) => void;
      const deferred = [...args];
      deferred[at] = (...callbackArgs: unknown[]) => setTimeout(() => callback(...callbackArgs), 0);
      return original(...deferred);
    };
    return true;
  });
  if (patched.length) log(`animations: completions deferred to the next tick (${patched.join(', ')})`);
  // Reanimated's mock returns withRepeat's animation and never calls its callback, and withSequence answers 0:
  // a screen that moves on when a repeat ends (a receipt printed six times, then the next screen) never moved on.
  if (typeof mock.withRepeat === 'function')
    mock.withRepeat = (animation: unknown, _times?: unknown, _reverse?: unknown, callback?: unknown) => {
      if (typeof callback === 'function') setTimeout(() => (callback as (finished: boolean) => void)(true), 0);
      return animation;
    };
  if (typeof mock.withSequence === 'function') mock.withSequence = (...animations: unknown[]) => animations.at(-1) ?? 0;
};

// jest-expo answers expo-constants' manifest with an empty object where a device build embeds the app config: an app
// that builds a deep link (`Linking.createURL`) then throws for want of its scheme. `headless start` reads the config
// (LYNKEUS_EXPO_CONFIG).
const installExpoConfig = () => {
  const env = process.env;
  const text = env.LYNKEUS_EXPO_CONFIG;
  if (!text || !resolvable('expo-modules-core')) return;
  // jest-expo's expo-modules-core hands out a copy of the module on every require; the copies are made from this one.
  const core = jest.requireActual('expo-modules-core') as { NativeModulesProxy?: Record<string, Record<string, unknown> | undefined> };
  const constants = core.NativeModulesProxy?.ExponentConstants;
  const current = constants?.manifest;
  if (!constants || (typeof current === 'object' && current !== null && Object.keys(current).length > 0)) return;
  try {
    constants.manifest = JSON.parse(text);
    // A development build, which is what Lynkeus drives on a device; jest-expo says 'mock', which no code path expects.
    if (!['bare', 'standalone', 'storeClient'].includes(String(constants.executionEnvironment))) constants.executionEnvironment = 'bare';
    log('expo: expo-constants reads the app config, as a development build');
  } catch {
    log('expo: LYNKEUS_EXPO_CONFIG is not JSON; expo-constants keeps an empty manifest');
  }
};

// Call at the top of the headless entry, before the app is required. Returns the modules it mocked.
export const installDefaultMocks = (options: InstallOptions = {}): string[] => {
  if (typeof jest === 'undefined') throw new Error('installDefaultMocks must run under jest (lynkeus headless).');
  installRuntime();
  const skip = new Set(options.skip ?? []);
  const overrides = options.overrides ?? {};
  const hosts = options.networkHosts ?? LOCAL_HOSTS;

  // Applied only when the module resolves in the project, and only for libraries most apps have whose generic answer
  // breaks them: storage that must keep what was written, a client version above any server gate, insets that
  // arrive, the launch locale, pages and web views the case commands drive. Anything else native gets the library's
  // own jest mock when it ships one, then the generic fallback (nativeValues.ts). Reanimated and gesture-handler are
  // left out here: gesture-handler's jest story is a setup file it ships (run below), reanimated's a babel plugin.
  const defaults: Record<string, MockFactory> = {
    'react-native-mmkv': mmkv,
    'react-native-keychain': keychain,
    'react-native-device-info': deviceInfo(options.deviceVersion),
    'react-native-safe-area-context': safeAreaContext,
    'react-native-localize': localize(launchLocale(options.locale)),
    '@react-native-async-storage/async-storage': asyncStorage,
    'react-native-worklets': worklets,
    'react-native-pager-view': pagerView,
    'react-native-webview': webView,
  };

  const installed: string[] = [];
  for (const name of new Set([...Object.keys(defaults), ...Object.keys(overrides)])) {
    if (skip.has(name)) continue;
    const factory = overrides[name] ?? (resolvable(name) ? defaults[name] : undefined);
    if (!factory) continue;
    jest.doMock(name, factory);
    installed.push(name);
  }
  const { factories: shipped, setups } = shippedMocks(new Set([...installed, ...skip]));
  for (const [name, factory] of Object.entries(shipped)) jest.doMock(name, factory);
  for (const file of Object.values(setups)) require(file);

  if (options.network === 'real') installRealNetwork(hosts);
  installControls(options.initialUrl ?? null);
  const recorders = installAnalytics();
  installNativeMocks();
  installNativeValues();
  if ((options.animations ?? 'deferred') === 'deferred') deferAnimationCompletions();
  installNetInfo();
  installExpoConfig();
  installWebSocket(options.websocket ?? 'stub', hosts);

  log(`mocked: ${installed.sort().join(', ') || '(none detected)'}`);
  if (Object.keys(shipped).length) log(`their own jest mocks: ${Object.keys(shipped).sort().join(', ')}`);
  if (Object.keys(setups).length) log(`their own jest setup: ${Object.keys(setups).sort().join(', ')}`);
  if (recorders.length) log(`analytics: recorded per SDK (${recorders.length} native modules)`);
  return [...installed, ...Object.keys(shipped), ...Object.keys(setups)];
};

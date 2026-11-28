import { AppState, LogBox, NativeModules, Platform } from 'react-native';

import type { Backend } from './backend';
import { fabricBackend } from './backends/fabric';
import { createHandlers, dispatch } from './handlers';
import type { NavigationAdapter } from './navigation';
import { hmacSha256Hex, sameHex } from './hmac';
import { installHostControls } from './hostControls';
import { AGENT_VERSION, type AgentEvent, type AuthEvent, type HelloEvent, PROTOCOL_VERSION, type Request, type Response, type VerifiedEvent } from './protocol';
import { addDefault, host } from './registry';
import { trackOpenedUrls } from './opened';
import { trackRequests } from './requests';
import { appId } from './native';
import { watchDevLoading } from './devLoading';
import { jsAge, watchFastRefresh } from './jsAge';
import { readLogs, tapLogs } from './logs';
import { readSdkCalls, tapSdks } from './sdks';
import { record as trace } from './trace';

export type ClientOptions = {
  navigation: NavigationAdapter;
  /** Where the driver listens. Default: localhost:8123 (10.0.2.2 on the Android emulator). */
  host?: string;
  port?: number;
  /** A per-machine secret both ends prove they hold (HMAC over fresh nonces); neither ever sends it. */
  token?: string;
  /** Intentionally serve any peer without a token. Unsafe outside an isolated test environment. */
  allowUnauthenticated?: boolean;
  /** Free-form description sent in `hello` (name, version, environment). */
  app?: Record<string, unknown>;
  /** The longest wait between dials. For 3 s after a link drops (or the app starts) it dials every 100 ms; then each wait doubles up to this. Default 1500. */
  reconnectMs?: number;
  /** Where the app runs; the device/Fabric backend by default. */
  backend?: Backend;
  /** How to open the socket; the global WebSocket by default. */
  createSocket?: (url: string) => Socket;
  /** Where failures inside the link go (hosts log them; the app stays quiet). */
  onError?: (error: unknown, context: string) => void;
};

// Typed locally so a Node `@types` in the workspace cannot shadow it.
export type Socket = {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((message: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
};

const OPEN = 1;
const EAGER_MS = 3000;
const REPLAY_WINDOW = 64;
// Reads would drown the timeline; only actions are worth a line.
const UNTRACED = new Set(['screen', 'find', 'trace', 'requests', 'ping', 'debug', 'idle', 'waitFor', 'busy']);

const NO_TOKEN =
  "lynkeus: the app passed a token and it is empty (or no token at all), so the agent stays off. React Native gives the app no environment: add 'lynkeus-agent/babel' to the plugins in babel.config.js and start Metro with LYNKEUS_TOKEN set (after a change, with --reset-cache). In Expo, name the variable EXPO_PUBLIC_LYNKEUS_TOKEN.";

const refusedBy = (url: string) =>
  `lynkeus: the driver at ${url} does not hold this app's token, so the link was dropped and nothing is served to it. Another project's Lynkeus is probably listening there (each project has its own .lynkeus/token; \`lynkeus status\` in this project names the process), or this bundle carries an older token (restart Metro with --reset-cache).`;

const openSocket = (url: string): Socket => new (globalThis as unknown as { WebSocket: new (url: string) => Socket }).WebSocket(url);

// Hermes has no WebCrypto everywhere; where it lacks getRandomValues, time and Math.random still make the nonce
// unique per connection, which is what the driver's proof needs (a fresh value it cannot have seen before).
const randomHex = (): string => {
  const bytes = new Uint8Array(16);
  const crypto = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (crypto?.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256) ^ ((Date.now() >>> ((i % 4) * 8)) & 0xff);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
};

/** The app end of the link: dials the driver, retries quietly while nobody listens, serves requests. Returns a stop function. */
// Hermes resolves Intl's default locale from the device's settings: what a case drafted from the screen reads in.
const deviceLocale = (): string | undefined => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || undefined;
  } catch {
    return undefined;
  }
};

/**
 * The token a Lynkeus FastSim host hands the agent, when it was started with one (LYNKEUS_TOKEN, as Lynkeus starts
 * it): a bundle made without the token in its environment then attaches all the same (trial run 11). Only a FastSim
 * host sets `__fastsimDevice`, before the app's code runs; a store build or a device never has it. The host is started
 * by whoever holds the token, so the app learns nothing its driver does not already prove, and the token still never
 * crosses the socket: both sides prove it, as with a token in the bundle.
 */
const hostToken = (): string | undefined => {
  const device = (globalThis as { __fastsimDevice?: { lynkeusToken?: unknown } }).__fastsimDevice;
  return typeof device?.lynkeusToken === 'string' && device.lynkeusToken.length > 0 ? device.lynkeusToken : undefined;
};

export const start = (given: ClientOptions): (() => void) => {
  const options = given.token ? given : { ...given, token: hostToken() };
  // A missing token must not turn into serving anyone who connects; opt out only for isolated tests.
  if (!options.token && options.allowUnauthenticated !== true) {
    console.warn(NO_TOKEN);
    return () => undefined;
  }
  trackRequests();
  trackOpenedUrls();
  watchFastRefresh();
  watchDevLoading();
  // Before `hello`, which lists the commands: the host's own (FastSim's screenshots and clock) are among them.
  installHostControls();
  // A host that stands in for the SDKs (fastsim, headless) answers `analytics` itself; elsewhere the agent does,
  // from the SDKs' own modules.
  if (tapSdks(NativeModules as Record<string, Record<string, unknown> | undefined>) > 0) addDefault('analytics', readSdkCalls);
  // A host that keeps the app's console itself (fastsim, headless) answers `logs` itself.
  if (tapLogs()) addDefault('logs', readLogs);
  const { navigation } = options;
  const backend = options.backend ?? fabricBackend();
  const handlers = createHandlers(navigation, backend);
  // The computer is 10.0.2.2 from the Android emulator, and localhost from a phone on USB once the CLI has run
  // `adb reverse`: with no host given, an Android app tries one, then the other, until one answers.
  const hosts = options.host ? [options.host] : Platform.OS === 'android' ? ['10.0.2.2', 'localhost'] : ['localhost'];
  let at = 0;
  const maxDelay = options.reconnectMs ?? 1500;
  const eager = Math.min(100, maxDelay);
  let delay = eager;
  let eagerUntil = Date.now() + EAGER_MS;
  let socket: Socket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  // Said once until a driver proves the token again: the agent redials every 1.5 s, and a line per dial would bury the app's own logs.
  let warnedRefusal = false;
  const refused = (url: string) => {
    if (warnedRefusal) return;
    warnedRefusal = true;
    console.warn(refusedBy(url));
  };

  const send = (message: Response | AgentEvent) => {
    if (socket?.readyState === OPEN) socket.send(JSON.stringify(message));
  };

  const hello = (proof: { nonce: string; proof: string } | null): HelloEvent => ({
    event: 'hello',
    protocolVersion: PROTOCOL_VERSION,
    agentVersion: AGENT_VERSION,
    platform: Platform.OS,
    native: backend.native,
    commands: host.commands(),
    route: navigation.currentRoute()?.name,
    app: options.app,
    ...(appId() ? { appId: appId() as string } : {}),
    ...(typeof AppState.currentState === 'string' ? { appState: AppState.currentState } : {}),
    locale: deviceLocale(),
    js: jsAge(),
    ...proof,
  });

  // The driver resends in-flight requests verbatim after a reconnect. One the
  // app already ran (only the reply was lost) answers from the recorded reply:
  // a press is not idempotent. Keyed by driver session and by the request whole:
  // drivers sharing a port share its session, and one older than 0.7.7 numbers
  // its requests from 1, so an id alone may name another request already
  // answered, whose reply would pass a step it never ran.
  const replies = new Map<string, Response>();
  const running = new Map<string, Promise<void>>();
  let session = '';

  const serve = async (request: Request) => {
    // Parsed from JSON, so it serializes back.
    const key = `${session}:${request.id}:${request.method}:${JSON.stringify(request.params)}`;
    const seen = replies.get(key);
    if (seen) {
      send(seen);
      return;
    }
    const active = running.get(key);
    if (active) {
      await active;
      return;
    }
    const run = (async () => {
      const started = Date.now();
      let reply: Response;
      try {
        const result = await dispatch(handlers, request.method, request.params, navigation);
        if (!UNTRACED.has(request.method)) trace({ kind: 'command', method: request.method, ms: Date.now() - started });
        reply = { id: request.id, method: request.method, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        trace({ kind: 'command', method: request.method, ms: Date.now() - started, error: message });
        options.onError?.(error, request.method);
        reply = { id: request.id, method: request.method, error: { message } };
      }
      replies.set(key, reply);
      if (replies.size > REPLAY_WINDOW) replies.delete(replies.keys().next().value as string);
      send(reply);
    })();
    running.set(key, run);
    try {
      await run;
    } finally {
      running.delete(key);
    }
  };

  const connect = () => {
    if (stopped) return;
    const url = `ws://${hosts[at]}:${options.port ?? 8123}`;
    const ws = (options.createSocket ?? openSocket)(url);
    socket = ws;
    let opened = false;
    let authenticated = options.token === undefined && options.allowUnauthenticated === true;
    let driverNonce = '';
    let appNonce = '';
    // hello goes out on the driver's auth event, which always arrives first.
    ws.onopen = () => {
      opened = true;
      delay = eager;
      eagerUntil = Number.POSITIVE_INFINITY;
      try {
        // An automation session must not fight the LogBox pill for the screen.
        LogBox.ignoreAllLogs?.(true);
      } catch (error) {
        options.onError?.(error, 'hello');
      }
    };
    ws.onmessage = (message) => {
      let parsed: Request | AuthEvent | VerifiedEvent;
      try {
        parsed = JSON.parse(String(message.data));
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== 'object') return;
      if ('event' in parsed) {
        if (parsed.event === 'auth') {
          if (typeof parsed.session !== 'string' || !parsed.session) return;
          if (parsed.session !== session) {
            replies.clear();
            session = parsed.session;
          }
          if (!options.token) {
            send(hello(null));
            return;
          }
          // A driver that sends no nonce speaks the old handshake, which handed the token to whoever listened.
          if (typeof parsed.nonce !== 'string' || !/^[0-9a-f]{32,128}$/.test(parsed.nonce)) return;
          authenticated = false;
          driverNonce = parsed.nonce;
          appNonce = randomHex();
          send(hello({ nonce: appNonce, proof: hmacSha256Hex(options.token, `lynkeus/app/${session}/${driverNonce}/${appNonce}`) }));
          return;
        }
        if (parsed.event === 'verified' && options.token && appNonce) {
          // Whatever listens on the port gets nothing but our proof unless it proves the token too.
          if (sameHex(parsed.proof, hmacSha256Hex(options.token, `lynkeus/driver/${session}/${driverNonce}/${appNonce}`))) {
            authenticated = true;
            warnedRefusal = false;
          } else {
            refused(url);
            ws.close();
          }
        }
        return;
      }
      if (!authenticated) {
        send({ id: parsed.id, method: parsed.method, error: { message: 'Not authenticated', code: 'unauthenticated' } });
        return;
      }
      void serve(parsed);
    };
    ws.onclose = () => {
      // A socket already replaced must not redial: it would orphan the current one, whose own close redials again,
      // and the two would take turns replacing each other.
      if (socket !== ws) return;
      socket = null;
      // A driver that closes after our proof and before its own refused the proof: its token is another one.
      if (appNonce && !authenticated && !stopped) refused(url);
      if (stopped) return;
      if (!opened) at = (at + 1) % hosts.length;
      if (eagerUntil === Number.POSITIVE_INFINITY) eagerUntil = Date.now() + EAGER_MS;
      timer = setTimeout(connect, delay);
      if (Date.now() >= eagerUntil) delay = Math.min(delay * 2, maxDelay);
    };
    // Nobody listening is the normal case; stay quiet and retry.
    ws.onerror = () => {};
  };

  const unsubscribe = navigation.subscribe(() => {
    const route = navigation.currentRoute()?.name;
    trace({ kind: 'route', route, path: navigation.path() });
    send({ event: 'navigation', route });
  });
  // Said before the OS suspends the app: afterwards its socket stays open on a phone and answers nothing, and the
  // driver could only wait out each call.
  const appState = AppState.addEventListener?.('change', (state) => send({ event: 'appstate', state: String(state) }));
  connect();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    unsubscribe();
    appState?.remove();
    socket?.close();
  };
};

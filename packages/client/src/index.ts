/**
 * The driver end of the link. The app dials in and keeps redialing, so the
 * server is the stable side: start it once, and every app launch reattaches.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import { debuglog } from 'node:util';

import { WebSocket, WebSocketServer } from 'ws';

import type { AgentEvent, CoreMethods, HelloEvent, Response } from 'lynkeus-protocol';

export { RelayClient, relayBackend, relayService } from './relay.js';

export type { AgentEvent, CoreMethods, Element, HelloEvent, Screen, Target, RequestRecord } from 'lynkeus-protocol';

const proof = (token: string, role: 'app' | 'driver', session: string, driverNonce: string, appNonce: string) =>
  createHmac('sha256', token).update(`lynkeus/${role}/${session}/${driverNonce}/${appNonce}`).digest('hex');

const sameToken = (given: unknown, expected: string): boolean => {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

// What a proven app may tell the driver; anything else (an `error` event above all, which EventEmitter throws on
// when nobody listens) is not emitted.
const APP_EVENTS = new Set(['navigation', 'appstate']);
// Connections still proving the token: a few at once, each for a few seconds, so a local flood holds no memory.
const MAX_CANDIDATES = 8;
// What any local process may send before it has proved the token: a hello is well under a kilobyte. The proven app's
// frames (element trees, logs) stay under the server's own limit.
const CANDIDATE_MAX_FRAME = 64 * 1024;
const MAX_FRAME = 32 * 1024 * 1024;
const CANDIDATE_MS = 5000;
// How long a socket this side closes gets to answer the close frame before it is cut. ws alone waits 30 s, and an app
// whose WebSocket never answers (FastSim's Android host before it did) held every close, and each case, that long.
const CLOSE_ANSWER_MS = 250;
// How often a wait for an app asks `ended` whether it can still come.
const ENDED_POLL_MS = 100;

/** Closes a socket and cuts it if the peer has not answered the close frame within CLOSE_ANSWER_MS. */
const closeSocket = (socket: WebSocket, code?: number, reason?: string): void => {
  if (socket.readyState === WebSocket.CLOSED) return;
  socket.close(code, reason);
  const cut = setTimeout(() => socket.terminate(), CLOSE_ANSWER_MS);
  cut.unref();
  socket.once('close', () => clearTimeout(cut));
};
const BACKGROUND = 'the app went to the background (another app is in front)';

export type AgentServerOptions = {
  port?: number;
  host?: string;
  /** Must match the app's `token`. Each end proves it holds it over fresh nonces; neither sends it. */
  token?: string;
  /** How long in-flight calls wait for the app to reconnect before failing (default 2500 ms). */
  reconnectGraceMs?: number;
  /**
   * How long calls wait for an app that was attached and disconnected to dial back in, counted from when it left,
   * before they fail as gone (default 10000 ms). A reload redials within moments; a crashed app never does.
   */
  goneMs?: number;
  /**
   * Asked once `goneMs` has passed with the app gone: whether its process still runs. One that does is loading or
   * reloading its JavaScript (a Fast Refresh, a dev client fetching a bundle), not crashed: calls then wait up to
   * `reloadMs` from when it left.
   */
  stillRunning?: () => Promise<boolean>;
  /** How long calls wait for an app whose process still runs to dial back in, counted from when it left (default 60000 ms). */
  reloadMs?: number;
  /**
   * Which apps this server drives, by what they say in hello (`platform: 'android'`, say). Servers in one process may
   * share a port when each says which apps it takes: an app goes to the one that accepts it, else to the one that takes
   * any. Every server on a port proves the same token.
   */
  accepts?: (hello: HelloEvent) => boolean;
  /**
   * Why the app can no longer dial in (the host a run started for it exited), or undefined while it still may. Waits for
   * an app that is not attached then fail at once with it, instead of running out their whole time.
   */
  ended?: () => string | undefined;
};

/** An app that proved the token on a port: when it last said hello, and whether it was turned away then. */
type Seen = { hello: HelloEvent; at: number; turnedAway: boolean };
/** Every server of this process listening on one host and port, the socket server they share, and the apps seen there. */
type Hub = { key: string; http: Server; wss: WebSocketServer; servers: AgentServer[]; token?: string; seen: Map<string, Seen> };

/** Which app a hello is, across its relaunches: a Simulator's and an emulator's, or a FastSim host's, are different apps. */
const identity = (hello: HelloEvent): string =>
  [hello.platform, hello.native ? 'native' : 'headless', hello.commands?.includes('clock') ? 'host' : '', hello.appId ?? String(hello.app?.name ?? '')].join(
    '|',
  );

const ORDER = { this: 0, other: 1, none: 2 } as const;

/** An app on a driver's port, as `apps()` lists it. */
export type PortApp = {
  hello: HelloEvent;
  /** When it last proved the token (ms since the epoch). */
  at: number;
  /** `this`: the server asked drives it; `other`: another server of the process on the port does; `none`: it was turned away. */
  driven: 'this' | 'other' | 'none';
};
const hubs = new Map<string, Hub>();

const portTaken = (port: number) =>
  new AgentError(
    `Port ${port} is already taken: another Lynkeus run is probably still driving the app there. Stop it, or use another port (LYNKEUS_PORT, --ports).`,
    'port-in-use',
  );

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
  request: string;
};

// NODE_DEBUG=lynkeus shows the replies a driver drops.
const debug = debuglog('lynkeus');

// One count for every server of the process: an app keeps its link while the drivers sharing a port take turns (the
// MCP server's own connection, then one per run on a platform), and its agent replays the reply it recorded for a
// request id it sees again. Ids each server counted from 1 handed a run the replies of the run before it. Kept on the
// global, so two copies of this module in one process (a bundle beside a dependency) still count together.
const REQUEST_IDS = Symbol.for('lynkeus.client.requestIds');
const nextRequestId = (): number => {
  const holder = globalThis as { [REQUEST_IDS]?: number };
  const id = (holder[REQUEST_IDS] ?? 0) + 1;
  holder[REQUEST_IDS] = id;
  return id;
};

export class AgentError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

export class AgentServer extends EventEmitter {
  readonly port: number;
  readonly host: string;

  #token?: string;
  /** An app connected and stayed silent after the auth: the sign of a token that does not match. */
  #unanswered = false;
  /** An app proved a token and it was not this one: another project's app, or a bundle with an older token. */
  #refused = 0;
  #session = Math.random().toString(36).slice(2) + Date.now().toString(36);
  #hub: Hub | null = null;
  #accepts?: (hello: HelloEvent) => boolean;
  #ended?: () => string | undefined;
  #socket: WebSocket | null = null;
  #pending = new Map<number, Pending>();
  #hello: HelloEvent | null = null;
  #graceTimer: ReturnType<typeof setTimeout> | null = null;
  #reconnectGraceMs: number;
  #goneMs: number;
  #reloadMs: number;
  #stillRunning: (() => Promise<boolean>) | undefined;
  /** Until when calls wait for an app started again on purpose (expectBack), whatever goneMs says. */
  #backBy: number | null = null;
  #candidates = 0;
  /** When the attached app disconnected; null while one is attached, or before any was. */
  #goneSince: number | null = null;
  #appState: string | undefined;
  /** Frames heard from the attached app, counted: a call that heard none while it waited heard nothing at all. */
  #heard = 0;

  constructor(options: AgentServerOptions = {}) {
    super();
    this.port = options.port ?? 8123;
    this.host = options.host ?? '127.0.0.1';
    this.#token = options.token;
    this.#reconnectGraceMs = options.reconnectGraceMs ?? 2500;
    this.#goneMs = options.goneMs ?? 10_000;
    this.#reloadMs = options.reloadMs ?? 60_000;
    this.#stillRunning = options.stillRunning;
    this.#accepts = options.accepts;
    this.#ended = options.ended;
  }

  get connected(): boolean {
    return this.#socket?.readyState === WebSocket.OPEN && this.#hello !== null;
  }

  /** What the app said about itself when it attached. */
  get hello(): HelloEvent | null {
    return this.#hello;
  }

  /**
   * Every app that proved the token on this port in the last `withinMs` (default 10 s), or is attached to a server of
   * it now: the one this server drives, those other servers of the process drive, those turned away, newest first.
   */
  apps(withinMs = 10_000): PortApp[] {
    const hub = this.#hub;
    if (!hub) return this.#hello ? [{ hello: this.#hello, at: Date.now(), driven: 'this' }] : [];
    const now = Date.now();
    const holder = (key: string) => hub.servers.find((s) => s.connected && identity(s.#hello!) === key);
    return [...hub.seen.entries()]
      .filter(([key, seen]) => holder(key) || now - seen.at <= withinMs)
      .map(([key, seen]): PortApp => {
        const by = holder(key);
        return { hello: (by ? by.#hello : null) ?? seen.hello, at: seen.at, driven: by === this ? 'this' : by ? 'other' : 'none' };
      })
      .sort((a, b) => ORDER[a.driven] - ORDER[b.driven] || b.at - a.at);
  }

  /** An app was attached and has disconnected without dialing back in: it crashed, was closed, or is reloading. */
  get gone(): boolean {
    return this.#goneSince !== null && !this.connected;
  }

  /**
   * The app was started again on purpose (a relaunch, a reload asked for): calls wait up to `ms` from now for its
   * hello, instead of failing as gone once `goneMs` has passed since the old process left.
   */
  expectBack(ms: number): void {
    this.#backBy = Date.now() + ms;
  }

  /** The app's AppState as it last said (`active`, `background`…); undefined from an agent that does not say. */
  get appState(): string | undefined {
    return this.#appState;
  }

  async listen(): Promise<void> {
    if (this.#hub) return;
    const key = `${this.host}:${this.port}`;
    const shared = hubs.get(key);
    if (shared) {
      // Two servers that each take any app would hand it to whichever it dials next: two runs' steps mixed.
      const unclaimed = !this.#accepts && shared.servers.some((s) => !s.#accepts);
      if (unclaimed || shared.token !== this.#token) throw portTaken(this.port);
      shared.servers.push(this);
      this.#hub = shared;
      // An app the server taking any holds and this one wants dials again, and comes here.
      if (this.#accepts)
        for (const other of shared.servers)
          if (!other.#accepts && other.#hello && this.#accepts(other.#hello) && other.#socket)
            closeSocket(other.#socket, 1012, 'another driver on this port takes this app');
      return;
    }
    // The HTTP server is this side's own, so a close can cut connections that never became WebSockets as well.
    const http = createServer((_request, response) => {
      response.writeHead(426, { 'Content-Type': 'text/plain' });
      response.end('Upgrade Required');
    });
    const wss = new WebSocketServer({ server: http, maxPayload: MAX_FRAME });
    const hub: Hub = { key, http, wss, servers: [this], token: this.#token, seen: new Map() };
    hubs.set(key, hub);
    this.#hub = hub;
    wss.on('connection', (socket) => {
      const first = hub.servers[0];
      if (first) first.#attach(socket);
      else socket.terminate();
    });
    await new Promise<void>((resolve, reject) => {
      http.once('listening', () => resolve());
      http.once('error', (error: NodeJS.ErrnoException) => {
        if (hubs.get(key) === hub) hubs.delete(key);
        for (const s of hub.servers) s.#hub = null;
        hub.servers = [];
        reject(error.code === 'EADDRINUSE' ? portTaken(this.port) : error);
      });
      http.listen(this.port, this.host);
    });
  }

  /** Who drives an app that said `hello`: the server that accepts it, else the one that takes any app. */
  #ownerOf(hello: HelloEvent): AgentServer | undefined {
    const servers = this.#hub?.servers ?? [];
    return servers.find((s) => s.#accepts?.(hello)) ?? servers.find((s) => !s.#accepts);
  }

  async close(): Promise<void> {
    this.#cancelGrace();
    this.#failPending(new AgentError('Agent server closed'));
    if (this.#socket) closeSocket(this.#socket);
    this.#socket = null;
    this.#hello = null;
    this.#goneSince = null;
    const hub = this.#hub;
    this.#hub = null;
    if (!hub) return;
    hub.servers = hub.servers.filter((s) => s !== this);
    if (hub.servers.length > 0) return;
    if (hubs.get(hub.key) === hub) hubs.delete(hub.key);
    // The socket server is closed once every connection has ended: candidates and links nobody holds any more included.
    for (const client of hub.wss.clients) closeSocket(client, 1001);
    hub.wss.close();
    const cut = setTimeout(() => hub.http.closeAllConnections(), CLOSE_ANSWER_MS);
    cut.unref();
    await new Promise<void>((resolve) => hub.http.close(() => resolve()));
    clearTimeout(cut);
  }

  async waitForApp(timeoutMs = 15_000): Promise<HelloEvent> {
    if (this.connected && this.#hello) return this.#hello;
    const over = this.#ended?.();
    if (over) throw new AgentError(over, 'gone');
    return new Promise<HelloEvent>((resolve, reject) => {
      const ended = this.#ended;
      const watch = ended
        ? setInterval(() => {
            const why = ended();
            if (!why) return;
            clearTimeout(timer);
            clearInterval(watch);
            this.off('hello', onHello);
            reject(new AgentError(why, 'gone'));
          }, ENDED_POLL_MS)
        : undefined;
      watch?.unref();
      const timer = setTimeout(() => {
        clearInterval(watch);
        this.off('hello', onHello);
        // An app that dials in and never says hello is one whose token is not ours: the agent stays silent then.
        const why = this.#refused
          ? ` An app dialed in ${this.#refused === 1 ? 'once' : `${this.#refused} times`} with another token and was refused: it is another project's app (each project has its own .lynkeus/token), or its bundle carries an older token. Open this project's development build, or restart Metro with --reset-cache.`
          : this.#unanswered
            ? ' An app connected but did not answer: its token is not this one. Start Metro with the LYNKEUS_TOKEN this driver has (.lynkeus/token or the environment), with --reset-cache.'
            : ' Is a dev build running with <Lynkeus>?';
        reject(
          new AgentError(
            `No app attached on ${this.host}:${this.port} within ${timeoutMs}ms.${why}`,
            this.#refused || this.#unanswered ? 'wrong-token' : undefined,
          ),
        );
      }, timeoutMs);
      const onHello = (hello: HelloEvent) => {
        clearTimeout(timer);
        clearInterval(watch);
        resolve(hello);
      };
      this.once('hello', onHello);
    });
  }

  /** A core method, typed. */
  async call<M extends keyof CoreMethods>(method: M, params?: CoreMethods[M]['params'], timeoutMs?: number): Promise<CoreMethods[M]['result']>;
  /** An app command registered with `qa.register`. */
  async call<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  // The deadline keeps running across a reconnect: a resent request gets only the time that is left.
  async call(method: string, params?: unknown, timeoutMs = 20_000): Promise<unknown> {
    const deadline = Date.now() + timeoutMs;
    let socket = this.#socket;
    if (!this.connected || !socket || socket.readyState !== WebSocket.OPEN) {
      const over = this.#ended?.();
      if (over) throw new AgentError(over, 'gone');
      // An app that left gets one window to come back, not every call's whole timeout: a crashed one would otherwise
      // cost each step of each case its full wait. What brings an app back on purpose (a relaunch, the OS putting it
      // in front again) waits for its hello itself.
      const goneSince = this.#goneSince;
      if (goneSince !== null) {
        let until = Math.max(goneSince + this.#goneMs, this.#backBy ?? 0);
        // Past the window, an app whose process still runs is loading its JavaScript: it gets longer, bounded.
        const loading =
          until <= Date.now() && goneSince + this.#reloadMs > Date.now() && this.#stillRunning !== undefined && (await this.#stillRunning().catch(() => false));
        if (loading) until = goneSince + this.#reloadMs;
        const wait = Math.min(deadline - Date.now(), until - Date.now());
        if (wait <= 0) throw this.#goneError(goneSince, loading);
        await this.waitForApp(wait).catch(() => {
          const over = this.#ended?.();
          throw over ? new AgentError(over, 'gone') : this.#goneError(goneSince, loading);
        });
      } else await this.waitForApp(timeoutMs);
      socket = this.#socket;
      if (!this.connected || !socket || socket.readyState !== WebSocket.OPEN) throw new AgentError('No app attached');
    }
    const id = nextRequestId();
    const request = JSON.stringify({ id, method, params });
    const result = new Promise<unknown>((resolve, reject) => {
      const heardBefore = this.#heard;
      const timer = setTimeout(
        () => {
          this.#pending.delete(id);
          reject(new AgentError(`${method} timed out after ${timeoutMs}ms${this.#silenceNote(heardBefore)}`, 'timeout'));
        },
        Math.max(1, deadline - Date.now()),
      );
      this.#pending.set(id, { resolve, reject, timer, method, request });
    });
    socket.send(request);
    return result;
  }

  #goneError(since: number, running = false): AgentError {
    const left = `it disconnected ${((Date.now() - since) / 1000).toFixed(1)} s ago and has not dialed back in`;
    if (this.#appState === 'background') return new AgentError(`${BACKGROUND} and let go of the driver: ${left}`, 'background');
    if (running)
      return new AgentError(
        `the app is still running but its JavaScript has not attached again: ${left} (Metro still bundling, a red screen, or a reload that left the agent out)`,
        'loading',
      );
    return new AgentError(`the app is gone (crashed or closed): ${left}`, 'gone');
  }

  // Why a call got no answer, when the app says or its silence does.
  #silenceNote(heardBefore: number): string {
    if (this.#appState === 'background') return `: ${BACKGROUND}`;
    if (this.#heard === heardBefore) return ': nothing at all came from the app meanwhile (another app in front, or its JS thread stuck)';
    return '';
  }

  #cancelGrace(): void {
    if (this.#graceTimer) clearTimeout(this.#graceTimer);
    this.#graceTimer = null;
  }

  #failPending(error: AgentError): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #peers(): AgentServer[] {
    return this.#hub?.servers.length ? this.#hub.servers : [this];
  }

  #attach(socket: WebSocket): void {
    // A new connection is only a candidate: the app it replaces keeps the link until this one proves the token, so a
    // local process that connects in a loop cannot knock the real app off.
    // A refused socket is let go at once: a peer that ignores the close handshake would otherwise hold its slot for ws's
    // whole close timeout, and one reconnecting in a loop could keep the real app from ever attaching.
    const drop = (code: number, reason: string) => {
      socket.close(code, reason);
      setTimeout(() => socket.terminate(), 500).unref();
    };
    if (this.#candidates >= MAX_CANDIDATES) {
      drop(1013, 'too many connections proving the token');
      return;
    }
    this.#candidates++;
    const driverNonce = randomBytes(16).toString('hex');
    socket.send(JSON.stringify({ event: 'auth', session: this.#session, nonce: driverNonce }));
    let candidate = true;
    // The handshake is this server's; the app it proves goes to whichever server on the port takes it.
    let owner: AgentServer = this;
    const settle = () => {
      if (!candidate) return;
      candidate = false;
      this.#candidates--;
    };
    const silence = setTimeout(() => {
      if (candidate && socket.readyState === WebSocket.OPEN) for (const s of this.#peers()) s.#unanswered = true;
    }, 2000);
    const expire = setTimeout(() => {
      if (!candidate) return;
      settle();
      drop(1008, 'no proof in time');
    }, CANDIDATE_MS);
    socket.once('close', () => {
      clearTimeout(silence);
      clearTimeout(expire);
      settle();
    });

    socket.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      const size = Array.isArray(data) ? data.reduce((n, part) => n + part.length, 0) : data instanceof ArrayBuffer ? data.byteLength : data.length;
      if (candidate && size > CANDIDATE_MAX_FRAME) {
        settle();
        socket.terminate();
        return;
      }
      let message: Response | AgentEvent;
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      // Anything can connect to the port: a frame that is not an object is noise, not a reason to throw.
      if (!message || typeof message !== 'object') return;
      if ('event' in message) {
        if (message.event === 'hello' && candidate) {
          const { nonce, proof: given, ...safe } = message;
          if (
            this.#token !== undefined &&
            (typeof nonce !== 'string' || !/^[0-9a-f]{32,128}$/.test(nonce) || !sameToken(given, proof(this.#token, 'app', this.#session, driverNonce, nonce)))
          ) {
            for (const s of this.#peers()) {
              s.#unanswered = true;
              if (typeof given === 'string') s.#refused++;
            }
            settle();
            drop(1008, 'invalid token');
            return;
          }
          settle();
          clearTimeout(silence);
          clearTimeout(expire);
          const found = this.#ownerOf(safe as HelloEvent);
          if (!found) {
            drop(1013, 'no driver on this port takes this app');
            return;
          }
          // Another app of a server that takes any (a second device's on the session's port) does not knock off the
          // one attached: they would take turns, each redialing, and the commands would drive both by turns. It is told
          // why after the token is proven both ways, so it redials quietly instead of reporting a refused token.
          const hello = safe as HelloEvent;
          const turnedAway =
            !found.#accepts && found.connected && found.#socket !== socket && found.#appState !== 'background' && identity(found.#hello!) !== identity(hello);
          this.#hub?.seen.set(identity(hello), { hello, at: Date.now(), turnedAway });
          if (turnedAway) {
            if (this.#token !== undefined && typeof nonce === 'string')
              socket.send(JSON.stringify({ event: 'verified', proof: proof(this.#token, 'driver', this.#session, driverNonce, nonce) }));
            drop(1013, 'another app is attached on this port');
            return;
          }
          owner = found;
          // A relaunch reconnects before the old socket notices; the newest proven one wins.
          const previous = owner.#socket;
          owner.#socket = socket;
          if (previous && previous !== socket) closeSocket(previous);
          owner.#cancelGrace();
          owner.#hello = safe as HelloEvent;
          owner.#unanswered = false;
          owner.#refused = 0;
          owner.#goneSince = null;
          owner.#backBy = null;
          owner.#appState = typeof owner.#hello.appState === 'string' ? owner.#hello.appState : undefined;
          owner.#heard++;
          socket.send(
            JSON.stringify(
              this.#token !== undefined && typeof nonce === 'string'
                ? { event: 'verified', proof: proof(this.#token, 'driver', this.#session, driverNonce, nonce) }
                : { event: 'verified' },
            ),
          );
          // Resend what the previous socket may have dropped, now that this one has proved the project token.
          for (const pending of owner.#pending.values()) socket.send(pending.request);
          owner.emit('hello', owner.#hello);
          return;
        }
        if (owner.#socket === socket && owner.#hello && APP_EVENTS.has(message.event)) {
          owner.#heard++;
          if (message.event === 'appstate') owner.#appState = message.state;
          owner.emit(message.event, message);
        }
        return;
      }
      if (owner.#socket !== socket || !owner.#hello) return;
      owner.#heard++;
      const pending = owner.#pending.get(message.id);
      if (!pending) {
        // The answer to a call that timed out or was failed: nobody waits for it, and no other call may take it.
        debug('dropped a reply to request %s%s: no call waits for it', message.id, message.method ? ` (${message.method})` : '');
        return;
      }
      owner.#pending.delete(message.id);
      clearTimeout(pending.timer);
      // An agent says which method it answers (agents before it do not): a reply to another one must fail the call,
      // never pass it with what another command returned.
      if (message.method !== undefined && message.method !== pending.method) {
        debug('reply to request %s answers %s, not %s', message.id, message.method, pending.method);
        pending.reject(
          new AgentError(`${pending.method} got the reply to ${message.method}: the app answered another request. Relaunch the app if it repeats.`, 'mismatch'),
        );
        return;
      }
      if ('error' in message) pending.reject(new AgentError(message.error.message, message.error.code));
      else pending.resolve(message.result);
    });

    socket.on('close', () => {
      if (owner.#socket !== socket) return;
      owner.#socket = null;
      owner.#hello = null;
      const since = Date.now();
      owner.#goneSince = since;
      owner.emit('disconnected');
      // Dev builds redial within moments: hold in-flight calls for the next hello to resend.
      if (owner.#pending.size === 0) return;
      owner.#graceTimer = setTimeout(() => {
        owner.#graceTimer = null;
        const gone = owner.#goneError(since);
        owner.#failPending(new AgentError(`App disconnected mid-call: ${gone.message}`, 'disconnected'));
      }, owner.#reconnectGraceMs);
    });
  }
}

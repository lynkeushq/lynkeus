/**
 * The driver end of the link. The app dials in and keeps redialing, so the
 * server is the stable side: start it once, and every app launch reattaches.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';

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
const APP_EVENTS = new Set(['navigation']);
// Connections still proving the token: a few at once, each for a few seconds, so a local flood holds no memory.
const MAX_CANDIDATES = 8;
// What any local process may send before it has proved the token: a hello is well under a kilobyte. The proven app's
// frames (element trees, logs) stay under the server's own limit.
const CANDIDATE_MAX_FRAME = 64 * 1024;
const MAX_FRAME = 32 * 1024 * 1024;
const CANDIDATE_MS = 5000;

export type AgentServerOptions = {
  port?: number;
  host?: string;
  /** Must match the app's `token`. Each end proves it holds it over fresh nonces; neither sends it. */
  token?: string;
  /** How long in-flight calls wait for the app to reconnect before failing (default 2500 ms). */
  reconnectGraceMs?: number;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  request: string;
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
  #session = Math.random().toString(36).slice(2) + Date.now().toString(36);
  #server: WebSocketServer | null = null;
  #socket: WebSocket | null = null;
  #pending = new Map<number, Pending>();
  #nextId = 1;
  #hello: HelloEvent | null = null;
  #graceTimer: ReturnType<typeof setTimeout> | null = null;
  #reconnectGraceMs: number;
  #candidates = 0;

  constructor(options: AgentServerOptions = {}) {
    super();
    this.port = options.port ?? 8123;
    this.host = options.host ?? '127.0.0.1';
    this.#token = options.token;
    this.#reconnectGraceMs = options.reconnectGraceMs ?? 2500;
  }

  get connected(): boolean {
    return this.#socket?.readyState === WebSocket.OPEN && this.#hello !== null;
  }

  /** What the app said about itself when it attached. */
  get hello(): HelloEvent | null {
    return this.#hello;
  }

  async listen(): Promise<void> {
    if (this.#server) return;
    const server = new WebSocketServer({ port: this.port, host: this.host, maxPayload: MAX_FRAME });
    this.#server = server;
    server.on('connection', (socket) => this.#attach(socket));
    await new Promise<void>((resolve, reject) => {
      server.once('listening', () => resolve());
      server.once('error', (error: NodeJS.ErrnoException) => {
        this.#server = null;
        if (error.code !== 'EADDRINUSE') return reject(error);
        // Sharing the port would hand the app to whichever driver it dials next: two runs' steps mixed.
        reject(
          new AgentError(
            `Port ${this.port} is already taken: another lynkeus run is probably still driving the app there. Stop it, or use another port (LYNKEUS_PORT, --ports).`,
            'port-in-use',
          ),
        );
      });
    });
  }

  async close(): Promise<void> {
    this.#cancelGrace();
    this.#failPending(new AgentError('Agent server closed'));
    this.#socket?.close();
    this.#socket = null;
    this.#hello = null;
    await new Promise<void>((resolve) => (this.#server ? this.#server.close(() => resolve()) : resolve()));
    this.#server = null;
  }

  async waitForApp(timeoutMs = 15_000): Promise<HelloEvent> {
    if (this.connected && this.#hello) return this.#hello;
    return new Promise<HelloEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('hello', onHello);
        // An app that dials in and never says hello is one whose token is not ours: the agent stays silent then.
        const why = this.#unanswered
          ? ' An app connected but did not answer: its token is not this one. Start Metro with the LYNKEUS_TOKEN this driver has (.lynkeus/token or the environment), with --reset-cache.'
          : ' Is a dev build running with <Lynkeus>?';
        reject(new AgentError(`No app attached on ${this.host}:${this.port} within ${timeoutMs}ms.${why}`));
      }, timeoutMs);
      const onHello = (hello: HelloEvent) => {
        clearTimeout(timer);
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
      await this.waitForApp(timeoutMs);
      socket = this.#socket;
      if (!this.connected || !socket || socket.readyState !== WebSocket.OPEN) throw new AgentError('No app attached');
    }
    const id = this.#nextId++;
    const request = JSON.stringify({ id, method, params });
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.#pending.delete(id);
          reject(new AgentError(`${method} timed out after ${timeoutMs}ms`, 'timeout'));
        },
        Math.max(1, deadline - Date.now()),
      );
      this.#pending.set(id, { resolve, reject, timer, request });
    });
    socket.send(request);
    return result;
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
    const settle = () => {
      if (!candidate) return;
      candidate = false;
      this.#candidates--;
    };
    const silence = setTimeout(() => {
      if (candidate && socket.readyState === WebSocket.OPEN) this.#unanswered = true;
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
            this.#unanswered = true;
            settle();
            drop(1008, 'invalid token');
            return;
          }
          settle();
          clearTimeout(silence);
          clearTimeout(expire);
          // A relaunch reconnects before the old socket notices; the newest proven one wins.
          const previous = this.#socket;
          this.#socket = socket;
          if (previous && previous !== socket) previous.close();
          this.#cancelGrace();
          this.#hello = safe as HelloEvent;
          this.#unanswered = false;
          socket.send(
            JSON.stringify(
              this.#token !== undefined && typeof nonce === 'string'
                ? { event: 'verified', proof: proof(this.#token, 'driver', this.#session, driverNonce, nonce) }
                : { event: 'verified' },
            ),
          );
          // Resend what the previous socket may have dropped, now that this one has proved the project token.
          for (const pending of this.#pending.values()) socket.send(pending.request);
          this.emit('hello', this.#hello);
          return;
        }
        if (this.#socket === socket && this.#hello && APP_EVENTS.has(message.event)) this.emit(message.event, message);
        return;
      }
      if (this.#socket !== socket || !this.#hello) return;
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if ('error' in message) pending.reject(new AgentError(message.error.message, message.error.code));
      else pending.resolve(message.result);
    });

    socket.on('close', () => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      this.#hello = null;
      this.emit('disconnected');
      // Dev builds redial within moments: hold in-flight calls for the next hello to resend.
      if (this.#pending.size === 0) return;
      this.#graceTimer = setTimeout(() => {
        this.#graceTimer = null;
        this.#failPending(new AgentError('App disconnected mid-call', 'disconnected'));
      }, this.#reconnectGraceMs);
    });
  }
}

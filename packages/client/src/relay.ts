import { WebSocket } from 'ws';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '10.0.2.2']);
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);
const REQUEST_MAX = 1024 * 1024;
const RESPONSE_MAX = 8 * 1024 * 1024;
const AT_ONCE = 8;
const TIMEOUT_MS = 30_000;

export type RelayOptions = {
  cloud: string;
  token: string;
  backend: string;
  prefix?: string;
  fetch?: typeof fetch;
  socketFactory?: (url: string, authorization: string) => WebSocket;
};

export const relayBackend = (value: string): URL => {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !LOCAL_HOSTS.has(url.hostname)) throw new Error('the relay backend must be an HTTP(S) loopback URL');
  if (url.username || url.password) throw new Error('the backend URL must not embed credentials');
  return url;
};

export const relayService = (value: string): URL => {
  const url = new URL(value);
  if (!['https:', 'http:', 'wss:', 'ws:'].includes(url.protocol)) throw new Error('the relay service must use HTTP(S) or WS(S)');
  if (url.username || url.password) throw new Error('the relay service URL must not embed credentials');
  const loopback = LOCAL_HOSTS.has(url.hostname);
  if (!loopback && !['https:', 'wss:'].includes(url.protocol)) throw new Error('the relay service must use TLS outside loopback');
  return url;
};

const relaySocketUrl = (cloud: string, token: string) => {
  const url = relayService(cloud);
  url.protocol = url.protocol === 'https:' ? 'wss:' : url.protocol === 'http:' ? 'ws:' : url.protocol;
  url.pathname = `/relay/${token}/ws`;
  url.search = '';
  url.hash = '';
  return url.toString();
};

const relayError = (id: string, status: number, message: string) => ({
  id,
  status,
  headers: { 'content-type': 'application/json' },
  body: Buffer.from(JSON.stringify({ error: message })).toString('base64'),
});

const bodyBytes = async (response: Response): Promise<Uint8Array> => {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > RESPONSE_MAX) {
      await reader.cancel();
      throw new Error('the backend response exceeds 8 MB');
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
};

export class RelayClient {
  readonly prefix: string;
  readonly backend: URL;
  readonly socketUrl: string;
  #socket?: WebSocket;
  #socketFactory: (url: string, authorization: string) => WebSocket;
  #fetch: typeof fetch;
  #token: string;
  #active = 0;
  #finished: Promise<void>;
  #finish?: () => void;

  constructor(options: RelayOptions) {
    if (!/^relay_[0-9a-f]{64}$/.test(options.token)) throw new Error('the relay token has an invalid shape');
    this.prefix = options.prefix ?? '/api/mobile/';
    if (!this.prefix.startsWith('/api/mobile/') || this.prefix.includes('..') || this.prefix.includes('\\') || this.prefix.includes('\0'))
      throw new Error('the relay prefix must stay under /api/mobile/');
    this.backend = relayBackend(options.backend);
    this.socketUrl = relaySocketUrl(options.cloud, options.token);
    this.#token = options.token;
    this.#socketFactory = options.socketFactory ?? ((url, authorization) => new WebSocket(url, { headers: { authorization } }));
    this.#fetch = options.fetch ?? fetch;
    this.#finished = new Promise<void>((resolve) => {
      this.#finish = resolve;
    });
  }

  get finished(): Promise<void> {
    return this.#finished;
  }

  async listen(): Promise<void> {
    if (this.#socket) return;
    const socket = this.#socketFactory(this.socketUrl, `Bearer ${this.#token}`);
    this.#socket = socket;
    socket.on('message', (data, isBinary) => {
      if (isBinary) return;
      const text = String(data);
      if (text.length > REQUEST_MAX + 64 * 1024) {
        try {
          const oversized = JSON.parse(text) as { id?: unknown };
          if (typeof oversized.id === 'string') this.#send(relayError(oversized.id, 413, 'the relay request exceeds 1 MB'));
        } catch {
          // A malformed oversized frame has no id to answer.
        }
        return;
      }
      let message: { id?: unknown; method?: unknown; path?: unknown; headers?: unknown; body?: unknown };
      try {
        message = JSON.parse(text);
      } catch {
        return;
      }
      void this.#answer(message);
    });
    socket.on('error', () => this.close());
    socket.on('close', () => this.close());
    await new Promise<void>((resolve, reject) => {
      const open = () => {
        cleanup();
        resolve();
      };
      const fail = () => {
        cleanup();
        reject(new Error('the relay could not connect'));
      };
      const cleanup = () => {
        socket.off('open', open);
        socket.off('error', fail);
      };
      socket.once('open', open);
      socket.once('error', fail);
    });
  }

  close(): void {
    this.#socket?.close();
    this.#finish?.();
  }

  #send(message: unknown): void {
    if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(message));
  }

  async #answer(message: { id?: unknown; method?: unknown; path?: unknown; headers?: unknown; body?: unknown }): Promise<void> {
    const id = typeof message.id === 'string' ? message.id : '';
    if (!id || typeof message.method !== 'string' || typeof message.path !== 'string') return;
    if (this.#active >= AT_ONCE) return this.#send(relayError(id, 429, 'too many relay requests at once'));
    if (!METHODS.has(message.method)) return this.#send(relayError(id, 405, 'method not allowed'));
    if (!message.path.startsWith(this.prefix) || message.path.includes('\\') || message.path.includes('\0'))
      return this.#send(relayError(id, 403, 'path is outside the relay allowlist'));
    const target = new URL(message.path, this.backend);
    if (target.origin !== this.backend.origin || !target.pathname.startsWith(this.prefix))
      return this.#send(relayError(id, 403, 'path is outside the relay allowlist'));
    const body = typeof message.body === 'string' ? Buffer.from(message.body, 'base64') : Buffer.alloc(0);
    if (body.byteLength > REQUEST_MAX) return this.#send(relayError(id, 413, 'the relay request exceeds 1 MB'));
    this.#active++;
    try {
      const headers = message.headers && typeof message.headers === 'object' ? (message.headers as Record<string, unknown>) : {};
      const forwarded = Object.fromEntries(
        Object.entries(headers)
          .filter(([name]) =>
            ['accept', 'content-type', 'x-api-key', 'x-version', 'x-bundleversion', 'user-agent', 'traceparent', 'tracestate', 'authorization'].includes(
              name.toLowerCase(),
            ),
          )
          .map(([name, value]) => [name, String(value)]),
      );
      const response = await this.#fetch(target, {
        method: message.method,
        headers: forwarded,
        body: ['GET', 'HEAD'].includes(message.method) || body.byteLength === 0 ? undefined : body,
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const bytes = await bodyBytes(response);
      const responseHeaders: Record<string, string> = {};
      for (const name of ['content-type', 'cache-control']) {
        const value = response.headers.get(name);
        if (value) responseHeaders[name] = value;
      }
      this.#send({ id, status: response.status, headers: responseHeaders, body: Buffer.from(bytes).toString('base64') });
    } catch (error) {
      const message = error instanceof Error && error.message.includes('8 MB') ? 'the backend response exceeds 8 MB' : 'the backend did not answer';
      this.#send(relayError(id, error instanceof Error && error.message.includes('8 MB') ? 413 : 504, message));
    } finally {
      this.#active--;
    }
  }
}

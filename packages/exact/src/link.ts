import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { PROTOCOL_VERSION, type Request, type Response } from 'lynkeus-protocol';
import WebSocket from 'ws';

import { type Adapter, MethodError } from './adapter.js';

export type LinkOptions = {
  port: number;
  host?: string;
  /** The project's token: both ends prove they hold it; it is never sent. */
  token: string;
  agentVersion?: string;
  /** Where failures go. */
  log?: (line: string) => void;
};

const REPLAY_WINDOW = 64;
const proof = (token: string, who: 'app' | 'driver', session: string, driverNonce: string, appNonce: string): string =>
  createHmac('sha256', token).update(`lynkeus/${who}/${session}/${driverNonce}/${appNonce}`).digest('hex');

const same = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * The app end of the Lynkeus link, for a host that is not a React Native app: dials the driver, proves the token, and
 * serves the requests from an adapter. Dials again every 100 ms while nobody listens, as the in-app agent does.
 */
export const startLink = (adapter: Adapter, options: LinkOptions): (() => void) => {
  const log = options.log ?? (() => undefined);
  let stopped = false;
  let socket: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const connect = () => {
    if (stopped) return;
    const ws = new WebSocket(`ws://${options.host ?? '127.0.0.1'}:${options.port}`);
    socket = ws;
    let session = '';
    let driverNonce = '';
    let appNonce = '';
    let verified = false;
    const replies = new Map<string, Response>();
    const send = (message: unknown) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    };
    const serve = async (request: Request) => {
      const key = `${session}/${request.id}`;
      const kept = replies.get(key);
      if (kept) return send(kept);
      let reply: Response;
      try {
        reply = { id: request.id, result: (await adapter.call(request.method, request.params)) ?? null };
      } catch (error) {
        const e = error instanceof MethodError ? error : undefined;
        reply = { id: request.id, error: { message: error instanceof Error ? error.message : String(error), ...(e?.code ? { code: e.code } : {}) } };
      }
      replies.set(key, reply);
      if (replies.size > REPLAY_WINDOW) replies.delete(replies.keys().next().value as string);
      send(reply);
    };
    ws.on('message', (data) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(String(data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (message.event === 'auth') {
        session = String(message.session);
        driverNonce = typeof message.nonce === 'string' ? message.nonce : '';
        appNonce = randomBytes(16).toString('hex');
        send({
          event: 'hello',
          protocolVersion: PROTOCOL_VERSION,
          agentVersion: options.agentVersion ?? '0.7.5',
          ...adapter.hello(),
          nonce: appNonce,
          proof: proof(options.token, 'app', session, driverNonce, appNonce),
        });
        return;
      }
      if (message.event === 'verified') {
        if (typeof message.proof !== 'string' || !same(message.proof, proof(options.token, 'driver', session, driverNonce, appNonce))) {
          log('the driver did not prove it holds the token; closing');
          ws.close(1008);
          return;
        }
        verified = true;
        return;
      }
      if (typeof message.id === 'number' && typeof message.method === 'string') {
        if (!verified) return send({ id: message.id, error: { message: 'unauthenticated', code: 'unauthenticated' } });
        void serve(message as unknown as Request);
      }
    });
    const again = () => {
      if (socket === ws) socket = null;
      if (!stopped) timer = setTimeout(connect, 100);
    };
    ws.on('close', again);
    ws.on('error', (error) => {
      if (!/ECONNREFUSED/.test(String(error))) log(`socket error: ${String(error)}`);
    });
  };
  connect();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    socket?.close();
  };
};

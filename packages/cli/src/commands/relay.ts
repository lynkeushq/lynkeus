import { RelayClient, relayService } from 'lynkeus-client';

import { define } from '../registry.js';

const apiUrl = (cloud: string, token: string, prefix: string) => {
  const url = new URL(cloud);
  url.protocol = url.protocol === 'wss:' ? 'https:' : url.protocol === 'ws:' ? 'http:' : url.protocol;
  url.pathname = `/relay/${token}${prefix}`;
  url.search = '';
  url.hash = '';
  return url.toString();
};

export const createRelaySession = async (
  cloud: string,
  key: string,
  ttlSeconds: number,
  prefix: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> => {
  relayService(cloud);
  return fetchImpl(`${cloud.replace(/\/$/, '')}/v1/relay`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ttlSeconds, prefix }),
    redirect: 'manual',
  });
};

export const relayCommands = [
  define({
    name: 'relay',
    group: 'runs',
    summary: 'Expose a loopback backend to one app session through a short-lived outbound WSS relay',
    details:
      'Creates a per-run token with LYNKEUS_REPORTS_KEY (or LYNKEUS_CLOUD_KEY), connects outbound to the reports service and forwards only /api/mobile/ requests to the loopback backend. Prints the API_URL to give that app session. No project token or listener is exposed to the internet.',
    flags: {
      cloud: { type: 'string', help: 'relay service URL (default LYNKEUS_REPORTS_URL or https://lynkeus.io)', value: 'url' },
      backend: { type: 'string', help: 'loopback backend URL', default: 'http://127.0.0.1:3000', value: 'url' },
      prefix: { type: 'string', help: 'allowed backend path prefix', default: '/api/mobile/', value: 'path' },
      ttl: { type: 'number', help: 'session lifetime in seconds (max 3600)', default: 900, value: 'seconds' },
    },
    needs: 'nothing',
    session: false,
    mcp: false,
    run: async (ctx) => {
      const key = process.env.LYNKEUS_REPORTS_KEY ?? process.env.LYNKEUS_CLOUD_KEY;
      if (!key) return { text: 'set LYNKEUS_REPORTS_KEY (or LYNKEUS_CLOUD_KEY) in mise.local.toml to create a relay session', code: 2 };
      const cloud = typeof ctx.flags.cloud === 'string' ? ctx.flags.cloud : (process.env.LYNKEUS_REPORTS_URL ?? 'https://lynkeus.io');
      const prefix = typeof ctx.flags.prefix === 'string' ? ctx.flags.prefix : '/api/mobile/';
      const created = await createRelaySession(cloud, key, Number(ctx.flags.ttl), prefix);
      if (!created.ok) return { text: `could not create the relay session (${created.status})`, code: 1 };
      const session = (await created.json()) as { token: string; expiresAt: string };
      const client = new RelayClient({ cloud, token: session.token, backend: String(ctx.flags.backend), prefix });
      await client.listen();
      const interrupt = () => client.close();
      process.once('SIGINT', interrupt);
      try {
        ctx.err(`relay listening: ${apiUrl(cloud, session.token, prefix)} (expires ${session.expiresAt})`);
        await client.finished;
      } finally {
        process.off('SIGINT', interrupt);
        client.close();
      }
      return { text: 'relay closed' };
    },
  }),
];

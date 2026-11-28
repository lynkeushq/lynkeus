import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { define } from '../registry.js';
import { failedPage, failureReason, PAGE_HEADERS, signedInPage } from './loginPage.js';
import { serviceBase } from './report.js';

export type Credential = {
  cloud: string;
  clientId: string;
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  scope: string;
  organization?: { id: string; name: string };
  account?: { email: string };
};

export const DEFAULT_CLOUD = 'https://lynkeus.io';
const SCOPE = 'fastsim:download';
const REFRESH_MARGIN_MS = 60_000;
// A renewal is two requests; both are cut off well before another process may take the lock over as stale.
const LOCK_STALE_MS = 30_000;
const RENEW_TIMEOUT_MS = 15_000;
const LOCK_WAIT_MS = 45_000;
const LOGIN_TIMEOUT_MS = 15 * 60_000;

export const cloudUrl = (flag: unknown): string => serviceBase(typeof flag === 'string' ? flag : (process.env.LYNKEUS_REPORTS_URL ?? DEFAULT_CLOUD));

export const credentialsPath = (): string => path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'lynkeus', 'credentials.json');

const readAll = (): Record<string, Credential> => {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(credentialsPath(), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, Credential>) : {};
  } catch {
    return {};
  }
};

const writeAll = (all: Record<string, Credential>): void => {
  const file = credentialsPath();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const staging = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(staging, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(staging, 0o600);
  fs.renameSync(staging, file);
};

export const savedLogin = (cloud: string): Credential | undefined => readAll()[serviceBase(cloud)];

export const saveLogin = (credential: Credential): void => writeAll({ ...readAll(), [serviceBase(credential.cloud)]: credential });

export const removeLogin = (cloud: string): boolean => {
  const all = readAll();
  const key = serviceBase(cloud);
  if (!(key in all)) return false;
  delete all[key];
  writeAll(all);
  return true;
};

type LockOwner = { pid: number; host: string; nonce: string };

const isStale = (lock: string, raw: string): boolean => {
  try {
    if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) return true;
  } catch {
    return false;
  }
  let owner: Partial<LockOwner>;
  try {
    owner = JSON.parse(raw) as Partial<LockOwner>;
  } catch {
    // A lock being written right now reads empty; the age check above catches one that stays broken.
    return false;
  }
  if (owner.host !== os.hostname() || typeof owner.pid !== 'number') return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
};

/**
 * Runs `work` holding an exclusive lock next to credentials.json, so two processes (an MCP server and a terminal, two
 * terminals) never renew the same refresh token: the service rotates it and ends the whole sign-in when a used one comes
 * back. A lock whose owner died on this machine, or older than LOCK_STALE_MS, is taken over.
 */
export const withCredentialsLock = async <T>(work: () => Promise<T> | T): Promise<T> => {
  const file = credentialsPath();
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const me: LockOwner = { pid: process.pid, host: os.hostname(), nonce: crypto.randomBytes(8).toString('hex') };
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.writeFileSync(lock, JSON.stringify(me), { flag: 'wx', mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    let raw = '';
    try {
      raw = fs.readFileSync(lock, 'utf8');
    } catch {
      continue;
    }
    if (isStale(lock, raw)) {
      // Removed only if it is still the lock judged stale, so a lock another process just took over is left alone.
      try {
        if (fs.readFileSync(lock, 'utf8') === raw) fs.unlinkSync(lock);
      } catch {}
      continue;
    }
    if (Date.now() > deadline) throw new Error(`another lynkeus process holds ${lock}; try again, or delete that file if no lynkeus is running`);
    await new Promise((resolve) => setTimeout(resolve, 25 + Math.random() * 50));
  }
  try {
    return await work();
  } finally {
    try {
      if (fs.readFileSync(lock, 'utf8') === JSON.stringify(me)) fs.unlinkSync(lock);
    } catch {}
  }
};

type Fetch = typeof fetch;

class OAuthError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

const oauthError = async (response: Response, doing: string): Promise<Error> => {
  if (response.status >= 300 && response.status < 400) return new Error(`${doing}: the service answered a redirect, which is not followed`);
  const body = (await response.json().catch(() => undefined)) as { error?: unknown; error_description?: unknown } | undefined;
  const reason = [body?.error, body?.error_description].filter((v) => typeof v === 'string').join(': ') || `HTTP ${response.status}`;
  return new OAuthError(`${doing}: ${reason}`, typeof body?.error === 'string' ? body.error : undefined);
};

// Endpoints the service names get the same checks as its own address, and stay on its origin so a code or a
// refresh token never goes to another host.
const endpoint = (cloud: string, value: unknown, name: string): string => {
  if (typeof value !== 'string') throw new Error(`the service's sign-in metadata has no ${name}`);
  const url = serviceBase(value);
  if (new URL(url).origin !== new URL(cloud).origin) throw new Error(`the service's ${name} is on another host than ${cloud}`);
  return url;
};

const tokenRequest = async (tokenEndpoint: string, params: Record<string, string>, doing: string, fetchImpl: Fetch, signal?: AbortSignal) => {
  const response = await fetchImpl(tokenEndpoint, {
    method: 'POST',
    redirect: 'manual',
    signal,
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(params).toString(),
  });
  if (!response.ok) throw await oauthError(response, doing);
  const body = (await response.json().catch(() => undefined)) as
    | { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown; organization?: unknown; account?: unknown }
    | undefined;
  if (typeof body?.access_token !== 'string' || !body.access_token) throw new Error(`${doing}: the service answered no access token`);
  const org = body.organization as { id?: unknown; name?: unknown } | null | undefined;
  const account = body.account as { email?: unknown } | null | undefined;
  return {
    ...(typeof org?.id === 'string' && typeof org.name === 'string' && { organization: { id: org.id, name: org.name } }),
    ...(typeof account?.email === 'string' && { account: { email: account.email } }),
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
    expiresAt: Date.now() + (typeof body.expires_in === 'number' ? body.expires_in : 3600) * 1000,
    scope: typeof body.scope === 'string' ? body.scope : SCOPE,
  };
};

const metadata = async (cloud: string, fetchImpl: Fetch, signal?: AbortSignal) => {
  const response = await fetchImpl(`${cloud}/.well-known/oauth-authorization-server`, { redirect: 'manual', signal, headers: { accept: 'application/json' } });
  if (!response.ok) throw await oauthError(response, 'cannot read the sign-in metadata (is this service new enough?)');
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return {
    authorize: endpoint(cloud, body.authorization_endpoint, 'authorization_endpoint'),
    token: endpoint(cloud, body.token_endpoint, 'token_endpoint'),
    register: endpoint(cloud, body.registration_endpoint, 'registration_endpoint'),
  };
};

export const openInBrowser = (url: string): Promise<boolean> =>
  new Promise((resolve) => {
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : undefined;
    if (!command) return resolve(false);
    const child = spawn(command, [url], { stdio: 'ignore', detached: true });
    child.once('error', () => resolve(false));
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });

export type LoginOptions = {
  cloud: string;
  /** Opens the sign-in URL; false (or a failure) prints it instead. */
  open?: (url: string) => Promise<boolean> | boolean;
  tell?: (line: string) => void;
  timeoutMs?: number;
  fetchImpl?: Fetch;
  /** What the person typed to start the sign-in; the browser page shows it. */
  command?: string;
};

type Callback = { params: URLSearchParams; answer: (html: string) => void };

// The browser's request stays open until the caller has the outcome, so the page can say how the sign-in ended.
const waitForCallback = (server: ReturnType<typeof createServer>, timeoutMs: number): Promise<Callback> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for the browser sign-in (15 minutes)')), timeoutMs);
    let taken = false;
    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback' || taken) {
        res.writeHead(404).end();
        return;
      }
      taken = true;
      clearTimeout(timer);
      resolve({
        params: url.searchParams,
        answer: (html) => {
          res.writeHead(200, PAGE_HEADERS);
          res.end(html);
        },
      });
    });
  });

const shortReason = (error: Error): string => {
  const text = error.message.replace(/^cannot finish the sign-in: /, '').replace(/\.$/, '');
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
};

export const login = async (o: LoginOptions): Promise<Credential> => {
  const fetchImpl = o.fetchImpl ?? fetch;
  const cloud = serviceBase(o.cloud);
  const meta = await metadata(cloud, fetchImpl);

  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;
    const registered = await fetchImpl(meta.register, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      // An identifier, not copy: lynkeus.io recognizes the CLI by this exact name (CLI_NAME in its oauth.ts).
      body: JSON.stringify({ client_name: 'lynkeus CLI', redirect_uris: [redirectUri] }),
    });
    if (!registered.ok) throw await oauthError(registered, 'cannot register this sign-in');
    const { client_id: clientId } = (await registered.json().catch(() => ({}))) as { client_id?: unknown };
    if (typeof clientId !== 'string' || !clientId) throw new Error('cannot register this sign-in: the service answered no client_id');

    const verifier = crypto.randomBytes(32).toString('base64url');
    const state = crypto.randomBytes(16).toString('base64url');
    const authorize = new URL(meta.authorize);
    for (const [k, v] of Object.entries({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
      code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      scope: SCOPE,
    }))
      authorize.searchParams.set(k, v);

    const tell = o.tell ?? (() => {});
    const callback = waitForCallback(server, o.timeoutMs ?? LOGIN_TIMEOUT_MS);
    callback.catch(() => {});
    const opened = o.open ? await o.open(authorize.toString()) : false;
    if (!opened) tell(`open this address in a browser to sign in:\n${authorize.toString()}`);
    else tell('waiting for the sign-in in your browser...');

    const { params, answer } = await callback;
    const command = o.command ?? 'lynkeus login';
    const fail = (reason: string, error: Error): never => {
      answer(failedPage(reason));
      throw error;
    };
    if (params.get('state') !== state) fail(failureReason.state, new Error('the sign-in answered with a state that is not ours; it was refused'));
    const denied = params.get('error');
    if (denied) {
      const description = params.get('error_description');
      const error = new Error(
        denied === 'access_denied'
          ? `You chose Deny on ${new URL(cloud).host}: not signed in. To try again: ${command}`
          : `the sign-in was refused: ${[denied, description].filter(Boolean).join(': ')}`,
      );
      fail(denied === 'access_denied' ? failureReason.denied : failureReason.service(description || denied), error);
    }
    const code = params.get('code');
    if (!code) fail(failureReason.service('The service answered without a code.'), new Error('the sign-in answered without a code'));

    const tokens = await tokenRequest(
      meta.token,
      { grant_type: 'authorization_code', code: code as string, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier },
      'cannot finish the sign-in',
      fetchImpl,
    ).catch((error: Error) => fail(failureReason.exchange(new URL(cloud).host, shortReason(error)), error));
    const credential: Credential = { cloud, clientId, ...tokens };
    await withCredentialsLock(() => saveLogin(credential));
    answer(signedInPage({ command, cloud, organization: tokens.organization?.name, email: tokens.account?.email }));
    return credential;
  } finally {
    server.closeAllConnections();
    server.close();
  }
};

const fresh = (credential: Credential) => credential.expiresAt - Date.now() > REFRESH_MARGIN_MS;

/**
 * A bearer token from the saved sign-in for this cloud, refreshed first when it expires within a minute. The renewal
 * holds the credentials lock and reads the file again under it, so a process that waited while another renewed uses
 * the new tokens instead of presenting the used refresh token.
 */
export const signedInToken = async (cloud: string, fetchImpl: Fetch = fetch): Promise<string | undefined> => {
  const first = savedLogin(cloud);
  if (!first) return undefined;
  if (fresh(first)) return first.accessToken;
  return withCredentialsLock(async () => {
    const saved = savedLogin(cloud);
    if (!saved) return undefined;
    if (fresh(saved)) return saved.accessToken;
    if (!saved.refreshToken) throw new Error('your sign-in expired: run lynkeus login again');
    const signal = AbortSignal.timeout(RENEW_TIMEOUT_MS);
    const meta = await metadata(serviceBase(cloud), fetchImpl, signal);
    let renewed: Awaited<ReturnType<typeof tokenRequest>>;
    try {
      renewed = await tokenRequest(
        meta.token,
        { grant_type: 'refresh_token', refresh_token: saved.refreshToken, client_id: saved.clientId },
        'your sign-in could not be renewed; run lynkeus login again',
        fetchImpl,
        signal,
      );
    } catch (error) {
      // A process that does not take the lock (an older lynkeus) may have renewed meanwhile and made ours the used token.
      const now = savedLogin(cloud);
      if (error instanceof OAuthError && error.code === 'invalid_grant' && now && now.refreshToken !== saved.refreshToken && fresh(now)) return now.accessToken;
      throw error;
    }
    saveLogin({ ...saved, ...renewed, refreshToken: renewed.refreshToken ?? saved.refreshToken });
    return renewed.accessToken;
  });
};

export const loginCommands = [
  define({
    name: 'login',
    group: 'runs',
    summary: 'Sign in to lynkeus.io in a browser, so a member with a Lynkeus FastSim seat can download it without a key',
    details:
      'Opens the sign-in page of the reports service (LYNKEUS_REPORTS_URL, https://lynkeus.io by default) in your browser, where you sign in and pick the organization. A short-lived listener on 127.0.0.1 receives the answer, once, for at most 15 minutes; the sign-in uses PKCE, and the CLI registers itself with the service for each login. The tokens are saved in ~/.config/lynkeus/credentials.json (XDG_CONFIG_HOME moves it; the file is readable only by you), one entry per service address. `lynkeus fastsim install` uses them when LYNKEUS_CLOUD_KEY is not set, and renews them as they expire. lynkeus logout removes them. Exit code 1 when the sign-in fails or is refused.',
    flags: {
      cloud: { type: 'string', help: 'service URL (default LYNKEUS_REPORTS_URL or https://lynkeus.io)', value: 'url' },
      'no-browser': { type: 'boolean', help: 'print the sign-in address instead of opening it' },
    },
    needs: 'nothing',
    session: false,
    mcp: false,
    run: async (ctx) => {
      try {
        const cloud = cloudUrl(ctx.flags.cloud);
        const credential = await login({ cloud, open: ctx.flags['no-browser'] ? undefined : openInBrowser, tell: ctx.err, command: 'lynkeus login' });
        const who = credential.account && credential.organization ? ` as ${credential.account.email} in ${credential.organization.name}` : '';
        return {
          text: `signed in to ${credential.cloud}${who} (${credential.scope}); saved in ${credentialsPath()}`,
          json: {
            cloud: credential.cloud,
            ...(credential.organization && { organization: credential.organization }),
            ...(credential.account && { account: credential.account }),
            scope: credential.scope,
            expiresAt: credential.expiresAt,
            file: credentialsPath(),
          },
        };
      } catch (error) {
        return { text: (error as Error).message, code: 1 };
      }
    },
  }),
  define({
    name: 'logout',
    group: 'runs',
    summary: 'Remove the saved sign-in for a lynkeus.io service from this machine',
    details:
      "Deletes that service's entry from ~/.config/lynkeus/credentials.json. The sign-in stays valid on the service until it expires; an owner can end it there.",
    flags: { cloud: { type: 'string', help: 'service URL (default LYNKEUS_REPORTS_URL or https://lynkeus.io)', value: 'url' } },
    needs: 'nothing',
    session: false,
    mcp: false,
    run: async (ctx) => {
      try {
        const cloud = cloudUrl(ctx.flags.cloud);
        return (await withCredentialsLock(() => removeLogin(cloud)))
          ? { text: `signed out of ${cloud}`, json: { cloud, removed: true } }
          : { text: `no sign-in saved for ${cloud}`, json: { cloud, removed: false } };
      } catch (error) {
        return { text: (error as Error).message, code: 2 };
      }
    },
  }),
];

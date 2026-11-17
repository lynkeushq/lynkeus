import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { define, type Ctx, type Result } from '../registry.js';
import { cloudUrl, login, openInBrowser, signedInToken, type Credential, type LoginOptions } from './login.js';
import { serviceBase } from './report.js';

export type FastsimRelease = { version: string; variant: string; sha256: string; bytes: number; signature?: string };

// lynkeus's release key (Ed25519, raw 32 bytes). Packages are signed offline with the private half.
const RELEASE_PUBLIC_KEY_HEX = '552b561f9ca6d1b1c102959b33880a3007d34adbd57783d3437953545b019309';
const SPKI_ED25519_PREFIX = '302a300506032b6570032100';

export const RELEASE_KEY = crypto.createPublicKey({
  key: Buffer.from(SPKI_ED25519_PREFIX + RELEASE_PUBLIC_KEY_HEX, 'hex'),
  format: 'der',
  type: 'spki',
});

const isSigned = (archive: Buffer, signature: unknown, key: crypto.KeyObject): boolean => {
  if (typeof signature !== 'string' || !signature) return false;
  try {
    return crypto.verify(null, archive, key, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
};

const RELEASE_PART = /^[a-z0-9.-]{1,32}$/;

export const fastsimCacheDir = (): string =>
  process.env.LYNKEUS_FASTSIM_DIR ?? path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), 'lynkeus', 'fastsim');

class Refused extends Error {}

const failure = async (response: Response, what: string, signedIn = false): Promise<string> => {
  const body = (await response.json().catch(() => undefined)) as { error?: unknown } | undefined;
  const reason = typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`;
  if (response.status === 401 && signedIn) return `${what}: the sign-in was refused (${reason}); sign in again with lynkeus login`;
  if (response.status === 401)
    return `${what}: the key was refused (${reason}); LYNKEUS_CLOUD_KEY is an API key an owner of your organization made with "May download fastsim" on lynkeus.io`;
  return `${what}: ${reason}`;
};

const refusal = async (response: Response, what: string, signedIn: boolean | undefined): Promise<Error> => {
  const message = await failure(response, what, signedIn);
  return response.status === 401 ? new Refused(message) : new Error(message);
};

// iOS matches the simulator only on a Mac; Linux draws it with the Inter stand-in. Windows runs the Linux build in WSL2.
export const fastsimVariant = (platform: string, os: NodeJS.Platform = process.platform, arch: string = process.arch): string => {
  if (platform !== 'ios' && platform !== 'android') throw new Error(`the platform is ios or android, not ${platform}`);
  if (os === 'win32') throw new Error('Lynkeus FastSim runs on Windows inside WSL2: run lynkeus there, where it installs the Linux build');
  if (os === 'darwin') {
    if (arch !== 'arm64') throw new Error('Lynkeus FastSim runs on Apple Silicon Macs only');
    return `darwin-arm64-${platform}`;
  }
  if (os === 'linux' && (arch === 'x64' || arch === 'arm64')) return `linux-${arch}-${platform}`;
  throw new Error(`Lynkeus FastSim has no build for ${os} on ${arch}`);
};

export const pickRelease = (releases: FastsimRelease[], version: string, variant: string): FastsimRelease | undefined =>
  releases.find((r) => r.variant === variant && (version === 'latest' || r.version === version));

// The service already sends the newest first; a list it answers out of order must not install an older host.
export const newestFirst = (releases: FastsimRelease[]): FastsimRelease[] =>
  [...releases].sort((a, b) => {
    const pa = a.version.split('.').map(Number);
    const pb = b.version.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pb[i] ?? 0) !== (pa[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0);
    return 0;
  });

export type InstallOptions = {
  cloud: string;
  key: string;
  version: string;
  variant: string;
  dir: string;
  force?: boolean;
  /** The key is a browser sign-in's token, not an API key: only the 401 advice changes. */
  signedIn?: boolean;
  /** The key packages must be signed with; only tests pass another. */
  releaseKey?: crypto.KeyObject;
  fetchImpl?: typeof fetch;
};

export type InstallResult = { release: FastsimRelease; dir: string; installed: boolean };

export const installFastsim = async (o: InstallOptions): Promise<InstallResult> => {
  const fetchImpl = o.fetchImpl ?? fetch;
  const base = serviceBase(o.cloud);
  const auth = { authorization: `Bearer ${o.key}` };
  // A redirect could carry the key to another host.
  const listed = await fetchImpl(`${base}/v1/fastsim/releases`, { headers: auth, redirect: 'manual' });
  if (!listed.ok) throw await refusal(listed, 'cannot list Lynkeus FastSim releases', o.signedIn);
  const { releases } = (await listed.json()) as { releases: FastsimRelease[] };
  const release = pickRelease(newestFirst(releases ?? []), o.version, o.variant);
  if (!release) {
    const offered = [...new Set((releases ?? []).map((r) => `${r.version} ${r.variant}`))].join(', ') || 'none';
    throw new Error(`no Lynkeus FastSim release ${o.version} for ${o.variant}; this organization can install: ${offered}`);
  }
  if (!RELEASE_PART.test(release.version) || !RELEASE_PART.test(release.variant) || !/^[0-9a-f]{64}$/.test(release.sha256))
    throw new Error('the service answered a release that is not well formed');

  const target = path.join(o.dir, release.version, release.variant);
  const marker = path.join(target, '.sha256');
  if (!o.force && fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() === release.sha256) return { release, dir: target, installed: false };

  const download = await fetchImpl(`${base}/v1/fastsim/releases/${release.version}/${release.variant}`, { headers: auth, redirect: 'manual' });
  if (!download.ok) throw new Error(await failure(download, `cannot download Lynkeus FastSim ${release.version}`, o.signedIn));
  const archive = Buffer.from(await download.arrayBuffer());
  const digest = crypto.createHash('sha256').update(archive).digest('hex');
  if (digest !== release.sha256)
    throw new Error(`Lynkeus FastSim ${release.version} arrived damaged: its digest is ${digest}, the release says ${release.sha256}`);

  if (!isSigned(archive, release.signature, o.releaseKey ?? RELEASE_KEY))
    throw new Error(`Lynkeus FastSim ${release.version} is not signed by lynkeus: not installed`);

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const staging = fs.mkdtempSync(path.join(path.dirname(target), `.${release.variant}-`));
  try {
    const file = path.join(staging, 'archive.tar.gz');
    fs.writeFileSync(file, archive);
    const unpacked = path.join(staging, 'unpacked');
    fs.mkdirSync(unpacked);
    // bsdtar and GNU tar both refuse absolute paths and `..` unless told otherwise.
    const tar = spawnSync('tar', ['-xzf', file, '-C', unpacked, '--no-same-owner'], { encoding: 'utf8' });
    if (tar.status !== 0) throw new Error(`cannot unpack Lynkeus FastSim ${release.version}: ${(tar.stderr || tar.error?.message || '').trim()}`);
    fs.writeFileSync(path.join(unpacked, '.sha256'), `${release.sha256}\n`);
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(unpacked, target);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return { release, dir: target, installed: true };
};

const GRANT_MIN_LEFT_MS = 5 * 60_000;

export type Grant = { grant: string; expiresAt: string };

export const grantCacheFile = (cloud: string, variant: string): string =>
  path.join(
    process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'),
    'lynkeus',
    'fastsim',
    'grants',
    crypto.createHash('sha256').update(serviceBase(cloud)).digest('hex').slice(0, 16),
    `${variant}.json`,
  );

const readCachedGrant = (file: string, now: number): Grant | undefined => {
  try {
    const cached = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Grant>;
    if (typeof cached.grant === 'string' && typeof cached.expiresAt === 'string' && Date.parse(cached.expiresAt) - now > GRANT_MIN_LEFT_MS)
      return { grant: cached.grant, expiresAt: cached.expiresAt };
  } catch {
    // no cache, or one that cannot be read: ask again
  }
  return undefined;
};

export type GrantOptions = {
  cloud: string;
  key: string;
  variant: string;
  signedIn?: boolean;
  now?: number;
  fetchImpl?: typeof fetch;
};

/** The cached grant while it has more than 5 minutes left, else a new one from the service (cached, private). */
export const fetchGrant = async (o: GrantOptions): Promise<Grant & { cached: boolean }> => {
  if (!RELEASE_PART.test(o.variant)) throw new Error(`${o.variant} is not a Lynkeus FastSim build name`);
  const file = grantCacheFile(o.cloud, o.variant);
  const hit = readCachedGrant(file, o.now ?? Date.now());
  if (hit) return { ...hit, cached: true };
  const response = await (o.fetchImpl ?? fetch)(`${serviceBase(o.cloud)}/v1/fastsim/grants`, {
    method: 'POST',
    redirect: 'manual',
    headers: { authorization: `Bearer ${o.key}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ variant: o.variant }),
  });
  if (!response.ok) throw await refusal(response, 'cannot get a Lynkeus FastSim grant', o.signedIn);
  const body = (await response.json().catch(() => undefined)) as Partial<Grant> | undefined;
  if (typeof body?.grant !== 'string' || !body.grant.startsWith('v1.') || typeof body.expiresAt !== 'string' || Number.isNaN(Date.parse(body.expiresAt)))
    throw new Error('cannot get a Lynkeus FastSim grant: the service answered a grant that is not well formed');
  const grant = { grant: body.grant, expiresAt: body.expiresAt };
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const staging = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(staging, `${JSON.stringify(grant)}\n`, { mode: 0o600 });
  fs.chmodSync(staging, 0o600);
  fs.renameSync(staging, file);
  return { ...grant, cached: false };
};

const NO_CREDENTIALS = (cloud: string) =>
  `no way to sign in to ${cloud}: set LYNKEUS_CLOUD_KEY to an API key an owner of your organization made with "May download fastsim" on lynkeus.io (in mise.local.toml or your CI secrets), or run lynkeus login to sign in as a member with a FastSim seat`;

export type SignInDeps = {
  /** Whether stdin and stderr are terminals; only tests pass another. */
  tty?: () => boolean;
  signIn?: (o: LoginOptions) => Promise<Credential>;
  open?: LoginOptions['open'];
};

// Scripts, CI and MCP servers never wait on a browser: only a person at a terminal is sent to sign in.
const bothTty = () => process.stdin.isTTY === true && process.stderr.isTTY === true;

/**
 * Runs `attempt` with a key, the saved sign-in or, for a person at a terminal, a sign-in made now (also once more when
 * the saved one is refused). Undefined when there is nothing to sign in with and nobody to ask.
 */
const withCredentials = async <T>(
  ctx: Ctx,
  deps: SignInDeps,
  cloud: string,
  attempt: (key: string, signedIn: boolean) => Promise<T>,
): Promise<T | undefined> => {
  const envKey = process.env.LYNKEUS_CLOUD_KEY ?? process.env.LYNKEUS_REPORTS_KEY;
  const mayAsk = !ctx.attached && !process.env.CI && (deps.tty ?? bothTty)();
  const signIn = async (): Promise<string> => {
    const credential = await (deps.signIn ?? login)({
      cloud,
      open: ctx.flags['no-browser'] === true ? undefined : (deps.open ?? openInBrowser),
      tell: ctx.err,
    });
    return credential.accessToken;
  };
  if (envKey) return attempt(envKey, false);
  // A sign-in past its 30 days, or whose refresh the service no longer takes, is signed in again the same way.
  const saved = await signedInToken(cloud).catch((error: unknown) => {
    if (!mayAsk) throw error;
    ctx.err(`The saved sign-in for ${cloud} has ended (${(error as Error).message}): signing in again (lynkeus login)…`);
    return null;
  });
  if (saved === null) return attempt(await signIn(), true);
  if (!saved && !mayAsk) return undefined;
  if (!saved) {
    ctx.err(`No key or sign-in for ${cloud}: opening the browser to sign in (lynkeus login)…`);
    return attempt(await signIn(), true);
  }
  try {
    return await attempt(saved, true);
  } catch (error) {
    if (!(error instanceof Refused) || !mayAsk) throw error;
    ctx.err(`The saved sign-in for ${cloud} was refused (ended or revoked): signing in again (lynkeus login)…`);
    return attempt(await signIn(), true);
  }
};

export const makeFastsimCommands = (releaseKey: crypto.KeyObject = RELEASE_KEY, deps: SignInDeps = {}) => [
  define({
    name: 'fastsim install',
    group: 'runs',
    summary: "Download Lynkeus FastSim for this machine and a platform from lynkeus.io with the organization's key",
    details:
      "Asks lynkeus.io which Lynkeus FastSim releases the organization may install (with LYNKEUS_CLOUD_KEY, an API key an owner of the organization made with “May download fastsim”, or else the sign-in `lynkeus login` saved, for a member with a FastSim seat; other keys are refused), downloads the build for this machine and --platform (ios unless told: darwin-arm64-ios on an Apple Silicon Mac, linux-x64-android on Linux, and so on; on Windows run it inside WSL2), checks its SHA-256 and its Ed25519 signature (packages are signed by lynkeus; a release with no signature or a wrong one is refused, nothing is unpacked) and unpacks it into ~/.cache/lynkeus/fastsim/<version>/<variant> (LYNKEUS_FASTSIM_DIR moves it). Install each platform you test on its own: a Mac's iOS build is about 8 MB, its Android build about 65 MB. iOS matches the simulator only on a Mac; on Linux it is close but drawn with another font. An installed release with the same digest is kept. The package's README says how to bundle the app (bin/fastsim-bundle) and run cases on it (bin/fastsim-run with case run --host-command). With no key and no saved sign-in, a person at a terminal (stdin and stderr are TTYs, CI unset) is signed in first, as lynkeus login does, and the install goes on; so is a saved sign-in the service refuses, once. Scripts, CI and MCP never open a browser: they exit 2 and need LYNKEUS_CLOUD_KEY. Exit code 2 without a key or a sign-in and nobody to ask, 1 when the organization has no fastsim entitlement, the machine has no build, or the download fails.",
    mcpDetails:
      "Downloads Lynkeus FastSim (the fast simulator, for organizations whose plan includes it) for this machine and the platform asked for, and answers where it went. Needs LYNKEUS_CLOUD_KEY in this server's environment (an API key an owner of the organization made with “May download fastsim”; other keys are refused with that message), or else the sign-in the person saved by running lynkeus login in a terminal (a browser step an agent cannot do: when there is none, tell the person to run it). Then read the README.md in that folder: it says how to bundle the app and run case_run with host_command on it.",
    flags: {
      version: { type: 'string', help: 'release to install', default: 'latest', value: 'version' },
      platform: { type: 'string', help: 'the platform it draws: ios or android', default: 'ios', value: 'ios|android' },
      variant: { type: 'string', help: "a build by name instead of this machine's (darwin-arm64-ios, linux-x64-android)", value: 'name' },
      cloud: { type: 'string', help: 'service URL (default LYNKEUS_REPORTS_URL or https://lynkeus.io)', value: 'url' },
      force: { type: 'boolean', help: 'download again even when that release is installed' },
      'no-browser': { type: 'boolean', help: 'when a sign-in is needed, print its address instead of opening it' },
    },
    needs: 'nothing',
    session: false,
    mcp: 'core',
    run: async (ctx) => {
      try {
        const cloud = cloudUrl(ctx.flags.cloud);
        const variant = typeof ctx.flags.variant === 'string' ? ctx.flags.variant : fastsimVariant(String(ctx.flags.platform));
        const result = await withCredentials(ctx, deps, cloud, async (key, signedIn): Promise<Result> => {
          const { release, dir, installed } = await installFastsim({
            cloud,
            key,
            version: String(ctx.flags.version),
            variant,
            dir: fastsimCacheDir(),
            force: ctx.flags.force === true,
            signedIn,
            releaseKey,
          });
          const readme = path.join(dir, 'README.md');
          const how = fs.existsSync(readme) ? `; how to run it: ${readme}` : '';
          return {
            text: `${installed ? 'installed' : 'already installed:'} Lynkeus FastSim ${release.version} (${release.variant}) in ${dir}${how}`,
            json: { ...release, dir, installed },
          };
        });
        return result ?? { text: NO_CREDENTIALS(cloud), code: 2 };
      } catch (error) {
        return { text: (error as Error).message, code: 1 };
      }
    },
  }),
  define({
    name: 'fastsim grant',
    group: 'runs',
    summary: 'Print a fresh grant a Lynkeus FastSim host needs to start, fetched from lynkeus.io (cached for an hour)',
    details:
      "Asks lynkeus.io for a grant for the build this machine runs (--platform ios unless told, or --variant by name) with LYNKEUS_CLOUD_KEY or else the sign-in `lynkeus login` saved, and prints only the grant on stdout, so a script can read it: FastSim's bin/fastsim-run runs `npx --no-install lynkeus fastsim grant --variant <variant>` before each host. A grant is valid for one hour; it is kept in ~/.cache/lynkeus/fastsim/grants/ (XDG_CACHE_HOME moves it; the file is readable only by you) and reused while it has more than 5 minutes left. Messages go to stderr. It opens a browser to sign in only when stdin and stderr are TTYs and CI is unset; otherwise it exits 2 without a key or a sign-in. Exit code 2 without a key or a sign-in and nobody to ask, 1 when the service refuses (no FastSim entitlement, a key or sign-in it does not accept, or no grants set up) or cannot be reached.",
    flags: {
      platform: { type: 'string', help: 'the platform it draws: ios or android', default: 'ios', value: 'ios|android' },
      variant: { type: 'string', help: "a build by name instead of this machine's (darwin-arm64-ios, linux-x64-android)", value: 'name' },
      cloud: { type: 'string', help: 'service URL (default LYNKEUS_REPORTS_URL or https://lynkeus.io)', value: 'url' },
    },
    needs: 'nothing',
    session: false,
    mcp: false,
    run: async (ctx) => {
      try {
        const cloud = cloudUrl(ctx.flags.cloud);
        const variant = typeof ctx.flags.variant === 'string' ? ctx.flags.variant : fastsimVariant(String(ctx.flags.platform));
        const result = await withCredentials(ctx, deps, cloud, async (key, signedIn): Promise<Result> => {
          const got = await fetchGrant({ cloud, key, variant, signedIn });
          ctx.err(`${got.cached ? 'cached' : 'new'} Lynkeus FastSim grant for ${variant}, valid until ${got.expiresAt}`);
          return { text: got.grant, json: { grant: got.grant, expiresAt: got.expiresAt, variant } };
        });
        return result ?? { text: NO_CREDENTIALS(cloud), code: 2 };
      } catch (error) {
        return { text: (error as Error).message, code: 1 };
      }
    },
  }),
];

export const fastsimCommands = makeFastsimCommands();

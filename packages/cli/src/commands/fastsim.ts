import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { freshBundle } from '../cases/staleBundle.js';
import { portFromEnv } from '../config.js';
import type { Device } from '../device/driver.js';
import { define, type Ctx, type Result } from '../registry.js';
import { runtimeAt } from '../runtimes/index.js';
import { cloudUrl, credentialsPath, login, openInBrowser, signedInToken, type Credential, type LoginOptions } from './login.js';
import { stopHost } from './cases.js';
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

/**
 * A random id for this install, kept next to the sign-in (not in the cache, which CI restores onto many runners and
 * would make them one machine). The service counts machines and CI hosts by it; it identifies an install, not a person.
 */
export const machineId = (file: string = path.join(path.dirname(credentialsPath()), 'machine-id')): string => {
  try {
    const saved = fs.readFileSync(file, 'utf8').trim();
    if (/^[A-Za-z0-9-]{16,64}$/.test(saved)) return saved;
  } catch {
    // none yet
  }
  const id = crypto.randomUUID();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${id}\n`, { mode: 0o600 });
  } catch {
    // a read-only home: the id lasts for this run only
  }
  return id;
};

const MACHINE_HEADER = 'x-lynkeus-machine';

class Refused extends Error {}

// The service sends no error code, only 403 and a sentence of its own; these match its wording for a missing plan or seat.
const planHint = (reason: string): string => {
  if (/no Lynkeus FastSim entitlement|entitlement has expired|entitlement does not include/.test(reason)) return '\nPlans: https://lynkeus.io/pricing';
  if (/no Lynkeus FastSim seat/.test(reason)) return '\nAn owner gives seats under Members on lynkeus.io';
  return '';
};

const failure = async (response: Response, what: string, signedIn = false): Promise<string> => {
  const body = (await response.json().catch(() => undefined)) as { error?: unknown } | undefined;
  const reason = typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`;
  if (response.status === 401 && signedIn) return `${what}: the sign-in was refused (${reason}); sign in again with lynkeus login`;
  if (response.status === 401)
    return `${what}: the key was refused (${reason}); LYNKEUS_CLOUD_KEY is an API key an owner of your organization made with "May download Lynkeus FastSim" on lynkeus.io`;
  const hint = response.status === 403 ? planHint(reason) : '';
  return `${what}: ${reason}${hint}`;
};

const refusal = async (response: Response, what: string, signedIn: boolean | undefined): Promise<Error> => {
  const message = await failure(response, what, signedIn);
  return response.status === 401 ? new Refused(message) : new Error(message);
};

export const installedFastsim = (dir: string = fastsimCacheDir()): { version: string; variant: string }[] => {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((v) => v.isDirectory() && RELEASE_PART.test(v.name) && v.name !== 'grants')
      .flatMap((v) =>
        fs
          .readdirSync(path.join(dir, v.name), { withFileTypes: true })
          .filter((b) => b.isDirectory() && fs.existsSync(path.join(dir, v.name, b.name, '.sha256')))
          .map((b) => ({ version: v.name, variant: b.name })),
      );
  } catch {
    return [];
  }
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
  const auth = { authorization: `Bearer ${o.key}`, [MACHINE_HEADER]: machineId() };
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
    throw new Error(`Lynkeus FastSim ${release.version} is not signed by Lynkeus: not installed`);

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

export type Grant = { grant: string; expiresAt: string; warning?: string };

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
    headers: { authorization: `Bearer ${o.key}`, 'content-type': 'application/json', accept: 'application/json', [MACHINE_HEADER]: machineId() },
    body: JSON.stringify({ variant: o.variant }),
  });
  if (!response.ok) throw await refusal(response, 'cannot get a Lynkeus FastSim grant', o.signedIn);
  const body = (await response.json().catch(() => undefined)) as (Partial<Grant> & { warning?: unknown }) | undefined;
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
  return { ...grant, cached: false, ...(typeof body.warning === 'string' ? { warning: body.warning } : {}) };
};

// An agent reads the first line and decides from it whether to retry: it must say this step is the person's.
const PERSON_ONLY = 'A step only the person can do: run `lynkeus login` in a terminal and sign in in the browser it opens (an agent cannot), then try again.';
const CI_KEY =
  'in CI, set LYNKEUS_CLOUD_KEY to an API key an owner of your organization made with "May download Lynkeus FastSim" on lynkeus.io (in your CI secrets or mise.local.toml).';

const NO_CREDENTIALS = (cloud: string) => `${PERSON_ONLY}\nno way to sign in to ${cloud}: no saved sign-in and no key; ${CI_KEY}`;

/** A sign-in that has ended, with nobody here to sign in again: only the person can, so the message leads with that. */
class PersonOnly extends Error {
  constructor(cloud: string, reason: string) {
    super(`${PERSON_ONLY}\nthe saved sign-in for ${cloud} has ended (${reason}); ${CI_KEY}`);
  }
}

/** Exit 2 for what needs the person (as with no sign-in at all), 1 for any other failure. */
const failedCode = (error: unknown) => (error instanceof PersonOnly ? 2 : 1);

export type SignInDeps = {
  /** Whether stdin and stderr are terminals; only tests pass another. */
  tty?: () => boolean;
  /** Whether stdout is a terminal (a person reads it, not a script); only tests pass another. */
  stdoutTty?: () => boolean;
  signIn?: (o: LoginOptions) => Promise<Credential>;
  open?: LoginOptions['open'];
};

/** The variant of an installed licensed Lynkeus FastSim whose `bin/fastsim-run` a host command starts; undefined for any other command. */
export const licensedFastsimVariant = (command: string, cwd: string): string | undefined => {
  const run = /(?:^|[\s"'=])((?:[^\s"']*\/)?bin\/fastsim-run)(?=[\s"']|$)/.exec(command)?.[1];
  if (!run) return undefined;
  try {
    const kit = path.dirname(path.dirname(path.resolve(cwd, run.replace(/^~(?=\/)/, os.homedir()))));
    const variant = fs.readFileSync(path.join(kit, 'share', 'licensed'), 'utf8').trim();
    return RELEASE_PART.test(variant) ? variant : undefined;
  } catch {
    return undefined;
  }
};

export type HostGrantOptions = { deps?: SignInDeps; fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv };

/**
 * The environment a host started by `command` needs: a licensed Lynkeus FastSim host gets FASTSIM_GRANT from the same
 * credentials, cache and variant as `lynkeus fastsim grant`, so it does not depend on `npx --no-install lynkeus` finding
 * lynkeus. Any other host command, or a FASTSIM_GRANT already set, adds nothing. A grant that cannot be had is a failed run.
 */
export const hostGrantEnv = async (ctx: Ctx, command: string, o: HostGrantOptions = {}): Promise<{ env: NodeJS.ProcessEnv } | { failed: Result }> => {
  const base = o.env ?? process.env;
  const variant = licensedFastsimVariant(command, ctx.root);
  if (!variant || base.FASTSIM_GRANT) return { env: base };
  try {
    const cloud = cloudUrl(undefined);
    const got = await withCredentials(ctx, o.deps ?? {}, cloud, async (key, signedIn) => {
      const grant = await fetchGrant({ cloud, key, variant, signedIn, fetchImpl: o.fetchImpl });
      if (grant.warning) ctx.err(`warning: ${grant.warning}`);
      return grant;
    });
    if (!got) return { failed: { text: NO_CREDENTIALS(cloud), code: 2 } };
    return { env: { ...base, FASTSIM_GRANT: got.grant } };
  } catch (error) {
    return { failed: { text: (error as Error).message, code: failedCode(error) } };
  }
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
      command: `lynkeus fastsim install --platform ${typeof ctx.flags.platform === 'string' ? ctx.flags.platform : 'ios'}`,
    });
    return credential.accessToken;
  };
  if (envKey) return attempt(envKey, false);
  // A sign-in past its 30 days, or whose refresh the service no longer takes, is signed in again the same way.
  const saved = await signedInToken(cloud).catch((error: unknown) => {
    if (!mayAsk) throw new PersonOnly(cloud, (error as Error).message);
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
    if (!(error instanceof Refused)) throw error;
    if (!mayAsk) throw new PersonOnly(cloud, error.message);
    ctx.err(`The saved sign-in for ${cloud} was refused (ended or revoked): signing in again (lynkeus login)…`);
    return attempt(await signIn(), true);
  }
};

const paint = (code: string, text: string) => (process.env.NO_COLOR ? text : `\x1b[${code}m${text}\x1b[0m`);

/** What a person at a terminal sees instead of the token: the token is for fastsim-run, not for reading. */
export const grantSummary = (o: { variant: string; expiresAt: string; cached: boolean; now?: number }): string => {
  const until = new Date(o.expiresAt);
  const left = Math.max(0, Math.round((until.getTime() - (o.now ?? Date.now())) / 60_000));
  const time = until.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return [
    `${paint('32', '✔')} ${paint('1', 'Lynkeus FastSim grant ready')} for ${paint('1', o.variant)}`,
    paint('2', `  valid until ${time} (${left} min left), ${o.cached ? 'reused from the cache' : 'new from lynkeus.io'}`),
    paint('2', '  fastsim-run fetches it by itself; to see the token: lynkeus fastsim grant --print'),
  ].join('\n');
};

/** The newest installed Lynkeus FastSim that draws `platform`, as its folder; undefined when none is. */
export const installedKit = (platform: string, dir: string = fastsimCacheDir()): string | undefined => {
  const kits = installedFastsim(dir)
    .map(({ version, variant }) => ({ version, kit: path.join(dir, version, variant) }))
    .filter(({ kit }) => {
      try {
        return fs.readFileSync(path.join(kit, 'share', 'platform'), 'utf8').trim() === platform && fs.existsSync(path.join(kit, 'bin', 'fastsim-run'));
      } catch {
        return false;
      }
    });
  return kits.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0]?.kit;
};

// The host `fastsim start` keeps for a session or an MCP server. It reads its standard input from this process, so it
// stops when this process does.
let exploring: { child: ChildProcess; bundle: string; port: number } | undefined;

const stopExploring = async (): Promise<string | undefined> => {
  const was = exploring;
  exploring = undefined;
  if (!was) return undefined;
  await stopHost(was.child);
  return was.bundle;
};

const nextHello = (d: Device, child: ChildProcess, timeoutMs: number): Promise<boolean> =>
  new Promise((resolve) => {
    const done = (attached: boolean) => {
      clearTimeout(timer);
      d.server.off('hello', onHello);
      child.off('exit', onExit);
      resolve(attached);
    };
    const onHello = () => done(true);
    const onExit = () => done(false);
    const timer = setTimeout(() => done(false), timeoutMs);
    d.server.once('hello', onHello);
    child.once('exit', onExit);
  });

export const makeFastsimCommands = (releaseKey: crypto.KeyObject = RELEASE_KEY, deps: SignInDeps = {}) => [
  define({
    name: 'fastsim install',
    group: 'runs',
    summary: "Download Lynkeus FastSim for this machine and a platform from lynkeus.io with the organization's key",
    details:
      "Asks lynkeus.io which Lynkeus FastSim releases the organization may install (with LYNKEUS_CLOUD_KEY, an API key an owner of the organization made with “May download Lynkeus FastSim”, or else the sign-in `lynkeus login` saved, for a member with a FastSim seat; other keys are refused), downloads the build for this machine and --platform (ios unless told: darwin-arm64-ios on an Apple Silicon Mac, linux-x64-android on Linux, and so on; on Windows run it inside WSL2), checks its SHA-256 and its Ed25519 signature (packages are signed by Lynkeus; a release with no signature or a wrong one is refused, nothing is unpacked) and unpacks it into ~/.cache/lynkeus/fastsim/<version>/<variant> (LYNKEUS_FASTSIM_DIR moves it). Install each platform you test on its own: a Mac's iOS build is about 8 MB, its Android build about 65 MB. iOS matches the simulator only on a Mac; on Linux it is close but drawn with another font. An installed release with the same digest is kept. The package's README says how to bundle the app (bin/fastsim-bundle) and run cases on it (bin/fastsim-run with case run --host-command). With no key and no saved sign-in, a person at a terminal (stdin and stderr are TTYs, CI unset) is signed in first, as lynkeus login does, and the install goes on; so is a saved sign-in the service refuses, once. Scripts, CI and MCP never open a browser: they exit 2, the first line saying that signing in is a step only the person can do (`lynkeus login`), or need LYNKEUS_CLOUD_KEY; so does a saved sign-in that expired and could not be renewed. Exit code 2 without a key or a sign-in and nobody to ask, 1 when the organization has no FastSim entitlement, the machine has no build, or the download fails.",
    mcpDetails:
      "Downloads Lynkeus FastSim (the fast simulator; optional and paid, part of the Team plan, plans at https://lynkeus.io/pricing) for this machine and the platform asked for, and answers where it went. Needs the sign-in the person saved by running lynkeus login in a terminal (a browser step an agent cannot do: when there is none, tell the person to run it), or else, for CI, LYNKEUS_CLOUD_KEY in this server's environment (an API key an owner of the organization made with “May download Lynkeus FastSim”; other keys are refused with that message). Then read the README.md in that folder: it says how to bundle the app and run case_run with host_command on it. Call it when the person asks for Lynkeus FastSim or their organization has it; otherwise the headless host and the Simulator or emulator are free and cover the same cases. When the service refuses (no FastSim in the plan, no seat, a key without that permission), tell the person what it says and where to get it (an owner subscribes at https://lynkeus.io/pricing or gives them a seat under Members), then carry on with headless or the Simulator; never retry with other credentials or look for a way around it.",
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
        const variant =
          typeof ctx.flags.variant === 'string' ? ctx.flags.variant : fastsimVariant((await runtimeAt(ctx.root)).fastsimBuild(String(ctx.flags.platform)));
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
        return { text: (error as Error).message, code: failedCode(error) };
      }
    },
  }),
  define({
    name: 'fastsim grant',
    group: 'runs',
    summary: 'Print a fresh grant a Lynkeus FastSim host needs to start, fetched from lynkeus.io (cached for an hour)',
    details:
      "Asks lynkeus.io for a grant for the build this machine runs (--platform ios unless told, or --variant by name) with LYNKEUS_CLOUD_KEY or else the sign-in `lynkeus login` saved, and prints only the grant on stdout when a script reads it (stdout not a terminal, or --print): FastSim's bin/fastsim-run runs `npx --no-install lynkeus fastsim grant --variant <variant>` before each host. At a terminal it prints a summary instead (the variant and until when it is valid), so the token does not sit on screen; --json always carries it. A grant is valid for one hour; it is kept in ~/.cache/lynkeus/fastsim/grants/ (XDG_CACHE_HOME moves it; the file is readable only by you) and reused while it has more than 5 minutes left. Messages go to stderr. It opens a browser to sign in only when stdin and stderr are TTYs and CI is unset; otherwise it exits 2 without a key or a sign-in. Exit code 2 without a key or a sign-in and nobody to ask, 1 when the service refuses (no FastSim entitlement, a key or sign-in it does not accept, or no grants set up) or cannot be reached.",
    flags: {
      platform: { type: 'string', help: 'the platform it draws: ios or android', default: 'ios', value: 'ios|android' },
      variant: { type: 'string', help: "a build by name instead of this machine's (darwin-arm64-ios, linux-x64-android)", value: 'name' },
      cloud: { type: 'string', help: 'service URL (default LYNKEUS_REPORTS_URL or https://lynkeus.io)', value: 'url' },
      print: { type: 'boolean', help: 'print the token even at a terminal (it is printed anyway when stdout is a pipe)' },
    },
    needs: 'nothing',
    session: false,
    mcp: false,
    run: async (ctx) => {
      try {
        const cloud = cloudUrl(ctx.flags.cloud);
        const forPerson = ctx.flags.print !== true && !ctx.attached && (deps.stdoutTty ?? (() => process.stdout.isTTY === true))();
        const variant =
          typeof ctx.flags.variant === 'string' ? ctx.flags.variant : fastsimVariant((await runtimeAt(ctx.root)).fastsimBuild(String(ctx.flags.platform)));
        const result = await withCredentials(ctx, deps, cloud, async (key, signedIn): Promise<Result> => {
          const got = await fetchGrant({ cloud, key, variant, signedIn });
          const json = { grant: got.grant, expiresAt: got.expiresAt, variant };
          if (got.warning) ctx.err(`warning: ${got.warning}`);
          if (forPerson) return { text: grantSummary({ variant, expiresAt: got.expiresAt, cached: got.cached }), json };
          ctx.err(`${got.cached ? 'cached' : 'new'} Lynkeus FastSim grant for ${variant}, valid until ${got.expiresAt}`);
          return { text: got.grant, json: { grant: got.grant, expiresAt: got.expiresAt, variant } };
        });
        return result ?? { text: NO_CREDENTIALS(cloud), code: 2 };
      } catch (error) {
        return { text: (error as Error).message, code: failedCode(error) };
      }
    },
  }),
  define({
    name: 'fastsim start',
    group: 'runs',
    summary: 'Start a Lynkeus FastSim host on a bundle for this session, to explore the app with screen, press and type',
    details:
      "Over MCP, or in a `lynkeus session` (which attaches to an app first): starts the installed Lynkeus FastSim's bin/fastsim-run on a bundle fastsim-bundle made (--kit names the FastSim folder; by default the newest installed one that draws the bundle's platform), on this session's driver port, and waits for its app to attach. From then on every command of the session drives that app, as case run drives the host it starts; `fastsim stop` ends it, and so does the session ending. An app attached before (a simulator's) is replaced by it; close that app, or it dials back in. The host's log is in <bundle>/hosts/<port>.err. A bundle older than the app's code is bundled again first with the kit's bin/fastsim-bundle (in this process's environment); when that fails, the host is not started and the answer gives the command to run.",
    mcpDetails:
      "Starts a Lynkeus FastSim host on a bundle made with the kit's bin/fastsim-bundle (pass that folder as bundle) and attaches this server to it: screen, press, type, wait, screenshot and the rest then drive the app on FastSim, to explore it before writing a case. kit is the FastSim folder fastsim_install answered (default: the newest installed for the bundle's platform). fastsim_stop ends the host. A bundle older than the app's code is bundled again before the host starts (the answer says so); when that fails, nothing starts and the answer gives the fastsim-bundle command to run.",
    positionals: [{ name: 'bundle', help: 'the folder fastsim-bundle made', required: true }],
    flags: {
      kit: { type: 'string', help: "the Lynkeus FastSim folder (default: the newest installed for the bundle's platform)", value: 'dir' },
      timeout: { type: 'number', help: 'how long to wait for the app to attach', default: 60000, value: 'ms' },
    },
    needs: 'nothing',
    session: true,
    mcp: 'core',
    run: async (ctx) => {
      if (!ctx.attached)
        return {
          text: 'fastsim start keeps its host for a session (lynkeus session) or an MCP server; from a shell, start <kit>/bin/fastsim-run <bundle> <port> yourself',
          code: 2,
        };
      const bundle = path.resolve(ctx.root, ctx.args[0]!);
      let args: string;
      try {
        args = fs.readFileSync(path.join(bundle, 'host.args'), 'utf8');
      } catch {
        return { text: `${bundle} has no host.args: make it with the kit's bin/fastsim-bundle <app> ${bundle} <ios|android>`, code: 2 };
      }
      const platform = /--platform (\w+)/.exec(args)?.[1] ?? 'ios';
      const kit = typeof ctx.flags.kit === 'string' ? path.resolve(ctx.root, ctx.flags.kit) : installedKit(platform);
      if (!kit) return { text: `no Lynkeus FastSim for ${platform} is installed: run fastsim install --platform ${platform}`, code: 2 };
      const run = path.join(kit, 'bin', 'fastsim-run');
      if (!fs.existsSync(run)) return { text: `${kit} has no bin/fastsim-run: is it a Lynkeus FastSim folder?`, code: 2 };
      const port = portFromEnv(ctx.config) ?? 8123;
      const command = `${JSON.stringify(run)} ${JSON.stringify(bundle)} ${port}`;
      const cases = ctx.config.cases ?? {};
      const fresh = await freshBundle(command, ctx.root, { skip: [path.resolve(cases.base ?? ctx.root, cases.dir ?? 'cases')], log: ctx.err });
      if (!fresh.ok) return { text: fresh.text, code: 1 };
      const granted = await hostGrantEnv(ctx, command);
      if ('failed' in granted) return granted.failed;
      await stopExploring();
      // A device already attached answers at once: then the host's app is the next one to say hello.
      const current = ctx.device();
      current.catch(() => undefined);
      const before = await Promise.race([
        current.then(
          (d) => d,
          () => undefined,
        ),
        new Promise<undefined>((resolve) => setImmediate(() => resolve(undefined))),
      ]);
      const child = spawn(run, [bundle, String(port)], { cwd: ctx.root, env: granted.env, stdio: ['pipe', 'ignore', 'ignore'], detached: true });
      exploring = { child, bundle, port };
      const timeoutMs = Number(ctx.flags.timeout ?? 60000);
      const attached = before
        ? await nextHello(before, child, timeoutMs)
        : await current.then(
            () => true,
            () => false,
          );
      const log = path.join(bundle, 'hosts', `${port}.err`);
      if (!attached) {
        await stopExploring();
        return {
          text: `the FastSim host on port ${port} ${child.exitCode !== null ? `exited (${child.exitCode})` : 'started, and its app did not attach'}; its log: ${log}`,
          code: 1,
        };
      }
      const d = before ?? (await current);
      const offered = d.server.hello?.commands ?? [];
      const notes = [
        fresh.note,
        offered.includes('screenshot')
          ? undefined
          : "⚠ this bundle's app offers no screenshot, film or clock: bundle it again with a current fastsim-bundle and lynkeus-agent 0.7.6 or newer",
      ].filter((note): note is string => !!note);
      return {
        text: [`FastSim host on port ${port} runs ${bundle} (${platform}); this session drives it now. Its log: ${log}`, ...notes].join('\n'),
        json: { bundle, kit, port, platform, commands: offered },
      };
    },
  }),
  define({
    name: 'fastsim stop',
    group: 'runs',
    summary: 'Stop the Lynkeus FastSim host fastsim start started for this session',
    needs: 'nothing',
    session: true,
    mcp: 'core',
    run: async () => {
      const bundle = await stopExploring();
      return bundle ? { text: `stopped the FastSim host on ${bundle}` } : { text: 'no FastSim host started by fastsim start is running' };
    },
  }),
];

export const fastsimCommands = makeFastsimCommands();

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { define } from '../registry.js';
import { serviceBase } from './report.js';

export type FastsimRelease = { version: string; variant: string; sha256: string; bytes: number };

const RELEASE_PART = /^[a-z0-9.-]{1,32}$/;

export const fastsimCacheDir = (): string =>
  process.env.LYNKEUS_FASTSIM_DIR ?? path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), 'lynkeus', 'fastsim');

const failure = async (response: Response, what: string): Promise<string> => {
  const body = (await response.json().catch(() => undefined)) as { error?: unknown } | undefined;
  const reason = typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`;
  if (response.status === 401)
    return `${what}: the key was refused (${reason}); LYNKEUS_CLOUD_KEY is an API key an owner of your organization made with "May download fastsim" on lynkeus.io`;
  return `${what}: ${reason}`;
};

// iOS matches the simulator only on a Mac; Linux draws it with the Inter stand-in. Windows runs the Linux build in WSL2.
export const fastsimVariant = (platform: string, os: NodeJS.Platform = process.platform, arch: string = process.arch): string => {
  if (platform !== 'ios' && platform !== 'android') throw new Error(`the platform is ios or android, not ${platform}`);
  if (os === 'win32') throw new Error('fastsim runs on Windows inside WSL2: run lynkeus there, where it installs the Linux build');
  if (os === 'darwin') {
    if (arch !== 'arm64') throw new Error('fastsim runs on Apple Silicon Macs only');
    return `darwin-arm64-${platform}`;
  }
  if (os === 'linux' && (arch === 'x64' || arch === 'arm64')) return `linux-${arch}-${platform}`;
  throw new Error(`fastsim has no build for ${os} on ${arch}`);
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
  fetchImpl?: typeof fetch;
};

export type InstallResult = { release: FastsimRelease; dir: string; installed: boolean };

export const installFastsim = async (o: InstallOptions): Promise<InstallResult> => {
  const fetchImpl = o.fetchImpl ?? fetch;
  const base = serviceBase(o.cloud);
  const auth = { authorization: `Bearer ${o.key}` };
  // A redirect could carry the key to another host.
  const listed = await fetchImpl(`${base}/v1/fastsim/releases`, { headers: auth, redirect: 'manual' });
  if (!listed.ok) throw new Error(await failure(listed, 'cannot list fastsim releases'));
  const { releases } = (await listed.json()) as { releases: FastsimRelease[] };
  const release = pickRelease(newestFirst(releases ?? []), o.version, o.variant);
  if (!release) {
    const offered = [...new Set((releases ?? []).map((r) => `${r.version} ${r.variant}`))].join(', ') || 'none';
    throw new Error(`no fastsim release ${o.version} for ${o.variant}; this organization can install: ${offered}`);
  }
  if (!RELEASE_PART.test(release.version) || !RELEASE_PART.test(release.variant) || !/^[0-9a-f]{64}$/.test(release.sha256))
    throw new Error('the service answered a release that is not well formed');

  const target = path.join(o.dir, release.version, release.variant);
  const marker = path.join(target, '.sha256');
  if (!o.force && fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() === release.sha256) return { release, dir: target, installed: false };

  const download = await fetchImpl(`${base}/v1/fastsim/releases/${release.version}/${release.variant}`, { headers: auth, redirect: 'manual' });
  if (!download.ok) throw new Error(await failure(download, `cannot download fastsim ${release.version}`));
  const archive = Buffer.from(await download.arrayBuffer());
  const digest = crypto.createHash('sha256').update(archive).digest('hex');
  if (digest !== release.sha256) throw new Error(`fastsim ${release.version} arrived damaged: its digest is ${digest}, the release says ${release.sha256}`);

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const staging = fs.mkdtempSync(path.join(path.dirname(target), `.${release.variant}-`));
  try {
    const file = path.join(staging, 'archive.tar.gz');
    fs.writeFileSync(file, archive);
    const unpacked = path.join(staging, 'unpacked');
    fs.mkdirSync(unpacked);
    // bsdtar and GNU tar both refuse absolute paths and `..` unless told otherwise.
    const tar = spawnSync('tar', ['-xzf', file, '-C', unpacked, '--no-same-owner'], { encoding: 'utf8' });
    if (tar.status !== 0) throw new Error(`cannot unpack fastsim ${release.version}: ${(tar.stderr || tar.error?.message || '').trim()}`);
    fs.writeFileSync(path.join(unpacked, '.sha256'), `${release.sha256}\n`);
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(unpacked, target);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return { release, dir: target, installed: true };
};

export const fastsimCommands = [
  define({
    name: 'fastsim install',
    group: 'runs',
    summary: "Download fastsim for this machine and a platform from lynkeus.io with the organization's key",
    details:
      "Asks lynkeus.io which fastsim releases the organization may install (LYNKEUS_CLOUD_KEY: an API key an owner of the organization made with “May download fastsim”; other keys are refused), downloads the build for this machine and --platform (ios unless told: darwin-arm64-ios on an Apple Silicon Mac, linux-x64-android on Linux, and so on; on Windows run it inside WSL2), checks its SHA-256 and unpacks it into ~/.cache/lynkeus/fastsim/<version>/<variant> (LYNKEUS_FASTSIM_DIR moves it). Install each platform you test on its own: a Mac's iOS build is about 8 MB, its Android build about 65 MB. iOS matches the simulator only on a Mac; on Linux it is close but drawn with another font. An installed release with the same digest is kept. The package's README says how to bundle the app (bin/fastsim-bundle) and run cases on it (bin/fastsim-run with case run --host-command). Exit code 2 without a key, 1 when the organization has no fastsim entitlement, the machine has no build, or the download fails.",
    mcpDetails:
      "Downloads fastsim (the fast simulator, for organizations whose plan includes it) for this machine and the platform asked for, and answers where it went. Needs LYNKEUS_CLOUD_KEY in this server's environment: an API key an owner of the organization made with “May download fastsim” (other keys are refused with that message). Then read the README.md in that folder: it says how to bundle the app and run case_run with host_command on it.",
    flags: {
      version: { type: 'string', help: 'release to install', default: 'latest', value: 'version' },
      platform: { type: 'string', help: 'the platform it draws: ios or android', default: 'ios', value: 'ios|android' },
      variant: { type: 'string', help: "a build by name instead of this machine's (darwin-arm64-ios, linux-x64-android)", value: 'name' },
      cloud: { type: 'string', help: 'service URL (default LYNKEUS_REPORTS_URL or https://lynkeus.io)', value: 'url' },
      force: { type: 'boolean', help: 'download again even when that release is installed' },
    },
    needs: 'nothing',
    session: false,
    mcp: 'core',
    run: async (ctx) => {
      const key = process.env.LYNKEUS_CLOUD_KEY ?? process.env.LYNKEUS_REPORTS_KEY;
      if (!key)
        return {
          text: 'set LYNKEUS_CLOUD_KEY to an API key an owner of your organization made with "May download fastsim" on lynkeus.io (in mise.local.toml or your CI secrets)',
          code: 2,
        };
      const cloud = typeof ctx.flags.cloud === 'string' ? ctx.flags.cloud : (process.env.LYNKEUS_REPORTS_URL ?? 'https://lynkeus.io');
      try {
        const variant = typeof ctx.flags.variant === 'string' ? ctx.flags.variant : fastsimVariant(String(ctx.flags.platform));
        const { release, dir, installed } = await installFastsim({
          cloud,
          key,
          version: String(ctx.flags.version),
          variant,
          dir: fastsimCacheDir(),
          force: ctx.flags.force === true,
        });
        const readme = path.join(dir, 'README.md');
        const how = fs.existsSync(readme) ? `; how to run it: ${readme}` : '';
        return {
          text: `${installed ? 'installed' : 'already installed:'} fastsim ${release.version} (${release.variant}) in ${dir}${how}`,
          json: { ...release, dir, installed },
        };
      } catch (error) {
        return { text: (error as Error).message, code: 1 };
      }
    },
  }),
];

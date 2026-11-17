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
  if (response.status === 401) return `${what}: the key was refused (${reason}); LYNKEUS_CLOUD_KEY is your organization's API key from lynkeus.io`;
  return `${what}: ${reason}`;
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
    summary: "Download fastsim for this Mac from lynkeus.io with the organization's key",
    details:
      "Asks lynkeus.io which fastsim releases the organization may install (LYNKEUS_CLOUD_KEY, the organization's API key), downloads the one asked for (`latest` unless --version), checks its SHA-256 and unpacks it into ~/.cache/lynkeus/fastsim/<version>/<variant> (LYNKEUS_FASTSIM_DIR moves it). An installed release with the same digest is kept. The package's README says how to start a host. Exit code 2 without a key, 1 when the organization has no fastsim entitlement or the download fails.",
    flags: {
      version: { type: 'string', help: 'release to install', default: 'latest', value: 'version' },
      variant: { type: 'string', help: 'build to install', default: 'darwin-arm64', value: 'name' },
      cloud: { type: 'string', help: 'service URL (default LYNKEUS_REPORTS_URL or https://lynkeus.io)', value: 'url' },
      force: { type: 'boolean', help: 'download again even when that release is installed' },
    },
    needs: 'nothing',
    session: false,
    mcp: false,
    run: async (ctx) => {
      const key = process.env.LYNKEUS_CLOUD_KEY ?? process.env.LYNKEUS_REPORTS_KEY;
      if (!key) return { text: "set LYNKEUS_CLOUD_KEY to your organization's API key from lynkeus.io (in mise.local.toml or your CI secrets)", code: 2 };
      const cloud = typeof ctx.flags.cloud === 'string' ? ctx.flags.cloud : (process.env.LYNKEUS_REPORTS_URL ?? 'https://lynkeus.io');
      try {
        const { release, dir, installed } = await installFastsim({
          cloud,
          key,
          version: String(ctx.flags.version),
          variant: String(ctx.flags.variant),
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

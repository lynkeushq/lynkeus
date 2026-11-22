import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { readToken, tokenFile } from '../config.js';
import { findFlutter, flutterProject } from './flutterHost.js';
import type { SetupCheck } from './init.js';

const read = (file: string): string | undefined => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
};

/** The SDK's own record of its version, so `status` does not run `flutter` (which can update itself or hit the network). */
const flutterVersion = (sdkRoot: string): string | undefined => {
  const json = read(path.join(sdkRoot, 'bin', 'cache', 'flutter.version.json'));
  if (json) {
    try {
      const version = (JSON.parse(json) as { frameworkVersion?: string }).frameworkVersion;
      if (version) return version;
    } catch {}
  }
  return read(path.join(sdkRoot, 'version'))?.trim() || undefined;
};

/** Git's own answer when the project is in a repository; otherwise what `.lynkeus/.gitignore` says. */
const tokenIgnored = (root: string): boolean => {
  const ran = spawnSync('git', ['check-ignore', '-q', tokenFile(root)], { cwd: root });
  if (ran.status === 0) return true;
  if (ran.status === 1) return false;
  return (read(path.join(root, '.lynkeus', '.gitignore')) ?? '').split(/\r?\n/).includes('token');
};

/** What a Flutter project has of Lynkeus and what it lacks, each with the one thing that fixes it. Reads files only. */
export const flutterChecks = (root: string): SetupCheck[] => {
  const project = flutterProject(root);
  const pubspec = read(path.join(root, 'pubspec.yaml')) ?? '';
  const main = read(path.join(root, 'lib', 'main.dart'));
  const checks: SetupCheck[] = [];
  checks.push({
    what: `${project?.name ?? 'the app'}'s pubspec.yaml depends on lynkeus_agent`,
    ok: /^[ \t]+lynkeus_agent:/m.test(pubspec),
    fix: '`lynkeus init` adds it',
  });
  checks.push({
    what: 'lib/main.dart starts the agent',
    ok: !!main && /LynkeusAgent\.start\(/.test(main),
    fix:
      main === undefined
        ? 'there is no lib/main.dart: call `LynkeusAgent.start();` before runApp in the app’s main()'
        : '`lynkeus init` adds `LynkeusAgent.start();` before runApp',
  });
  const token = readToken(root);
  checks.push({ what: 'the project has a token', ok: !!token, fix: '`lynkeus init` makes one in .lynkeus/token' });
  if (fs.existsSync(tokenFile(root)))
    checks.push({ what: '.lynkeus/token is kept out of git', ok: tokenIgnored(root), fix: 'add `token` to .lynkeus/.gitignore' });
  const sdk = findFlutter(root);
  const version = sdk && flutterVersion(sdk.root);
  checks.push({
    what: sdk ? `Flutter is found (${version ?? 'version unknown'}, ${sdk.root})` : 'Flutter is found',
    ok: !!sdk,
    fix: 'put flutter on PATH or set FLUTTER_ROOT',
  });
  return checks;
};

/** The headless host of a Flutter app: optional, so a project without it is still ready for a device. */
export const flutterHeadlessCheck = (root: string): SetupCheck => {
  const hosted = !!flutterProject(root)?.hosted;
  return {
    what: hosted ? 'the app can run headless (lynkeus_headless, under flutter test)' : 'the app can run headless, under flutter test with no simulator',
    ok: hosted,
    fix: 'add lynkeus_headless to dev_dependencies in pubspec.yaml (`flutter pub add --dev lynkeus_headless`); optional',
  };
};

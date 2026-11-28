import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { AgentError, type PortApp } from 'lynkeus-client';
import type { HelloEvent } from 'lynkeus-protocol';

import { nativeValuesEnv } from '../cases/nativeValues.js';
import { configFile, DEFAULT_PORT, type LynkeusConfig, lynkeusDir, portFromEnv, readToken } from '../config.js';
import { readJson, writeJson } from '../files.js';
import { prepareDevMenu } from '../device/devMenu.js';
import { describeHolder, portHolder } from '../device/portHolder.js';
import { type DeviceInfo, reverseAndroid } from '../device/devices.js';
import { describeExplanations, explainError } from '../knowledge/errors.js';
import { type Ctx, define } from '../registry.js';
import { laneLabel } from '../runtime.js';
import { doctor } from './doctor.js';
import { runtimeAt } from '../runtimes/index.js';
import { fastsimCacheNote, installedFastsim, installedKit } from './fastsim.js';
import { runHost } from './hostProcess.js';
import { headlessMissing, init, installHeadless, jestPreset, type SetupCheck } from './init.js';
import { appPlatforms, isAppFolder, machineTargets, type Platform, proposeTargets, runTargets } from './runTargets.js';
import { declaredTargets, TARGETS } from '../cases/onTargets.js';
import { bundlePlatform, fastsimBundles } from './cases.js';
import { installSkill } from './skill.js';
import { headlessEntryOf } from './appEntry.js';
import { detectApiEnv, setupMocks, transformIgnorePattern } from './appEnv.js';

const ENTRY_FLAG = { entry: { type: 'string' as const, help: 'the headless entry (or `entry` in lynkeus.config.json)', value: 'file' } };
const entryOf = (ctx: Ctx): string => headlessEntryOf(ctx.root, ctx.config, ctx.flags.entry as string | undefined);

/** The env var the app reads its API address from: the config's `apiEnv`, else the one its source reads, else none. */
const apiEnvOf = (ctx: Ctx): string | undefined => ctx.config.apiEnv ?? detectApiEnv(ctx.root);

/** The jest test that hosts the app. The port is written in, not read from the environment there: babel would inline the first run's value into jest's transform cache. */
const hostTest = (entryImport: string, port: number | undefined, config: LynkeusConfig, appName: string, unmock: string[] = []) => {
  const live = config.live?.join('|');
  const options = [
    'navigation: entry.navigation',
    'token: process.env.LYNKEUS_TOKEN',
    `port: ${port ?? 'undefined'}`,
    'host: process.env.LYNKEUS_HOST',
    `live: ${live ? `/${live}/` : 'undefined'}`,
    `strictMode: ${config.strictMode === true}`,
    `app: { name: ${JSON.stringify(appName)}, runtime: 'headless' }`,
  ];
  // Hoisted above the imports by jest, so the entry's own mocks still come after.
  const taken = unmock.length
    ? `// What the app's jest setup mocks for its unit tests: the host runs the real code (the entry has its own mocks).\n${unmock.map((m) => `jest.unmock(${JSON.stringify(m)});`).join('\n')}\n`
    : '';
  return `// Written by \`lynkeus headless start\`; runs the app under jest as a host for the agent.
${taken}import { hostApp } from 'lynkeus-headless';
import * as entry from '${entryImport}';

hostApp(() => <entry.App />, { ${options.join(', ')} });
`;
};

const JEST_CONFIGS = ['jest.config.js', 'jest.config.cjs', 'jest.config.mjs', 'jest.config.ts', 'jest.config.json'];

const apiFromConfig = (config: LynkeusConfig, apiEnv: string | undefined): Record<string, string> => {
  if (!config.apiUrl) return {};
  if (!apiEnv)
    process.stderr.write('lynkeus: apiUrl is set but the app reads no address from the environment that lynkeus found; set apiEnv in lynkeus.config.json\n');
  return apiEnv ? { [apiEnv]: config.apiUrl } : {};
};

/**
 * A jest cache of its own for each API base. Babel inlines `process.env` into the code it transforms and jest
 * keeps that output, so a host started with another API address kept calling the first one it was started with.
 */
export const cacheFor = (root: string, env: Record<string, string | undefined>, apiEnv?: string): string => {
  const key = createHash('sha256')
    .update(apiEnv ? `${apiEnv}=${env[apiEnv] ?? ''}` : '')
    .digest('hex')
    .slice(0, 12);
  return path.join(lynkeusDir(root), 'jest-cache', key);
};

/**
 * The import aliases in tsconfig.json's `paths`, as jest mappings, the longest first: \`@/assets/*\` has to be
 * tried before \`@/*\`, which jest-expo does not do. The bundler reads them; jest knows nothing of them.
 */
const aliasesOf = (root: string): Record<string, string> => {
  let options: { baseUrl?: string; paths?: Record<string, string[]> } | undefined;
  try {
    const text = fs.readFileSync(path.join(root, 'tsconfig.json'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    options = (JSON.parse(text) as { compilerOptions?: typeof options }).compilerOptions;
  } catch {
    return {};
  }
  const base = path.join(root, options?.baseUrl ?? '.');
  const literal = (text: string) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  return Object.fromEntries(
    Object.entries(options?.paths ?? {})
      .filter(([alias, [target]]) => alias.endsWith('/*') && target?.endsWith('/*'))
      .sort(([a], [b]) => b.length - a.length)
      .map(([alias, [target]]) => [`^${literal(alias.slice(0, -1))}(.*)$`, `${path.join(base, target!.slice(0, -1))}$1`]),
  );
};

/**
 * What jest is told when the app has not said it itself, so an app with no jest set up runs headless as it is:
 * the preset its framework needs (jest-expo for Expo, React Native's otherwise), and which packages under node_modules to transpile.
 */
/** The app's react folder, when lynkeus-headless would load another copy; undefined when they are one. */
export const duplicateReact = (root: string): string | undefined => {
  const require = createRequire(import.meta.url);
  try {
    // Its exports leave out package.json: from its entry up to the folder that holds one.
    let headless = path.dirname(fs.realpathSync(require.resolve('lynkeus-headless', { paths: [root] })));
    while (!fs.existsSync(path.join(headless, 'package.json')) && path.dirname(headless) !== headless) headless = path.dirname(headless);
    const ours = path.dirname(require.resolve('react/package.json', { paths: [root] }));
    const theirs = path.dirname(require.resolve('react/package.json', { paths: [headless] }));
    return fs.realpathSync(ours) === fs.realpathSync(theirs) ? undefined : ours;
  } catch {
    return undefined;
  }
};

/**
 * An Expo app's config (app.json, app.config.*) as a device build embeds it, for expo-constants: without it
 * \`Linking.createURL\` throws for want of the app's scheme. Read with the app's own @expo/config, outside jest.
 */
export const expoConfigJson = (root: string): string | undefined => {
  try {
    const fromApp = createRequire(path.join(root, 'package.json'));
    const fromExpo = createRequire(fromApp.resolve('expo/package.json'));
    const { getConfig } = fromExpo('@expo/config') as { getConfig: (root: string, options: object) => { exp: unknown } };
    return JSON.stringify(getConfig(root, { skipSDKVersionRequirement: true, isPublicConfig: true }).exp);
  } catch {
    return undefined;
  }
};

/** The app's own jest configuration as text, from its config file or package.json; empty when it has none. */
const jestConfigText = (root: string): string => {
  const file = JEST_CONFIGS.find((f) => fs.existsSync(path.join(root, f)));
  if (file) return fs.readFileSync(path.join(root, file), 'utf8');
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { jest?: unknown };
    return manifest.jest ? JSON.stringify(manifest.jest) : '';
  } catch {
    return '';
  }
};

const jestDefaults = (root: string): string[] => {
  const config = jestConfigText(root);
  const flags: string[] = [];
  const react = duplicateReact(root);
  // lynkeus-headless with a React of its own (a linked package, a workspace, pnpm) breaks every hook: the app and
  // the renderer must share the app's copy.
  const sameReact = react ? { '^react$': react, '^react/(.*)$': `${react}/$1` } : {};
  if (!config) {
    // A style sheet imported from native code (Expo's templates import global.css) means nothing to jest, even
    // behind an alias, so it is mapped first. Jest merges these with the preset's own mappings.
    const stub = path.join(lynkeusDir(root), 'style-stub.js');
    fs.mkdirSync(path.dirname(stub), { recursive: true });
    fs.writeFileSync(stub, 'module.exports = {};\n');
    flags.push('--preset', jestPreset(root), `--moduleNameMapper=${JSON.stringify({ '\\.(css|less|sass|scss)$': stub, ...aliasesOf(root), ...sameReact })}`);
  } else if (react) {
    if (config.includes('moduleNameMapper'))
      process.stderr.write(
        `lynkeus: lynkeus-headless finds another copy of react than the app's; add to moduleNameMapper in the app's jest config: '^react$': '${react}', '^react/(.*)$': '${react}/$1'\n`,
      );
    else flags.push(`--moduleNameMapper=${JSON.stringify(sameReact)}`);
  }
  // Two that must stay as they are, as jest-expo leaves them: babel running itself, or Reanimated's plugin, fails.
  if (!config.includes('transformIgnorePatterns'))
    flags.push(
      `--transformIgnorePatterns=${transformIgnorePattern(root)}`,
      '--transformIgnorePatterns=/node_modules/react-native-reanimated/plugin/',
      '--transformIgnorePatterns=/node_modules/@react-native/babel-preset/',
    );
  return flags;
};

/** The status line for the app on the driver's port, from its latest hello; none is an app that was attached and left. */
export const attachedCheck = (hello: HelloEvent | null, attachFix: string): { what: string; ok: boolean; fix?: string } => {
  if (!hello) return { what: 'an app is attached', ok: false, fix: `the app that was attached is gone (crashed or closed): start it again; ${attachFix}` };
  const name = hello.app?.runtime === 'headless' ? 'headless host' : String(hello.app?.name ?? hello.platform);
  return { what: `an app is attached (${name === hello.platform ? name : `${name}, ${hello.platform}`})`, ok: true };
};

/**
 * The status line when several apps dial the driver's port (an iOS Simulator's and an emulator's development build):
 * each with its lane and device, which one this session drives, and how to drive the other. Undefined for one app.
 */
export const portAppsCheck = (apps: PortApp[], port: number, devices: DeviceInfo[] = []): { what: string; ok: boolean } | undefined => {
  if (apps.length < 2) return undefined;
  const onDevice = (a: PortApp) => {
    const own = devices.filter((d) => d.platform === a.hello.platform && a.hello.native && !a.hello.commands?.includes('clock'));
    return own.length === 1 ? own[0] : undefined;
  };
  const role = { this: 'driven by this session', other: 'driven by a run', none: 'turned away while the other is attached' };
  const listed = apps.map((a) => {
    const device = onDevice(a);
    const lane = laneLabel(a.hello, device?.type) ?? a.hello.platform;
    return `${String(a.hello.app?.name ?? a.hello.appId ?? a.hello.platform)} on ${lane}${device ? ` (${device.name})` : ''}: ${role[a.driven]}`;
  });
  const driven = apps.find((a) => a.driven === 'this');
  const others = [...new Set(apps.filter((a) => a !== driven).map((a) => a.hello.platform))];
  const switchTo = `case run and why take --on ${others.join('|') || 'ios|android'} (on, over MCP); screen, press and the other tools drive ${driven ? `the ${driven.hello.platform} app` : 'the first app that attaches'} until it closes: close it (xcrun simctl terminate booted <app id>, adb shell am force-stop <app id>) and the other attaches within 2 s`;
  return { what: `${apps.length} apps dial port ${port}: ${listed.join('; ')}. To drive another: ${switchTo}`, ok: true };
};

/**
 * The status line when connecting to the app failed. A port another process holds names that process (`holder`,
 * from `describeHolder`) when it can be told, else says so as `screen` does; an app refused for another token says that.
 */
export const attachFailureCheck = (error: unknown, port: number, attachFix: string, holder?: string): { what: string; ok: boolean; fix?: string } => {
  if (error instanceof AgentError && error.code === 'port-in-use') return { what: holder ?? error.message, ok: false };
  if (error instanceof AgentError && error.code === 'wrong-token')
    return {
      what: `an app is attached (port ${port}): one dialed in with another project's token and was refused`,
      ok: false,
      fix: "open this project's development build (the app's token comes from this project's .lynkeus/token through Metro: restart it with --reset-cache)",
    };
  return { what: `an app is attached (Lynkeus listens on port ${port})`, ok: false, fix: attachFix };
};

/**
 * The host file is named so that no default \`testMatch\` takes it (no __tests__, no .test.): the app's own \`jest\` run
 * must not start a host. The flag matches every host file, as \`testRegex\` when the app's config uses that (jest
 * refuses both), and the run picks its own by path: the pattern is part of the config jest hashes into every
 * transform's cache key, and one naming the port threw the whole cache away each time a run got another free port.
 */
export const hostTestFlag = (root: string): string =>
  /\btestRegex\b/.test(jestConfigText(root)) ? '--testRegex=/\\.lynkeus/host/[^/]+\\.host\\.tsx$' : '--testMatch=**/.lynkeus/host/*.host.tsx';

/** jest's own bin in the app, run by this node; \`npx jest\` spends a few hundred ms finding it on every start. */
export const jestCommand = (root: string): { command: string; args: string[] } => {
  try {
    const manifestFile = createRequire(path.join(root, 'package.json')).resolve('jest/package.json');
    const { bin } = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as { bin?: string | Record<string, string> };
    const file = typeof bin === 'string' ? bin : bin?.jest;
    if (file && fs.existsSync(path.join(path.dirname(manifestFile), file)))
      return { command: process.execPath, args: [path.join(path.dirname(manifestFile), file)] };
  } catch {
    // not resolvable from the app: npx finds it, or says it is missing
  }
  return { command: 'npx', args: ['jest'] };
};

/** Where `headless start` used to write the host, which the app's own jest run picked up. */
const removeOldHostTests = (root: string): void => {
  const old = path.join(lynkeusDir(root), '__tests__');
  try {
    for (const name of fs.readdirSync(old)) if (/^headless(-\d+)?\.test\.tsx$/.test(name)) fs.rmSync(path.join(old, name), { force: true });
    if (fs.readdirSync(old).length === 0) fs.rmdirSync(old);
  } catch {
    // nothing there
  }
};

/** The platforms an installed Lynkeus FastSim draws here. */
const fastsimKits = (): Platform[] => (['ios', 'android'] as const).filter((p) => installedKit(p) !== undefined);

/**
 * Proposes `cases.targets` when lynkeus.config.json declares none: a project without them leaves an agent to guess
 * where a case must pass, which ends in running everything everywhere. Where a case must pass is the person's call,
 * so it is written only when `write` says so: `proposed`, or the targets themselves (`headless,ios`).
 */
export const proposeCasesTargets = (root: string, config: LynkeusConfig, kits: Platform[] = fastsimKits(), write?: string): string | undefined => {
  if (config.cases?.targets !== undefined && write === undefined) return undefined;
  // Not an app's folder: init says so itself, and a config written here would belong to nothing.
  if (!isAppFolder(root)) return undefined;
  const file = configFile(root);
  let current: Record<string, unknown> = {};
  try {
    current = fs.existsSync(file) ? readJson<Record<string, unknown>>(file) : {};
  } catch {
    return `cases.targets: not written, ${path.basename(file)} is not JSON Lynkeus can read; add "cases": { "targets": [...] } yourself`;
  }
  const proposed = proposeTargets({ fastsim: kits, platforms: appPlatforms(root) });
  const from = `${kits.length ? 'the FastSim installed here' : 'this machine (no FastSim installed)'} and the app's platforms`;
  if (write === undefined)
    return `cases.targets: none declared; proposed ${JSON.stringify(proposed)} (from ${from}). Where a case must pass is the person's call: ask them, then write it (\`lynkeus init --targets proposed\`, or --targets headless,ios)`;
  const named =
    write === 'proposed'
      ? proposed
      : write
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean);
  const unknown = named.filter((t) => !(TARGETS as readonly string[]).includes(t));
  if (unknown.length || named.length === 0) return `cases.targets: not written, ${unknown.join(', ') || 'none'} is not a target (${TARGETS.join(', ')})`;
  const cases = current.cases && typeof current.cases === 'object' ? (current.cases as Record<string, unknown>) : {};
  writeJson(file, { ...current, cases: { ...cases, targets: named } });
  return `wrote "cases": { "targets": ${JSON.stringify(named)} } to ${path.basename(file)}: where a case must pass (\`case run --on targets\` checks them; \`lynkeus ci\` runs the headless and FastSim ones)${write === 'proposed' ? `, as proposed from ${from}` : ''}`;
};

export const headlessCommands = [
  define({
    name: 'init',
    group: 'drive',
    summary: "Set Lynkeus up in this app: install the agent, mount it from the app's entry, make the project's token",
    details:
      'React Native or Expo (an Expo Router app gets an entry of its own). Safe to run again: it changes only what is missing. The agent has native code, so the app is built again afterwards (`npx react-native run-ios`, `npx expo run:ios`) and Metro restarted with `--reset-cache`; `lynkeus status` says what is left. It also installs the Lynkeus skill in .claude/skills/lynkeus, or updates one nobody changed.',
    flags: {
      'no-install': { type: 'boolean', help: 'do not add lynkeus-agent to the app; mount it only' },
      'no-skill': { type: 'boolean', help: 'leave the Lynkeus skill and its Claude Code subagents out (also LYNKEUS_NO_SKILL=1)' },
      targets: {
        type: 'string',
        help: 'write cases.targets, once the person said where cases must pass: the proposed ones, or a list (headless,ios)',
        value: 'proposed|list',
      },
    },
    needs: 'nothing',
    mcp: 'core',
    run: async (ctx) => {
      const runtime = await runtimeAt(ctx.root);
      const lines = runtime.init(ctx.root, { install: !ctx.flags['no-install'], headless: !!ctx.flags.headless });
      const targets = proposeCasesTargets(ctx.root, ctx.config, undefined, typeof ctx.flags.targets === 'string' ? ctx.flags.targets : undefined);
      if (targets) lines.push(targets);
      // The environment form lets a team, or a measured comparison, turn it off for every init an agent runs.
      if (!ctx.flags['no-skill'] && process.env.LYNKEUS_NO_SKILL !== '1') lines.push(installSkill(ctx.root).text);
      return { text: lines.join('\n'), json: lines };
    },
  }),
  define({
    name: 'status',
    group: 'drive',
    summary: 'What this project has of Lynkeus and what is missing: the agent, the token, a running app, cases, the reports key',
    details: 'The first thing to call in a project you do not know: each line that fails says what fixes it. `--offline` skips waiting for the app.',
    flags: { offline: { type: 'boolean', help: 'check the files only; do not wait for a running app' } },
    needs: 'nothing',
    mcp: 'core',
    run: async (ctx) => {
      const runtime = await runtimeAt(ctx.root);
      const checks = runtime.setupChecks(ctx.root);
      const ready = checks.every((c) => c.ok);
      const port = portFromEnv(ctx.config) ?? DEFAULT_PORT;
      const offline = !!ctx.flags.offline;
      // Asked while the app is waited for: the simulators, emulators and phones this machine has up.
      const machine = offline ? undefined : machineTargets();
      let attached: string | undefined;
      if (ready && !offline) {
        try {
          const device = await ctx.device();
          // Over MCP the connection outlives the app: it is asked again, and named from its latest hello, since
          // another app (another platform) may have taken the port since.
          const waited: HelloEvent | null | Error = device.server.connected
            ? device.server.hello
            : await device.server.waitForApp(3000).catch((error: unknown) => (error instanceof Error ? error : null));
          if (waited instanceof AgentError && waited.code === 'wrong-token') throw waited;
          const hello = waited instanceof Error ? null : waited;
          const check = attachedCheck(hello, runtime.attachFix);
          if (check.ok) {
            attached = String(hello?.app?.name ?? hello?.platform);
            check.what = check.what.replace(/\)$/, `, port ${port})`);
          }
          const up = machine ? await machine : undefined;
          const devices = up ? [...up.simulators, ...up.android] : [];
          let apps = device.server.apps?.() ?? [];
          // A second device's app turned away dials again within 1.5 s: a fresh process waits that long to see it.
          for (const until = Date.now() + 1600; check.ok && !ctx.attached && apps.length < devices.length && Date.now() < until; ) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            apps = device.server.apps?.() ?? [];
          }
          checks.push((check.ok ? portAppsCheck(apps, port, devices) : undefined) ?? check);
        } catch (error) {
          const taken = error instanceof AgentError && error.code === 'port-in-use';
          checks.push(attachFailureCheck(error, port, runtime.attachFix, taken ? describeHolder(port, await portHolder(port), ctx.root) : undefined));
        }
      }
      const dir = path.resolve(ctx.config.cases?.base ?? ctx.root, ctx.config.cases?.dir ?? 'cases');
      const cases = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md') && !/^(README|FORMAT|CATALOG)\.md$/i.test(f)).length : 0;
      checks.push({
        what: cases ? `${cases} case${cases === 1 ? '' : 's'} in ${path.relative(ctx.root, dir) || '.'}` : 'cases to run',
        ok: cases > 0,
        fix: '`lynkeus case init` writes an example and the format',
      });
      checks.push({
        what: 'runs can be pushed to the reports service',
        ok: !!process.env.LYNKEUS_REPORTS_KEY,
        optional: true,
        fix: 'set LYNKEUS_REPORTS_KEY to an API key of your organization (lynkeus.io, API keys); optional',
      });
      const found = machine ? await machine : undefined;
      const reversed = found ? await reverseAndroid(port, found.android) : [];
      const devMenu = found ? await prepareDevMenu(ctx.root, ctx.config.app, [...found.simulators, ...found.android]) : [];
      const where = runTargets({
        attached,
        port,
        simulators: found?.simulators,
        android: found?.android.map((d) => ({ ...d, reversed: reversed.includes(d.id) })),
        headless: runtime.headlessCheck(ctx.root, entryOf(ctx)),
        fastsim: installedFastsim(),
        fastsimCache: fastsimCacheNote(),
        ...(isAppFolder(ctx.root)
          ? {
              targets: {
                declared: declaredTargets({}, ctx.config.cases?.targets),
                platforms: appPlatforms(ctx.root),
                kits: fastsimKits(),
                bundles: fastsimBundles(ctx.root).flatMap((b) => bundlePlatform(b) ?? []),
              },
            }
          : {}),
      });
      const all = [...checks, ...where.checks, ...where.declared];
      const mark = (c: SetupCheck) => (c.ok ? '✓' : c.optional ? '○' : '✗');
      const line = (c: SetupCheck) => `${mark(c)} ${c.what}${c.ok || !c.fix ? '' : ` — ${c.fix}`}`;
      const text = [
        ...checks.map(line),
        '',
        'Where cases can run on this machine:',
        ...where.checks.map(line),
        ...devMenu.map((l) => `  ${l}`),
        ...(where.declared.length ? ['', 'Where a case must pass for this project (cases.targets):', ...where.declared.map(line)] : []),
        `→ ${where.advice}`,
      ].join('\n');
      return { text, json: [...all, { what: where.advice, ok: true, group: 'advice' }] };
    },
  }),
  define({
    name: 'headless start',
    group: 'headless',
    summary: 'Host the app in Node (jest + RNTL) and wait for a driver; same protocol, no simulator',
    details:
      "Needs the project's token: the one `lynkeus init` wrote to .lynkeus/token, or LYNKEUS_TOKEN in the environment. The app's API base comes from the environment variable `apiEnv` names, or else from `apiUrl` in lynkeus.config.json. LYNKEUS_PORT moves the host and its driver together; LYNKEUS_HOST says where the driver is listening, for a host that is not in the same place as its driver (a container dialling out, say). Arguments after `--` go to jest. When the host crashes, the last lines say what the error usually means.",
    flags: ENTRY_FLAG,
    aliases: ['headless'],
    needs: 'nothing',
    session: false,
    mcp: false,
    run: async (ctx) => {
      const token = readToken(ctx.root);
      if (!token)
        return {
          text: 'lynkeus headless needs a token (`lynkeus init` makes one in .lynkeus/token, or set LYNKEUS_TOKEN): a hosted app talks to a real backend, and without one any local process could drive it.',
          code: 1,
        };
      const runtime = await runtimeAt(ctx.root);
      if (runtime.startHeadless) return runtime.startHeadless(ctx, token);
      const missing = headlessMissing(ctx.root);
      if (missing.length)
        return { text: `lynkeus headless runs the app under jest and needs ${missing.join(', ')}; \`lynkeus headless init\` installs them.`, code: 1 };
      const entry = entryOf(ctx);
      if (!fs.existsSync(path.join(ctx.root, entry)))
        return { text: `No ${entry} in ${ctx.root}. \`lynkeus headless init\` writes one; it must export \`App\` and, optionally, \`navigation\`.`, code: 1 };
      const testDir = path.join(lynkeusDir(ctx.root), 'host');
      const port = portFromEnv(ctx.config);
      // One file per port: two hosts of the same app must not read each other's.
      const testFile = path.join(testDir, port ? `headless-${port}.host.tsx` : 'headless.host.tsx');
      removeOldHostTests(ctx.root);
      const rel = path
        .relative(testDir, path.join(ctx.root, entry))
        .replace(/\\/g, '/')
        .replace(/\.tsx?$/, '');
      fs.mkdirSync(testDir, { recursive: true });
      const unmock = setupMocks(ctx.root, jestConfigText(ctx.root));
      if (unmock.length)
        process.stderr.write(
          `lynkeus: the host takes back what the app's jest setup mocks for unit tests (${unmock.map((m) => (path.isAbsolute(m) ? path.relative(ctx.root, m) : m)).join(', ')}); mocks the app needs hosted go in ${entry}\n`,
        );
      fs.writeFileSync(testFile, hostTest(rel.startsWith('.') ? rel : `./${rel}`, port, ctx.config, path.basename(ctx.root), unmock));
      // Node resolves `localhost` to ::1 first; local backends usually listen on IPv4 only.
      const nodeOptions = [process.env.NODE_OPTIONS, '--dns-result-order=ipv4first'].filter(Boolean).join(' ');
      // LYNKEUS_HEADLESS tells the app's jest setup a host is starting, not its unit tests: a setup that stubs a native
      // SDK whole can leave it real there, so the call reaches the stand-in `nativeMocks` shows.
      // The config's native constants reach the host's environment, where the app's jest setup (installDefaultMocks) reads them before the app does.
      const nativeValues = nativeValuesEnv(ctx.config.cases?.nativeMocks);
      const apiEnv = apiEnvOf(ctx);
      const expoConfig = expoConfigJson(ctx.root);
      const env = {
        ...apiFromConfig(ctx.config, apiEnv),
        ...process.env,
        LYNKEUS_TOKEN: token,
        LYNKEUS_HEADLESS: '1',
        CI: '1',
        NODE_OPTIONS: nodeOptions,
        ...(nativeValues ? { LYNKEUS_NATIVE_VALUES: nativeValues } : {}),
        ...(expoConfig ? { LYNKEUS_EXPO_CONFIG: expoConfig } : {}),
        // Date reads the time zone from the process; the mocks read LYNKEUS_TIME_ZONE. One setting moves both.
        ...(process.env.LYNKEUS_TIME_ZONE ? { TZ: process.env.LYNKEUS_TIME_ZONE } : {}),
      };
      const cache = `--cacheDirectory=${cacheFor(ctx.root, env, apiEnv)}`;
      const jest = jestCommand(ctx.root);
      return {
        code: await runHost(
          ctx,
          jest.command,
          [
            ...jest.args,
            '--runTestsByPath',
            testFile,
            '--runInBand',
            '--watchAll=false',
            ...jestDefaults(ctx.root),
            hostTestFlag(ctx.root),
            cache,
            ...ctx.passthrough,
          ],
          env,
        ),
      };
    },
  }),
  define({
    name: 'headless init',
    group: 'headless',
    summary: "Write the headless entry: default mocks and the app's own entry",
    flags: {
      ...ENTRY_FLAG,
      component: { type: 'string', help: 'the App component file (found by itself when standard)', value: 'App.tsx' },
      'api-env': { type: 'string', help: 'the env var the app reads its API base from', value: 'NAME' },
      auto: { type: 'boolean', help: 'also mount the agent from index.js with auto()' },
      force: { type: 'boolean', help: 'overwrite an existing entry' },
      'no-install': { type: 'boolean', help: 'do not add jest, Testing Library and lynkeus-headless to the project' },
    },
    needs: 'nothing',
    mcp: 'core',
    mcpOmit: ['entry', 'auto', 'force'],
    mcpDetails:
      'Prepares the app to run in Node, no simulator: installs jest, Testing Library and lynkeus-headless, writes the entry. Then `case_run` with `host`.',
    run: async (ctx) => {
      const lines = init(ctx.root, {
        entry: entryOf(ctx),
        app: ctx.flags.component as string | undefined,
        apiEnv: (ctx.flags['api-env'] as string | undefined) ?? apiEnvOf(ctx),
        auto: !!ctx.flags.auto,
        force: !!ctx.flags.force,
        locale: { ...ctx.config.locale, language: ctx.config.language },
      });
      if (!ctx.flags['no-install']) lines.unshift(installHeadless(ctx.root));
      return { text: lines.join('\n'), json: lines };
    },
  }),
  define({
    name: 'headless doctor',
    group: 'headless',
    summary: 'What Lynkeus mocks, and which native modules still need one',
    flags: {
      ...ENTRY_FLAG,
      fix: { type: 'boolean', help: 'write stubs for the uncovered modules into the entry' },
      explain: { type: 'string', help: 'turn a jest error into its usual cause and fix', value: 'text' },
    },
    needs: 'nothing',
    mcp: 'core',
    mcpOmit: ['entry'],
    mcpDetails:
      'Which native modules the app uses that nothing mocks yet, so the headless host would fail on them; `fix` writes stubs for them into the entry. `explain` turns the first line of a jest error into its cause.',
    run: async (ctx) => {
      if (ctx.flags.explain) {
        const found = explainError(ctx.flags.explain as string);
        return {
          text: found.length ? describeExplanations(found).trim() : 'nothing in the catalog matches; paste the first line of the error, not the stack.',
          json: found,
        };
      }
      return doctor(ctx.root, entryOf(ctx), { fix: !!ctx.flags.fix }).join('\n');
    },
  }),
];

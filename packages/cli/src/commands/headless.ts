import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { type LynkeusConfig, lynkeusDir, portFromEnv, readToken } from '../config.js';
import { describeExplanations, explainError } from '../knowledge/errors.js';
import { type Ctx, define } from '../registry.js';
import { doctor } from './doctor.js';
import { headlessMissing, init, installAgent, installHeadless, jestPreset, mountAgent, setupChecks } from './init.js';

const ENTRY_FLAG = { entry: { type: 'string' as const, help: 'the headless entry (or `entry` in lynkeus.config.json)', value: 'file' } };
const entryOf = (ctx: Ctx) => (ctx.flags.entry as string | undefined) ?? ctx.config.entry ?? 'qa/headless.tsx';

/** The jest test that hosts the app. The port is written in, not read from the environment there: babel would inline the first run's value into jest's transform cache. */
const hostTest = (entryImport: string, port: number | undefined, config: LynkeusConfig, appName: string) => {
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
  return `// Written by \`lynkeus headless start\`; runs the app under jest as a host for the agent.
import { hostApp } from 'lynkeus-headless';
import * as entry from '${entryImport}';

hostApp(() => <entry.App />, { ${options.join(', ')} });
`;
};

const JEST_CONFIGS = ['jest.config.js', 'jest.config.cjs', 'jest.config.mjs', 'jest.config.ts', 'jest.config.json'];

// React Native and most of what an app adds to it ship untranspiled ES modules, which jest leaves alone unless told.
const apiFromConfig = (config: LynkeusConfig): Record<string, string> => (config.apiUrl ? { [config.apiEnv ?? 'API_URL']: config.apiUrl } : {});

const TRANSFORM_PACKAGES =
  '((jest-)?react-native[^/]*|@react-native[^/]*|@react-navigation|react-navigation|expo(nent)?|@expo(nent)?/.*|expo-.*|@unimodules|unimodules|@shopify|@gorhom|@sentry/react-native|lynkeus-[^/]+|yoga-layout|@testing-library|immer|@reduxjs/toolkit|react-redux|redux|reselect|@expo-google-fonts|native-base|standard-navigation)';

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
const jestDefaults = (root: string): string[] => {
  const file = JEST_CONFIGS.find((f) => fs.existsSync(path.join(root, f)));
  let config = file ? fs.readFileSync(path.join(root, file), 'utf8') : '';
  if (!file) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { jest?: unknown };
      config = manifest.jest ? JSON.stringify(manifest.jest) : '';
    } catch {}
  }
  const flags: string[] = [];
  if (!config) {
    // A style sheet imported from native code (Expo's templates import global.css) means nothing to jest, even
    // behind an alias, so it is mapped first. Jest merges these with the preset's own mappings.
    const stub = path.join(lynkeusDir(root), 'style-stub.js');
    fs.mkdirSync(path.dirname(stub), { recursive: true });
    fs.writeFileSync(stub, 'module.exports = {};\n');
    flags.push('--preset', jestPreset(root), `--moduleNameMapper=${JSON.stringify({ '\\.(css|less|sass|scss)$': stub, ...aliasesOf(root) })}`);
  }
  // Two that must stay as they are, as jest-expo leaves them: babel running itself, or Reanimated's plugin, fails.
  if (!config.includes('transformIgnorePatterns'))
    flags.push(
      `--transformIgnorePatterns=node_modules/(?!${TRANSFORM_PACKAGES}/)`,
      '--transformIgnorePatterns=/node_modules/react-native-reanimated/plugin/',
      '--transformIgnorePatterns=/node_modules/@react-native/babel-preset/',
    );
  return flags;
};

export const headlessCommands = [
  define({
    name: 'init',
    group: 'drive',
    summary: "Set lynkeus up in this app: install the agent, mount it from the app's entry, make the project's token",
    details:
      'React Native or Expo (an Expo Router app gets an entry of its own). Safe to run again: it changes only what is missing. The agent has native code, so the app is built again afterwards (`npx react-native run-ios`, `npx expo run:ios`) and Metro restarted with `--reset-cache`; `lynkeus status` says what is left.',
    flags: { 'no-install': { type: 'boolean', help: 'do not add lynkeus-agent to the app; mount it only' } },
    needs: 'nothing',
    mcp: 'core',
    run: async (ctx) => {
      const lines = [...(ctx.flags['no-install'] ? [] : [installAgent(ctx.root)]), ...mountAgent(ctx.root)];
      lines.push('next: build the app again and open it, then `lynkeus status` (over MCP: the status tool) to see that it attaches');
      return { text: lines.join('\n'), json: lines };
    },
  }),
  define({
    name: 'status',
    group: 'drive',
    summary: 'What this project has of lynkeus and what is missing: the agent, the token, a running app, cases, the reports key',
    details: 'The first thing to call in a project you do not know: each line that fails says what fixes it. `--offline` skips waiting for the app.',
    flags: { offline: { type: 'boolean', help: 'check the files only; do not wait for a running app' } },
    needs: 'nothing',
    mcp: 'core',
    run: async (ctx) => {
      const checks = setupChecks(ctx.root);
      const ready = checks.every((c) => c.ok);
      if (ready && !ctx.flags.offline) {
        try {
          const device = await ctx.device();
          checks.push({ what: `an app is attached (${device.info.name})`, ok: true });
        } catch {
          checks.push({
            what: 'an app is attached',
            ok: false,
            fix: 'open a development build made after `lynkeus init`, with Metro restarted (`--reset-cache`); or `lynkeus headless start` for no simulator',
          });
        }
      }
      const unloadable = headlessMissing(ctx.root);
      checks.push({
        what: unloadable.length ? 'the app can run headless, in Node with no simulator' : 'the app can run headless (jest, Testing Library, lynkeus-headless)',
        ok: !unloadable.length && fs.existsSync(path.join(ctx.root, entryOf(ctx))),
        fix: '`lynkeus headless init` installs what it needs and writes its entry; optional',
      });
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
        fix: 'set LYNKEUS_REPORTS_KEY to an API key of your organization (lynkeus.io, API keys); optional',
      });
      const text = checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.what}${c.ok || !c.fix ? '' : ` — ${c.fix}`}`).join('\n');
      return { text, json: checks };
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
      const missing = headlessMissing(ctx.root);
      if (missing.length)
        return { text: `lynkeus headless runs the app under jest and needs ${missing.join(', ')}; \`lynkeus headless init\` installs them.`, code: 1 };
      const entry = entryOf(ctx);
      if (!fs.existsSync(path.join(ctx.root, entry)))
        return { text: `No ${entry} in ${ctx.root}. \`lynkeus headless init\` writes one; it must export \`App\` and, optionally, \`navigation\`.`, code: 1 };
      const testDir = path.join(lynkeusDir(ctx.root), '__tests__');
      const port = portFromEnv(ctx.config);
      // One file per port: two hosts of the same app must not read each other's.
      const testFile = path.join(testDir, port ? `headless-${port}.test.tsx` : 'headless.test.tsx');
      const rel = path
        .relative(testDir, path.join(ctx.root, entry))
        .replace(/\\/g, '/')
        .replace(/\.tsx?$/, '');
      fs.mkdirSync(testDir, { recursive: true });
      fs.writeFileSync(testFile, hostTest(rel.startsWith('.') ? rel : `./${rel}`, port, ctx.config, path.basename(ctx.root)));
      // Node resolves `localhost` to ::1 first; local backends usually listen on IPv4 only.
      const nodeOptions = [process.env.NODE_OPTIONS, '--dns-result-order=ipv4first'].filter(Boolean).join(' ');
      const child = spawn('npx', ['jest', testFile, '--runInBand', '--watchAll=false', ...jestDefaults(ctx.root), ...ctx.passthrough], {
        cwd: ctx.root,
        stdio: ['inherit', 'inherit', 'pipe'],
        env: { ...apiFromConfig(ctx.config), ...process.env, LYNKEUS_TOKEN: token, CI: '1', NODE_OPTIONS: nodeOptions },
      });
      let tail = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        process.stderr.write(chunk);
        tail = (tail + chunk.toString()).slice(-20000);
      });
      const code = await new Promise<number>((resolve) => child.on('exit', (c) => resolve(c ?? 0)));
      if (code) {
        const found = explainError(tail);
        if (found.length) ctx.err(describeExplanations(found));
      }
      return { code };
    },
  }),
  define({
    name: 'headless init',
    group: 'headless',
    summary: 'Write the headless entry: default mocks, a local-backend guard, your App',
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
        apiEnv: (ctx.flags['api-env'] as string | undefined) ?? ctx.config.apiEnv ?? 'API_URL',
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
    summary: 'What lynkeus mocks, and which native modules still need one',
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

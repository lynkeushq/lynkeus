import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { ensureLynkeusIgnore, ensureToken, packageName, readToken } from '../config.js';
import { CLI_VERSION } from '../device/agentVersion.js';
import { exactCase, exportOf, findAppComponent } from './appEntry.js';

const APP_CANDIDATES = ['App.tsx', 'App.jsx', 'App.js', 'app/App.tsx', 'src/App.tsx', 'src/App.jsx', 'src/App.js'];
const INDEX_CANDIDATES = ['index.js', 'index.tsx', 'index.ts'];

export type InitOptions = {
  entry: string;
  app?: string;
  /** The env var the app reads its API address from, when it reads one. */
  apiEnv?: string;
  auto: boolean;
  force: boolean;
  locale?: { languageTag?: string; country?: string; language?: string };
};

const findFirst = (root: string, candidates: string[]): string | undefined => candidates.find((c) => fs.existsSync(path.join(root, c)));

/** The file that already mounts the agent: the entry, or the App component of an app that renders `<Lynkeus>` itself. */
const mountedIn = (root: string): string | undefined =>
  [...INDEX_CANDIDATES, ...APP_CANDIDATES].find((file) => {
    try {
      return /from ['"]lynkeus-agent(\/auto)?['"]/.test(fs.readFileSync(path.join(root, file), 'utf8'));
    } catch {
      return false;
    }
  });

const relImport = (fromFile: string, toFile: string): string => {
  const rel = path
    .relative(path.dirname(fromFile), toFile)
    .replace(/\\/g, '/')
    .replace(/\.(tsx|ts|jsx|js)$/, '');
  return rel.startsWith('.') ? rel : `./${rel}`;
};

/** The folder of an Expo Router app's routes, which is the app when there is no root component to import. */
const routesOf = (root: string): string | undefined => {
  try {
    createRequire(path.join(root, 'package.json')).resolve('expo-router/package.json');
  } catch {
    return undefined;
  }
  return ['src/app', 'app'].find(
    (dir) =>
      fs.existsSync(path.join(root, dir, '_layout.tsx')) ||
      fs.existsSync(path.join(root, dir, '_layout.js')) ||
      fs.existsSync(path.join(root, dir, 'index.tsx')),
  );
};

/** How the entry gets the App: the root component, or, for Expo Router, the router over the app's route files. */
type AppSource = { component: string; exportName: string; entry?: string } | { routes: string; dir: string };

const appBlock = (source: AppSource): string =>
  'component' in source
    ? source.entry
      ? `// The app's own entry runs as on a device (polyfills, services, the agent and its
// commands); the component it registers is the App. To skip the entry, require the
// component itself instead:
//   const { ${source.exportName === 'App' ? 'App' : `${source.exportName}: App`} } = require('${source.component}')
const App = registeredApp(() => require('${source.entry}'))`
      : `// Whatever the app's entry runs before rendering (polyfills, i18n, services):
// require it here too, then the App.
const { ${source.exportName === 'App' ? 'App' : `${source.exportName}: App`} } = require('${source.component}')`
    : `// An Expo Router app has no root component: the router is the app, over the route
// files in ${source.dir}, read here as the bundler would read them. Whatever the
// app's root layout does not run before rendering (polyfills, i18n), require it first.
process.env.EXPO_ROUTER_IMPORT_MODE = 'sync'
// Its testing library first: it stands in for what has no native side here (expo-linking's
// scheme, Reanimated), and the router must load after it.
const { getMockContext } = require('expo-router/testing-library')
const React = require('react')
const { ExpoRoot } = require('expo-router')
const routes = getMockContext(require('path').resolve(__dirname, '${source.routes}'))
// Mounted as a device build mounts it, so the agent finds the router's navigation by itself.
require('lynkeus-agent/auto').auto({ token: process.env.LYNKEUS_TOKEN })
const App = () => React.createElement(ExpoRoot, { context: routes })`;

const entryTemplate = (source: AppSource, appName: string, locale?: InitOptions['locale']): string => {
  const LOCALE =
    locale?.languageTag || locale?.country || locale?.language
      ? `\n  // The locale this app is built for, from lynkeus.config.json.\n  locale: ${JSON.stringify({ country: locale.country, languageTag: locale.languageTag, languageCode: locale.language })},`
      : "\n  // locale: { country: 'DE', languageTag: 'de-DE', languageCode: 'de' },";
  return `// Entry for \`lynkeus headless start\`: the whole app, hosted under jest so an agent can
// drive it in Node, with no simulator. Nothing here runs in the app itself. A native module gets the library's own jest mock when it ships one, else
// an empty answer the run reports; only ${appName}-specific pieces go here.
import { installDefaultMocks${'entry' in source && source.entry ? ', registeredApp' : ''} } from 'lynkeus-headless/mocks'

installDefaultMocks({
  // Real requests, to local hosts only (add others with networkHosts): a hosted app
  // never reaches production, whatever its API address says.
  network: 'real',${LOCALE}
})

// The app's own mocks go here, before the app is required: where a module answered
// empty by default needs a better answer (\`lynkeus headless doctor\` and each run list them):
//   jest.mock('some-native-package', () => ({ method: async () => 'what a device answers' }))

${appBlock(source)}

export { App }
`;
};

type Manifest = { main?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

const readManifest = (root: string): Manifest => {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as Manifest;
  } catch {
    return {};
  }
};

/** Expo inlines only the variables that start with EXPO_PUBLIC_; anything else is undefined in the app. */
const tokenIn = (expo: boolean): string => (expo ? 'process.env.EXPO_PUBLIC_LYNKEUS_TOKEN' : 'process.env.LYNKEUS_TOKEN');

// Up to the module's name: an import written over several lines (`import {\n  a,\n} from 'x'`) ends there, not at its first line.
const IMPORT = /^import\b[^'"]*?(['"])[^'"\n]*\1(;?)[^\n]*$/gm;

/** How a file writes its imports: the quote most of them use, and whether they end with a semicolon. */
export const importStyle = (text: string): { quote: "'" | '"'; semi: boolean } => {
  const imports = [...text.matchAll(IMPORT)];
  if (!imports.length) return { quote: "'", semi: /;\s*$/m.test(text) };
  const double = imports.filter((m) => m[1] === '"').length;
  const semis = imports.filter((m) => m[2] === ';').length;
  return { quote: double > imports.length / 2 ? '"' : "'", semi: semis > imports.length / 2 };
};

const mountLines = (expo: boolean, style: { quote: "'" | '"'; semi: boolean } = { quote: "'", semi: false }): string => {
  const q = style.quote;
  const end = style.semi ? ';' : '';
  return `import { auto } from ${q}lynkeus-agent/auto${q}${end}\n// Dev-only QA agent; a release build never evaluates the client.\nauto({ token: ${tokenIn(expo)} })${end}\n`;
};

const BABEL_CANDIDATES = ['babel.config.js', 'babel.config.cjs'];
const TOKEN_PLUGIN = 'lynkeus-agent/babel';

/** React Native gives the app no environment: the plugin writes LYNKEUS_TOKEN where the entry reads it. */
const addTokenPlugin = (root: string): string => {
  const byHand = `add '${TOKEN_PLUGIN}' to the plugins in babel.config.js, so the app can read LYNKEUS_TOKEN`;
  const file = findFirst(root, BABEL_CANDIDATES);
  if (!file) return byHand;
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  if (text.includes(TOKEN_PLUGIN)) return `${file} already has ${TOKEN_PLUGIN}`;
  const plugins = /\bplugins\s*:\s*\[/.exec(text);
  const presets = /^([ \t]*)presets\s*:/m.exec(text);
  // A config written on one line has its presets after the brace, not at the start of a line.
  const inline = plugins || presets ? null : /\bpresets\s*:/.exec(text);
  if (!plugins && !presets && !inline) return byHand;
  const next = plugins
    ? `${text.slice(0, plugins.index + plugins[0].length)}'${TOKEN_PLUGIN}', ${text.slice(plugins.index + plugins[0].length)}`
    : presets
      ? `${text.slice(0, presets.index)}${presets[1]}plugins: ['${TOKEN_PLUGIN}'],\n${text.slice(presets.index)}`
      : `${text.slice(0, inline!.index)}plugins: ['${TOKEN_PLUGIN}'], ${text.slice(inline!.index)}`;
  fs.writeFileSync(path.join(root, file), next);
  return `added ${TOKEN_PLUGIN} to ${file}`;
};

const EXPO_ENV = '.env.local';
const EXPO_TOKEN = 'EXPO_PUBLIC_LYNKEUS_TOKEN';

/** Whether a .gitignore line keeps `.env.local` out: the exact name, or a glob over it (`.env*.local`, `.env*`, `*.local`). */
const ignoresEnvLocal = (text: string): boolean =>
  text
    .split('\n')
    .map((line) => line.trim().replace(/^\//, ''))
    .some((line) => {
      if (!line || line.startsWith('#') || line.startsWith('!')) return false;
      const pattern = new RegExp(
        `^${line
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '[^/]*')
          .replace(/\?/g, '[^/]')}$`,
      );
      return pattern.test(EXPO_ENV);
    });

/**
 * The token in `.env.local` must stay out of git. Expo's own template ignores `.env*.local`, but templates built
 * on it (Ignite) and older apps do not: the line is added when the app's .gitignore lacks it.
 */
const keepEnvOutOfGit = (root: string): string => {
  const file = path.join(root, '.gitignore');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (ignoresEnvLocal(text)) return `.gitignore already keeps ${EXPO_ENV} out of git`;
  fs.writeFileSync(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}\n# local env files (the Lynkeus token)\n.env*.local\n`);
  return `added .env*.local to .gitignore, so the token in ${EXPO_ENV} stays out of git`;
};

/** Expo passes the app only variables that start with EXPO_PUBLIC_, and reads them from `.env.local`. */
const giveExpoTheToken = (root: string, token: string): string[] => {
  const file = path.join(root, EXPO_ENV);
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const ignored = keepEnvOutOfGit(root);
  if (new RegExp(`^${EXPO_TOKEN}=`, 'm').test(text)) return [`${EXPO_ENV} already sets ${EXPO_TOKEN}`, ignored];
  fs.writeFileSync(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${EXPO_TOKEN}=${token}\n`);
  return [`wrote ${EXPO_TOKEN} to ${EXPO_ENV}`, ignored];
};

/**
 * Mounts the agent from the app's entry, before anything registers the root component. An Expo Router app
 * has no entry of its own (`"main": "expo-router/entry"`), so it gets one that mounts the agent and then
 * loads the router.
 */
export const mountAgent = (root: string): string[] => {
  const notes: string[] = [];
  const manifest = readManifest(root);
  const expo = !!(manifest.dependencies?.expo ?? manifest.devDependencies?.expo);
  const index = findFirst(root, INDEX_CANDIDATES);
  const routed = manifest.main === 'expo-router/entry';
  const already = mountedIn(root);
  if (already) {
    notes.push(`${already} already mounts the agent`);
  } else if (routed && !index) {
    fs.writeFileSync(path.join(root, 'index.js'), `${mountLines(true)}\nimport 'expo-router/entry'\n`);
    fs.writeFileSync(
      path.join(root, 'package.json'),
      `${JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')), main: 'index.js' }, null, 2)}\n`,
    );
    notes.push("wrote index.js (mounts the agent, then loads expo-router) and pointed package.json's main at it");
  } else if (!index) {
    notes.push(`no index.js to add the auto mount to; add it yourself: import { auto } from 'lynkeus-agent/auto'; auto({ token: ${tokenIn(expo)} })`);
    return notes;
  } else {
    const indexPath = path.join(root, index);
    const text = fs.readFileSync(indexPath, 'utf8');
    // After the last import, so the app's own polyfills still run first.
    const imports = [...text.matchAll(IMPORT)];
    const at = imports.length ? imports[imports.length - 1]!.index! + imports[imports.length - 1]![0].length + 1 : 0;
    fs.writeFileSync(indexPath, text.slice(0, at) + mountLines(expo, importStyle(text)) + text.slice(at));
    notes.push(`added auto() to ${index}`);
  }
  const { token, made } = ensureToken(root);
  if (made) notes.push('made a token for this project in .lynkeus/token (kept out of git); the CLI, the MCP server and the app all read it');
  // A project set up before .lynkeus/.gitignore covered runs and bundles gets the fuller one.
  else ensureLynkeusIgnore(root);
  if (!expo) {
    notes.push(addTokenPlugin(root));
    notes.push('restart Metro with --reset-cache so the bundle picks the token up; LYNKEUS_TOKEN in the environment still wins over the file');
  }
  if (expo) {
    notes.push(...giveExpoTheToken(root, token));
    notes.push('Expo: the agent has native code, so it runs in a development build (npx expo run:ios, npx expo run:android), not in Expo Go');
    notes.push('Expo: restart the dev server so it reads .env.local; EXPO_PUBLIC_LYNKEUS_TOKEN in the environment still wins over the file');
  }
  return notes;
};

export const init = (root: string, opts: InitOptions): string[] => {
  const notes: string[] = [];
  const entryPath = path.join(root, opts.entry);
  const given = opts.app ? exactCase(root, opts.app) : undefined;
  if (opts.app && !given) throw new Error(`no ${opts.app} in ${root} (the path must match the file's case: jest's resolver is case-sensitive)`);
  const found = given ? { file: given, exportName: exportOf(root, given) } : findAppComponent(root, readManifest(root).main);
  const app = found?.file;
  const routes = app ? undefined : routesOf(root);
  if (!app && !routes) throw new Error(`no App component found (${APP_CANDIDATES.join(', ')}) and no Expo Router routes; pass --component <path>`);
  if (fs.existsSync(entryPath) && !opts.force) {
    notes.push(`${opts.entry} exists; left as is (--force overwrites)`);
  } else {
    fs.mkdirSync(path.dirname(entryPath), { recursive: true });
    const source: AppSource = app
      ? {
          component: relImport(entryPath, path.join(root, app)),
          exportName: found!.exportName,
          ...(found!.entry ? { entry: relImport(entryPath, path.join(root, found!.entry)) } : {}),
        }
      : { routes: path.relative(path.dirname(entryPath), path.join(root, routes!)).replace(/\\/g, '/'), dir: routes! };
    fs.writeFileSync(entryPath, entryTemplate(source, packageName(root), opts.locale));
    const component = app ? `${found!.exportName === 'default' ? 'the default export' : found!.exportName} of ${app}` : '';
    notes.push(
      `wrote ${opts.entry} (${app ? (found!.entry ? `runs ${found!.entry}, which registers ${component}` : `app: ${component}`) : `Expo Router, routes in ${routes}`})`,
    );
  }
  if (opts.auto) notes.push(...mountAgent(root));
  // `headless start` refuses to run without one, and an app tested only headless never runs `lynkeus init`.
  else if (ensureToken(root).made) notes.push('made a token for this project in .lynkeus/token (kept out of git); the CLI and the MCP server read it');
  notes.push(
    "jest: when the app has no jest configuration, `headless start` passes the preset it needs (jest-expo for Expo, React Native's otherwise) and the packages to transpile; an app that sets its own lets 'lynkeus-[^/]+' through, next to react-native",
  );
  notes.push(
    `next: lynkeus headless start${opts.apiEnv ? `  (the app reads its API address from ${opts.apiEnv}: set it, or "apiUrl" in lynkeus.config.json, to your local backend)` : ''}; the token is the project's, in .lynkeus/token`,
  );
  notes.push(
    '      or, in one go: lynkeus case here first-screen --host --write, then lynkeus case run --host  (lynkeus headless doctor lists what still needs a mock)',
  );
  return notes;
};

const AGENT = 'lynkeus-agent';

type Manager = 'bun' | 'pnpm' | 'yarn' | 'npm';

/** The package manager whose lockfile is in the app's folder or above it (an app in a monorepo has it at the top), and that folder. */
const lockfileOf = (root: string): { manager: Manager; dir: string } => {
  for (let dir = path.resolve(root); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'bun.lockb')) || fs.existsSync(path.join(dir, 'bun.lock'))) return { manager: 'bun', dir };
    if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) return { manager: 'pnpm', dir };
    if (fs.existsSync(path.join(dir, 'yarn.lock'))) return { manager: 'yarn', dir };
    if (fs.existsSync(path.join(dir, 'package-lock.json')) || fs.existsSync(path.join(dir, '.git')) || path.dirname(dir) === dir)
      return { manager: 'npm', dir };
  }
};

const managerOf = (root: string): Manager => lockfileOf(root).manager;

/** The pnpm that laid out node_modules, as it wrote itself into node_modules/.modules.yaml (`packageManager: pnpm@9.15.9`). */
export const pnpmThatInstalled = (root: string): string | undefined => {
  const top = lockfileOf(root).dir;
  for (let dir = path.resolve(root); ; dir = path.dirname(dir)) {
    try {
      const found = /^packageManager:\s*['"]?pnpm@([^\s'"]+)/m.exec(fs.readFileSync(path.join(dir, 'node_modules', '.modules.yaml'), 'utf8'));
      if (found) return found[1];
    } catch {}
    if (dir === top || path.dirname(dir) === dir) return undefined;
  }
};

const declaresManager = (root: string): boolean =>
  [root, lockfileOf(root).dir].some((dir) => {
    try {
      return !!(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { packageManager?: string }).packageManager;
    } catch {
      return false;
    }
  });

/** Every executable with this name on PATH, in order. */
const onPath = (name: string): string[] =>
  (process.env.PATH ?? '').split(path.delimiter).flatMap((dir) => {
    const file = path.join(dir, name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return [file];
    } catch {
      return [];
    }
  });

export type PathProbe = { pnpms: () => { file: string; corepack: boolean; version?: string }[]; corepack: () => boolean };

const pathProbe: PathProbe = {
  pnpms: () =>
    onPath('pnpm').map((file) => {
      let real = file;
      try {
        real = fs.realpathSync(file);
      } catch {}
      // Corepack's shim is not asked its version: with no packageManager in package.json that alone fetches the latest pnpm.
      if (/corepack/.test(real)) return { file, corepack: true };
      const ran = spawnSync(file, ['--version'], { encoding: 'utf8', timeout: 10_000 });
      return { file, corepack: false, version: ran.status === 0 ? ran.stdout.trim() : undefined };
    }),
  corepack: () => onPath('corepack').length > 0,
};

const major = (version: string | undefined): string | undefined => version?.split('.')[0];

/**
 * How to run the project's package manager. A pnpm project whose package.json names no packageManager is run with
 * the pnpm that made its node_modules: corepack's shim would fetch the latest pnpm, and a pnpm of another major
 * refuses node_modules laid out by the old one (ERR_PNPM_PUBLIC_HOIST_PATTERN_DIFF).
 */
export const managerCommand = (root: string, probe: PathProbe = pathProbe): string[] => {
  const manager = managerOf(root);
  if (manager !== 'pnpm' || declaresManager(root)) return [manager];
  const wanted = pnpmThatInstalled(root);
  if (!wanted) return ['pnpm'];
  const own = probe.pnpms().find((p) => !p.corepack && major(p.version) === major(wanted));
  if (own) return [own.file];
  return probe.corepack() ? ['corepack', `pnpm@${wanted}`] : ['npx', '--yes', `pnpm@${wanted}`];
};

/** Corepack asks before it downloads, and may write packageManager into package.json: neither is ours to do. */
const managerEnv = (): NodeJS.ProcessEnv => ({ ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', COREPACK_ENABLE_AUTO_PIN: '0' });

const addCommand = (root: string, names: string[], dev: boolean, probe?: PathProbe): string[] => {
  const run = managerCommand(root, probe);
  const manager = managerOf(root);
  const verb = manager === 'npm' ? ['install', ...(dev ? ['--save-dev'] : [])] : ['add', ...(dev ? [manager === 'bun' ? '-d' : '-D'] : [])];
  return [...run, ...verb, ...names];
};

/**
 * The command that adds lynkeus-agent: the project's own package manager, at this CLI's version (the two are
 * released together and misread each other across releases). Not Expo's installer: lynkeus-agent is not in its
 * SDK's list, so it only passes the package on to the package manager, at its latest.
 */
export const agentInstallCommand = (root: string, probe?: PathProbe): string[] => addCommand(root, [`${AGENT}@${CLI_VERSION}`], false, probe);

/**
 * What a failed install said, short enough for one line. npm ends its errors with where its logs are, so
 * the last lines alone told nothing; the reason (a peer range that does not match, say) comes before them.
 */
export const installFailure = (ran: { stderr?: string | null; error?: Error }): string =>
  `${ran.stderr ?? ''}\n${ran.error?.message ?? ''}`
    .split('\n')
    .map((line) => line.replace(/^(npm (error|ERR!)|error|ERR_PNPM_\w+|YN\d{4}:)\s*/, '').trim())
    .filter(
      (line) => line && !/^code \w+$|^node_modules\/|_logs|complete log|full report|^Fix the upstream|^this command with|^to accept an incorrect/i.test(line),
    )
    .slice(0, 8)
    .join('; ');

const hasAgent = (manifest: Manifest): boolean => !!(manifest.dependencies?.[AGENT] ?? manifest.devDependencies?.[AGENT]);

/** Adds lynkeus-agent to the app when it is not a dependency yet. It has native code, so the app is built again after. */
export const installAgent = (root: string): { text: string; ok: boolean } => {
  if (hasAgent(readManifest(root))) return { text: `${AGENT} is already a dependency`, ok: true };
  const command = agentInstallCommand(root);
  const ran = spawnSync(command[0]!, command.slice(1), { cwd: root, encoding: 'utf8', timeout: 300_000, env: managerEnv() });
  if (ran.status === 0) return { text: `installed ${AGENT} (${command.join(' ')}); it has native code, so build the app again`, ok: true };
  const said = installFailure(ran);
  return {
    text: `could not install ${AGENT} with \`${command.join(' ')}\`${said ? `: ${said}` : ''}; run it yourself, then \`lynkeus init\` again (the agent is not mounted until it is installed: the app would not build)`,
    ok: false,
  };
};

/** `optional`: a line that is not a fault when it fails (shown ○, not ✗). `group`: where status puts it. */
export type SetupCheck = { what: string; ok: boolean; fix?: string; optional?: boolean; group?: 'runs-on' | 'targets' | 'advice' };

/** What a project has of lynkeus and what it still lacks, each with the one thing that fixes it. Reads files only. */
export const setupChecks = (root: string): SetupCheck[] => {
  const manifest = readManifest(root);
  if (!manifest.dependencies && !manifest.devDependencies)
    return [{ what: 'a package.json here', ok: false, fix: 'run this from the app\u2019s folder (or pass --root)' }];
  const expo = !!(manifest.dependencies?.expo ?? manifest.devDependencies?.expo);
  const checks: SetupCheck[] = [];
  const depends = hasAgent(manifest);
  checks.push({ what: `${AGENT} is a dependency`, ok: depends, fix: '`lynkeus init` installs it' });
  if (depends)
    checks.push({
      what: `${AGENT} is installed`,
      ok: fs.existsSync(path.join(root, 'node_modules', AGENT, 'package.json')),
      fix: 'install the project\u2019s dependencies',
    });
  const mounted = mountedIn(root);
  checks.push({ what: mounted ? `${mounted} mounts the agent` : 'the app mounts the agent', ok: !!mounted, fix: '`lynkeus init` adds it to the entry' });
  if (!expo) {
    const babel = findFirst(root, BABEL_CANDIDATES);
    checks.push({
      what: 'babel.config.js has lynkeus-agent/babel',
      ok: !!babel && fs.readFileSync(path.join(root, babel), 'utf8').includes(TOKEN_PLUGIN),
      fix: '`lynkeus init` adds it',
    });
  }
  const token = readToken(root);
  checks.push({ what: 'the project has a token', ok: !!token, fix: '`lynkeus init` makes one in .lynkeus/token' });
  if (expo && token) {
    const env = path.join(root, EXPO_ENV);
    const given = !!process.env[EXPO_TOKEN] || (fs.existsSync(env) && new RegExp(`^${EXPO_TOKEN}=`, 'm').test(fs.readFileSync(env, 'utf8')));
    checks.push({ what: `Expo is given the token (${EXPO_TOKEN})`, ok: given, fix: '`lynkeus init` writes it to .env.local' });
  }
  return checks;
};

/** What `lynkeus headless start` runs on: jest hosts the app, Testing Library renders it, lynkeus-headless serves the agent. */
const HEADLESS_PACKAGES = ['jest', '@testing-library/react-native', 'lynkeus-headless'];

const resolvable = (root: string, name: string): boolean => {
  try {
    createRequire(path.join(root, 'package.json')).resolve(`${name}/package.json`);
    return true;
  } catch (error) {
    // A package whose exports leave package.json out is still there.
    return (error as { code?: string }).code === 'ERR_PACKAGE_PATH_NOT_EXPORTED';
  }
};

const JEST_PRESET = '@react-native/jest-preset';

/** The app's React Native version, when it is installed. */
const reactNativeVersion = (root: string): string | undefined => {
  try {
    const file = createRequire(path.join(root, 'package.json')).resolve('react-native/package.json');
    return (JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: string }).version;
  } catch {
    return undefined;
  }
};

// React Native 0.86 moved its jest preset out of `react-native`, which now throws when jest asks it for one.
const presetMoved = (version: string | undefined): boolean => {
  const [major, minor] = (version ?? '').split('.').map(Number);
  return major === 0 ? (minor ?? 0) >= 86 : (major ?? 0) > 0;
};

const JEST_EXPO = 'jest-expo';

const isExpo = (root: string): boolean => {
  const manifest = readManifest(root);
  return !!(manifest.dependencies?.expo ?? manifest.devDependencies?.expo);
};

/**
 * The jest preset the app needs and lacks: an Expo app's is jest-expo, which gives Expo's modules the native
 * side they look for (\`globalThis.expo\`); React Native 0.86 and later keep theirs out of \`react-native\`.
 */
const presetNeeded = (root: string): string | undefined => (isExpo(root) ? JEST_EXPO : presetMoved(reactNativeVersion(root)) ? JEST_PRESET : undefined);

/** The packages the headless host needs that this project cannot load yet. */
export const headlessMissing = (root: string): string[] =>
  [...HEADLESS_PACKAGES, ...[presetNeeded(root)].filter((p): p is string => !!p)].filter((name) => !resolvable(root, name));

/** The preset \`headless start\` gives jest when the app's own configuration names none. */
export const jestPreset = (root: string): string => (resolvable(root, JEST_EXPO) ? JEST_EXPO : resolvable(root, JEST_PRESET) ? JEST_PRESET : 'react-native');

const devInstallCommand = (root: string, names: string[]): string[] => addCommand(root, names, true);

const install = (root: string, command: string[], names: string[]): string => {
  const ran = spawnSync(command[0]!, command.slice(1), { cwd: root, encoding: 'utf8', timeout: 300_000, env: managerEnv() });
  if (ran.status === 0) return `installed ${names.join(', ')} (${command.join(' ')})`;
  const said = installFailure(ran);
  return `could not install ${names.join(', ')} with \`${command.join(' ')}\`${said ? `: ${said}` : ''}; run it yourself`;
};

/** Adds what the headless host needs as development dependencies; a line saying what happened. */
/** The jest-expo range the app's Expo SDK names in its list of the versions it was tested with. */
const jestExpoRange = (root: string): string | undefined => {
  try {
    const file = createRequire(path.join(root, 'package.json')).resolve('expo/bundledNativeModules.json');
    return (JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>)[JEST_EXPO];
  } catch {
    return undefined;
  }
};

/** The version each missing package is added at: Lynkeus's own at this CLI's, React Native's preset at React Native's, jest-expo at the SDK's. */
export const headlessSpecs = (root: string, names: string[]): string[] =>
  names.map((name) => {
    if (name === 'lynkeus-headless') return `${name}@${CLI_VERSION}`;
    // The React Native preset is released with React Native, version for version.
    if (name === JEST_PRESET) return `${name}@${reactNativeVersion(root)}`;
    const range = name === JEST_EXPO ? jestExpoRange(root) : undefined;
    return range ? `${name}@${range}` : name;
  });

/** Adds what the headless host needs as development dependencies; a line saying what happened. */
export const installHeadless = (root: string): string => {
  const missing = headlessMissing(root);
  if (!missing.length) return `jest, Testing Library, lynkeus-headless and the ${jestPreset(root)} preset are installed`;
  const lines: string[] = [];
  // Expo's installer is only for a jest-expo whose range the SDK's list does not give: it runs the package manager
  // on its own terms, which is the corepack trap the project's manager avoids.
  const byExpo = missing.includes(JEST_EXPO) && !jestExpoRange(root);
  const plain = missing.filter((name) => !(byExpo && name === JEST_EXPO));
  if (plain.length) lines.push(install(root, devInstallCommand(root, headlessSpecs(root, plain)), plain));
  if (byExpo) lines.push(install(root, ['npx', 'expo', 'install', JEST_EXPO, '--', '--save-dev'], [JEST_EXPO]));
  return lines.join('\n');
};

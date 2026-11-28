/**
 * The native values an app read that its host could not answer (`nativeValues`, see lynkeus-protocol's
 * RunNativeValue), and the `nativeMocks` that set them. The host reports them; here they are kept per run, told to
 * the person and handed to the host as configuration.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { RunNativeValue } from 'lynkeus-protocol';

import { appIdsOf } from '../device/devMenu.js';

import type { NativeSpecs } from './nativeSpecs.js';

/** Whether a `nativeMocks` entry sets a constant (and not what a call answers). */
const isConstant = (entry: unknown): boolean =>
  typeof entry === 'object' && entry !== null && ['value', 'ios', 'android', 'absent'].some((key) => Object.hasOwn(entry, key));

/**
 * The constants of the cases config's `nativeMocks`, as JSON for the host's environment (`LYNKEUS_NATIVE_VALUES`): a
 * host reads them when it starts, before the app's first read of a native module. Undefined when there are none.
 */
export const nativeValuesEnv = (mocks: Record<string, unknown> | undefined): string | undefined => {
  const constants = Object.entries(mocks ?? {}).filter(([, entry]) => isConstant(entry));
  return constants.length > 0 ? JSON.stringify(Object.fromEntries(constants)) : undefined;
};

const keyOf = (r: RunNativeValue) => `${r.platform}:${r.module}.${r.property ?? ''}`;

const isRead = (value: unknown): value is RunNativeValue => {
  const r = value as Partial<RunNativeValue> | null;
  return (
    typeof r === 'object' &&
    r !== null &&
    typeof r.module === 'string' &&
    (r.platform === 'ios' || r.platform === 'android') &&
    (r.host === 'fastsim' || r.host === 'headless')
  );
};

/** What a host answered `nativeValues` with, without what is not a read. */
export const readsOf = (answer: unknown): RunNativeValue[] => (Array.isArray(answer) ? answer.filter(isRead) : []);

/** Every case's reads as one list: a property read in several cases once, called if any case called it. */
export const mergeNativeValues = (lists: (RunNativeValue[] | undefined)[]): RunNativeValue[] => {
  const merged = new Map<string, RunNativeValue>();
  for (const read of lists.flatMap((l) => l ?? [])) {
    const seen = merged.get(keyOf(read));
    if (!seen) merged.set(keyOf(read), { ...read });
    else if (read.called) seen.called = true;
  }
  return [...merged.values()].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
};

/** A module the config's `nativeMocks` declares absent (`{ "absent": true }`, or listing this platform): the host's undefined is the answer asked for. */
const declaredAbsent = (entry: unknown, platform: string): boolean => {
  const absent = (entry as { absent?: unknown } | null | undefined)?.absent;
  return absent === true || (Array.isArray(absent) && absent.includes(platform));
};

const HOST = { fastsim: 'Lynkeus FastSim', headless: 'headless' } as const;

/**
 * What to tell after a run: each property the app read that its host did not know, as what it read as, and the
 * `nativeMocks` to paste with the value left for the person (or an agent, from the library's native code) to fill.
 * A property FastSim answered with a function the app then called is a no-op call, not a constant: it is left out. So
 * is one the app read and never called when the module's spec declares it a method: a reference taken and not used
 * (`setFocusTo: Native.setFocusTo`) is not wrong. One the spec does not cover may be either, and is told as such.
 */
export const describeNativeValues = (
  reads: RunNativeValue[],
  options: { entry?: string; nativeMocks?: Record<string, unknown>; specs?: NativeSpecs } = {},
): string[] => {
  reads = reads.filter((r) => !declaredAbsent(options.nativeMocks?.[r.module], r.platform));
  const fallback = new Set(reads.filter((r) => r.readAs === 'empty').map((r) => `${r.platform}:${r.module}`));
  const answered = describeFallbacks(
    reads.filter((r) => fallback.has(`${r.platform}:${r.module}`)),
    options.entry,
  );
  const kind = (r: RunNativeValue) => (r.property === undefined ? undefined : options.specs?.get(r.module)?.get(r.property));
  const shown = reads.filter((r) => !r.called && !fallback.has(`${r.platform}:${r.module}`) && !(r.readAs === 'function' && kind(r) === 'method'));
  if (shown.length === 0) return answered;
  const unsure = (r: RunNativeValue) => r.readAs === 'function' && kind(r) === undefined;
  const lines = shown.map((r) => {
    const what = r.property === undefined ? `the native module ${r.module}` : `${r.module}.${r.property}`;
    const outcome =
      r.readAs === 'function'
        ? unsure(r)
          ? 'it read as a function and was never called: a constant read as true, or a method the app only took a reference to (then nothing is wrong)'
          : 'its spec declares it a constant, and it read as true (a function)'
        : r.property === undefined
          ? 'the module is not there: it read as undefined'
          : 'it read as undefined';
    return `  • your app read ${what} on ${r.platform}, which ${HOST[r.host]} does not know; ${outcome}`;
  });
  const properties = [...new Set(shown.filter((r) => r.property !== undefined).map((r) => `${r.module}.${r.property}`))];
  const snippet =
    properties.length > 0
      ? [
          `  Set what a device answers in the cases config (\`value\` for both platforms, \`ios\` and \`android\` for one each, \`absent: true\` where the platform has none; the library's native code in node_modules says which)${shown.some(unsure) ? ', for a constant only: a method given a value stops being callable' : ''}:`,
          JSON.stringify({ nativeMocks: Object.fromEntries(properties.map((key) => [key, { value: null }])) }, null, 2)
            .split('\n')
            .map((l) => `  ${l}`)
            .join('\n'),
        ]
      : [];
  return [...answered, `native values ${HOST[shown[0]!.host]} could not answer (${shown.length}):`, ...lines, ...snippet];
};

const list = (names: string[], max = 6) => (names.length > max ? `${names.slice(0, max).join(', ')} and ${names.length - max} more` : names.join(', '));

/**
 * The modules headless's fallback answered, one line each, and how to answer better: never silent, and short, since an
 * agent reads it at the end of every run. A library is mocked in the headless entry; a call or a constant can also be
 * set in the cases config's `nativeMocks`.
 */
export const describeFallbacks = (reads: RunNativeValue[], entry = 'the headless entry'): string[] => {
  const modules = reads.filter((r) => r.readAs === 'empty' && r.property === undefined);
  if (modules.length === 0) return [];
  const lines = modules.map((m) => {
    const own = reads.filter((r) => r.module === m.module && r.platform === m.platform && r.property !== undefined);
    const called = own.filter((r) => r.called).map((r) => r.property!);
    const unused = own.filter((r) => !r.called).map((r) => r.property!);
    const parts = [called.length ? `called ${list(called)}` : '', unused.length ? `read, never called: ${list(unused)}` : ''].filter(Boolean);
    return `  • ${m.module} (${m.package ?? 'the app’s own code'})${parts.length ? `: ${parts.join('; ')}` : ''}`;
  });
  const packages = [...new Set(modules.map((m) => m.package).filter((p): p is string => !!p))];
  const firstCall = reads.find((r) => r.readAs === 'function' && r.called);
  return [
    `answered empty by default (${modules.length} native module${modules.length === 1 ? '' : 's'} with no mock; each method resolves undefined, which may not be what the app needs):`,
    ...lines,
    ...(packages.length
      ? [
          `  a better answer goes in ${entry}, where the app keeps its own mocks:`,
          ...packages.map((p) => `    jest.mock('${p}', () => ({ /* what the app uses, as a device answers */ }))`),
        ]
      : []),
    `  or per call in the cases config: "nativeMocks": { "${firstCall ? `${firstCall.module}.${firstCall.property}` : `${modules[0]!.module}.<method>`}": { "result": <what it resolves> } }`,
  ];
};

/**
 * The constants Lynkeus FastSim answers with a placeholder rather than the app's own (expo-application's id, name and
 * versions: `com.example.app`, `App`, `1.0.0`, `1`), set beside what the app's config says, with the `nativeMocks`
 * that give the real ones. A host reports what it could not answer, never what it guessed, so these are named from
 * the app's dependencies; none when the app does not use expo-application.
 */
export const describeGuessed = (
  app: { dependencies: string[]; ids: { ios?: string; android?: string }; name?: string; version?: string; build?: { ios?: string; android?: string } },
  nativeMocks: Record<string, unknown> = {},
  /** The host applies `nativeMocks` to Expo modules (its kit lists `expo-native-mocks`); FastSim's did not (trial run 12). */
  o: { hostApplies?: boolean } = {},
): string[] => {
  if (!app.dependencies.includes('expo-application')) return [];
  const pick = (ios?: string, android?: string) =>
    ios && android && ios !== android ? { ios, android } : ios || android ? { value: (ios ?? android)! } : undefined;
  const guessed: [string, string, ReturnType<typeof pick>][] = [
    ['ExpoApplication.applicationId', 'com.example.app', pick(app.ids.ios, app.ids.android)],
    ['ExpoApplication.applicationName', 'App', pick(app.name)],
    ['ExpoApplication.nativeApplicationVersion', '1.0.0', pick(app.version)],
    ['ExpoApplication.nativeBuildVersion', '1', pick(app.build?.ios, app.build?.android)],
  ];
  const real = (v: ReturnType<typeof pick>) => (v ? ('value' in v ? v.value : `${v.ios} on iOS, ${v.android} on Android`) : undefined);
  const line = ([key, placeholder, v]: (typeof guessed)[number], mocked: boolean) =>
    `  • ${key} reads ${JSON.stringify(placeholder)}${mocked ? ', though nativeMocks sets it' : real(v) ? `; the app's config says ${JSON.stringify(real(v))}` : ''}`;
  if (!o.hostApplies) {
    // A mock that changed nothing must not read as a fix (trial run 12: the list went quiet, the app still showed the placeholder).
    const mocked = guessed.filter(([key]) => nativeMocks[key] !== undefined);
    return [
      `native values Lynkeus FastSim guessed (${guessed.length}): the app reads expo-application, which this FastSim answers with placeholders, and it does not apply nativeMocks to Expo modules${mocked.length ? `: the ${mocked.length} set there had no effect` : ''}`,
      ...guessed.map((g) => line(g, nativeMocks[g[0]] !== undefined)),
      "  A check of these values passes on a device or headless, not on this FastSim; a FastSim whose share/capabilities lists expo-native-mocks reads them from the app's config and nativeMocks.",
    ];
  }
  // Such a kit reads the identity from the app's config: only what neither it nor nativeMocks gives is a placeholder.
  const open = guessed.filter(([key, , v]) => v === undefined && nativeMocks[key] === undefined);
  if (open.length === 0) return [];
  return [
    `native values Lynkeus FastSim guessed (${open.length}): the app reads expo-application and its config gives none of these, so FastSim answers placeholders`,
    ...open.map((g) => line(g, false)),
    '  Give the real ones in the cases config:',
    JSON.stringify({ nativeMocks: Object.fromEntries(open.map(([key]) => [key, { value: null }])) }, null, 2)
      .split('\n')
      .map((l) => `  ${l}`)
      .join('\n'),
  ];
};

const readJsonFile = (file: string): Record<string, unknown> => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
};

/** What `describeGuessed` sets beside FastSim's placeholders: the app's dependencies, ids, name and versions from its config. */
export const appFacts = (root: string, configured?: string): Parameters<typeof describeGuessed>[0] => {
  const pkg = readJsonFile(path.join(root, 'package.json')) as { dependencies?: object; devDependencies?: object; version?: string };
  const json = readJsonFile(path.join(root, 'app.json')) as { expo?: Record<string, unknown> } & Record<string, unknown>;
  const expo = (json.expo ?? json) as { name?: unknown; version?: unknown; ios?: { buildNumber?: unknown }; android?: { versionCode?: unknown } };
  const text = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : undefined);
  const ios = text(expo.ios?.buildNumber);
  const android = text(expo.android?.versionCode);
  return {
    dependencies: [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})],
    ids: appIdsOf(root, configured),
    ...(text(expo.name) ? { name: text(expo.name) } : {}),
    ...((text(expo.version) ?? pkg.version) ? { version: text(expo.version) ?? pkg.version } : {}),
    ...(ios || android ? { build: { ...(ios ? { ios } : {}), ...(android ? { android } : {}) } } : {}),
  };
};

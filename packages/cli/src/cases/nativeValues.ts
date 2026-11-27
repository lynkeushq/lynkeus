/**
 * The native values an app read that its host could not answer (`nativeValues`, see lynkeus-protocol's
 * RunNativeValue), and the `nativeMocks` that set them. The host reports them; here they are kept per run, told to
 * the person and handed to the host as configuration.
 */
import type { RunNativeValue } from 'lynkeus-protocol';

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
 * A property FastSim answered with a function the app then called is a no-op call, not a constant: it is left out.
 */
export const describeNativeValues = (reads: RunNativeValue[], options: { entry?: string; nativeMocks?: Record<string, unknown> } = {}): string[] => {
  reads = reads.filter((r) => !declaredAbsent(options.nativeMocks?.[r.module], r.platform));
  const fallback = new Set(reads.filter((r) => r.readAs === 'empty').map((r) => `${r.platform}:${r.module}`));
  const answered = describeFallbacks(
    reads.filter((r) => fallback.has(`${r.platform}:${r.module}`)),
    options.entry,
  );
  const shown = reads.filter((r) => !r.called && !fallback.has(`${r.platform}:${r.module}`));
  if (shown.length === 0) return answered;
  if (shown.length === 0) return [];
  const lines = shown.map((r) => {
    const what = r.property === undefined ? `the native module ${r.module}` : `${r.module}.${r.property}`;
    const outcome =
      r.readAs === 'function'
        ? 'it read as true (a function), and was never called: a constant with a wrong value'
        : r.property === undefined
          ? 'the module is not there: it read as undefined'
          : 'it read as undefined';
    return `  • your app read ${what} on ${r.platform}, which ${HOST[r.host]} does not know; ${outcome}`;
  });
  const properties = [...new Set(shown.filter((r) => r.property !== undefined).map((r) => `${r.module}.${r.property}`))];
  const snippet =
    properties.length > 0
      ? [
          `  Set what a device answers in the cases config (\`value\` for both platforms, \`ios\` and \`android\` for one each, \`absent: true\` where the platform has none; the library's native code in node_modules says which):`,
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

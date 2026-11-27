// What the app reads off a native module that this host does not know. A real device answers each of those with a
// value of its own. A module nothing provides (no mock, no library jest mock, not React Native's preset) gets the
// generic fallback: a module whose every method is a no-op that resolves empty, as Lynkeus FastSim's shim answers
// (a function, so a constant reads as true). Both are guesses, so the host says which modules and properties it
// answered that way, and the CLI tells how to give a better answer: a mock in the headless entry, or the cases
// config's `nativeMocks` (`"RNFoo.isTablet": { "value": false }`, `"RNFoo.load": { "result": {} }`).
import { qa } from 'lynkeus-agent';

import { log } from '../runtime.js';
import { owners, type Reader, readerOf } from './owners.js';

type Platform = 'ios' | 'android';

/**
 * One property (or, with no `property`, one whole module) the app read that nothing answered: `undefined` on a module
 * that exists, `function` on a module the fallback answered (`called` once the app called it), `empty` for the module
 * itself, with the package whose code first read it.
 */
export type NativeValueRead = {
  module: string;
  property?: string;
  platform: Platform;
  host: 'headless';
  readAs: 'undefined' | 'function' | 'empty';
  called?: boolean;
  package?: string;
};

/** The constants form of a `nativeMocks` entry; `result` and `screen` entries are about calls and are left to native.ts. */
export type NativeValueEntry = { value?: unknown; ios?: unknown; android?: unknown; absent?: boolean | Platform[] };

type Answer = { absent: true } | { absent?: false; value: unknown };

const has = (entry: object, key: string) => Object.hasOwn(entry, key);

export const resolveNativeValue = (entry: unknown, platform: Platform): Answer | undefined => {
  if (typeof entry !== 'object' || entry === null) return undefined;
  const e = entry as NativeValueEntry;
  if (e.absent === true || (Array.isArray(e.absent) && e.absent.includes(platform))) return { absent: true };
  if (has(e, platform)) return { value: e[platform] };
  if (has(e, 'value')) return { value: e.value };
  return undefined;
};

type RN = {
  Platform: { OS: string };
  NativeModules: Record<string, Record<string, unknown> | undefined>;
  TurboModuleRegistry?: { get?: (name: string) => unknown; getEnforcing?: (name: string) => unknown };
};

// Probes that are not constants: promise and JSON duck typing, React's and jest's checks, NativeEventEmitter.
const PROBES = new Set(['then', 'toJSON', 'constructor', 'asymmetricMatch', 'nodeType', 'tagName', 'addListener', 'removeListeners', 'getConstants']);

const reads = new Map<string, NativeValueRead>();
const configured = new Set<string>();
// Modules the project declared absent (`"EXDevLauncher": { "absent": true }`): reading one is the answer asked for, not news.
const declaredAbsent = new Set<string>();
const wrapped = new WeakMap<object, object>();
// Modules the fallback made, and the no-op each property read of one hands out (the same one every time).
const fallbacks = new WeakSet<object>();
const noops = new Map<string, (...args: unknown[]) => unknown>();
// Inside TurboModuleRegistry.get a missing module is an optional one: the library has a path for null.
let optionalLookups = 0;

const platformOf = (rn: RN): Platform => (rn.Platform.OS === 'android' ? 'android' : 'ios');

const keyOf = (read: Pick<NativeValueRead, 'module' | 'property'>) => (read.property === undefined ? read.module : `${read.module}.${read.property}`);

const note = (read: NativeValueRead) => {
  if (!reads.has(keyOf(read))) reads.set(keyOf(read), read);
};

const MODULE_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/** The generic fallback for a module nothing provides; kept on `NativeModules`, where `nativeMocks` can still answer it. */
export const fallbackModule = (module: string, platform: Platform, reader: Reader | undefined = readerOf()): Record<string, unknown> => {
  const made: Record<string, unknown> = {};
  fallbacks.add(made);
  const from = reader?.package;
  note({ module, platform, host: 'headless', readAs: 'empty', ...(from ? { package: from } : {}) });
  log(`native: ${module}${from ? ` (${from})` : ''} has no mock; answered empty by default`);
  return made;
};

const noop = (module: string, property: string, platform: Platform) => {
  const key = `${module}.${property}`;
  const known = noops.get(key);
  if (known) return known;
  note({ module, property, platform, host: 'headless', readAs: 'function', called: false });
  const fn = (..._args: unknown[]) => {
    const read = reads.get(key);
    if (read) read.called = true;
    return Promise.resolve(undefined);
  };
  noops.set(key, fn);
  return fn;
};

// What NativeEventEmitter, TurboModule specs and the event subscriptions built on them call on any module.
const PLUMBING: Record<string, () => unknown> = { getConstants: () => ({}), addListener: () => undefined, removeListeners: () => undefined };

const watch = (module: string, target: Record<string, unknown>, platform: Platform): object => {
  const existing = wrapped.get(target);
  if (existing) return existing;
  const fallback = fallbacks.has(target);
  const proxy = new Proxy(target, {
    get(t, prop, receiver) {
      const value = Reflect.get(t, prop, receiver);
      if (value !== undefined || typeof prop !== 'string' || prop in t || configured.has(`${module}.${prop}`)) return value;
      if (fallback) return PLUMBING[prop] ?? (PROBES.has(prop) || !MODULE_NAME.test(prop) ? undefined : noop(module, prop, platform));
      // `__expo_module_name__` and the like are a framework asking what the object is, not the app reading a constant.
      if (!PROBES.has(prop) && !prop.startsWith('__')) note({ module, property: prop, platform, host: 'headless', readAs: 'undefined' });
      return value;
    },
  });
  wrapped.set(target, proxy);
  return proxy;
};

// Wraps `NativeModules` itself where jest's preset left it replaceable, so a module read before anyone sets it up is seen
// as well; where it is not, the modules that exist are wrapped one by one.
const watchModules = (rn: RN, platform: Platform) => {
  const holder = require('react-native/Libraries/BatchedBridge/NativeModules') as { default?: unknown };
  const target = rn.NativeModules;
  if (holder.default === target) {
    try {
      holder.default = new Proxy(target, {
        get(t, name, receiver) {
          let module = Reflect.get(t, name, receiver);
          if (typeof name !== 'string' || PROBES.has(name)) return module;
          if (module === undefined && !(name in t)) {
            // Only a module the reading code's own native side defines: anyone else's is an optional one it checks for.
            if (declaredAbsent.has(name)) return module;
            const reader = optionalLookups > 0 || !MODULE_NAME.test(name) ? undefined : readerOf();
            if (!reader || !owners.owns(reader, name)) {
              note({ module: name, platform, host: 'headless', readAs: 'undefined' });
              return module;
            }
            module = fallbackModule(name, platform, reader);
            t[name] = module as Record<string, unknown>;
          }
          return typeof module === 'object' && module !== null ? watch(name, module as Record<string, unknown>, platform) : module;
        },
      });
      return;
    } catch {
      // not replaceable: fall through
    }
  }
  for (const [name, module] of Object.entries(target)) if (module) target[name] = watch(name, module, platform) as Record<string, unknown>;
};

/** Sets each constant entry on `NativeModules`, where the app's first read finds it. Returns the keys it applied. */
export const applyNativeValues = (entries: Record<string, unknown>, rn: RN = require('react-native') as RN): string[] => {
  const platform = platformOf(rn);
  const applied: string[] = [];
  for (const [key, entry] of Object.entries(entries)) {
    const answer = resolveNativeValue(entry, platform);
    const dot = key.indexOf('.');
    if (answer?.absent && dot === -1) {
      declaredAbsent.add(key);
      reads.delete(key);
      applied.push(key);
      continue;
    }
    if (!answer || dot <= 0) continue;
    const module = key.slice(0, dot);
    const property = key.slice(dot + 1);
    const target = (module in rn.NativeModules ? rn.NativeModules[module] : undefined) ?? {};
    rn.NativeModules[module] = target;
    // Written through the object, not the proxy around it, so that the read is not counted as an unknown one.
    if (answer.absent) delete target[property];
    else target[property] = answer.value;
    configured.add(key);
    reads.delete(key);
    applied.push(key);
  }
  return applied;
};

const fromEnv = (): Record<string, unknown> => {
  // Not `process.env.X`: a babel transform that inlines environment variables would freeze the first run's value into jest's cache.
  const env = process.env;
  const text = env.LYNKEUS_NATIVE_VALUES;
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    log('LYNKEUS_NATIVE_VALUES is not JSON; ignored');
    return {};
  }
};

export const installNativeValues = (): void => {
  const rn = require('react-native') as RN;
  const platform = platformOf(rn);
  const applied = applyNativeValues(fromEnv(), rn);
  if (applied.length) log(`native values: ${applied.join(', ')}`);
  watchModules(rn, platform);
  // A new-architecture library asks the registry; one the config names gets the module it set up above.
  const registry = rn.TurboModuleRegistry;
  const forModule = (name: string) => (configured.size && [...configured].some((key) => key.startsWith(`${name}.`)) ? rn.NativeModules[name] : undefined);
  const raw = (name: string) => (name in rn.NativeModules ? rn.NativeModules[name] : undefined);
  if (registry?.get) {
    const get = registry.get.bind(registry);
    registry.get = (name: string) => {
      optionalLookups += 1;
      try {
        return get(name) ?? forModule(name) ?? null;
      } finally {
        optionalLookups -= 1;
      }
    };
  }
  if (registry?.getEnforcing) {
    const getEnforcing = registry.getEnforcing.bind(registry);
    // getEnforcing means the library cannot do without it: the fallback stands in where jest's would throw.
    registry.getEnforcing = (name: string) => {
      const set = forModule(name);
      if (set) return set;
      try {
        return getEnforcing(name);
      } catch {
        const known = raw(name);
        if (known) return known;
        const made = fallbackModule(name, platform);
        rn.NativeModules[name] = made;
        return rn.NativeModules[name];
      }
    };
  }
  qa.register('nativeValues', () => [...reads.values()]);
};

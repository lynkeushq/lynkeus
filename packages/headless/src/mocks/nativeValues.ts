// What the app reads off a native module that this host does not know. A real device answers each of those with a
// value of its own; jest's React Native answers undefined, the opposite of Lynkeus FastSim (a function, so a
// constant reads as true). Both are guesses, so the host says which reads it could not answer and lets the cases
// config's `nativeMocks` set them: `"RNFoo.isTablet": { "value": false }`.
import { qa } from 'lynkeus-agent';

import { log } from '../runtime.js';

type Platform = 'ios' | 'android';

/** One property (or, with no `property`, one whole module) the app read that nothing answered. */
export type NativeValueRead = { module: string; property?: string; platform: Platform; host: 'headless'; readAs: 'undefined' };

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
const wrapped = new WeakMap<object, object>();

const platformOf = (rn: RN): Platform => (rn.Platform.OS === 'android' ? 'android' : 'ios');

const note = (read: NativeValueRead) => {
  const key = read.property === undefined ? read.module : `${read.module}.${read.property}`;
  if (!reads.has(key)) reads.set(key, read);
};

const watch = (module: string, target: Record<string, unknown>, platform: Platform): object => {
  const existing = wrapped.get(target);
  if (existing) return existing;
  const proxy = new Proxy(target, {
    get(t, prop, receiver) {
      const value = Reflect.get(t, prop, receiver);
      if (value === undefined && typeof prop === 'string' && !PROBES.has(prop) && !(prop in t) && !configured.has(`${module}.${prop}`))
        note({ module, property: prop, platform, host: 'headless', readAs: 'undefined' });
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
          const module = Reflect.get(t, name, receiver);
          if (typeof name !== 'string' || PROBES.has(name)) return module;
          if (module === undefined && !(name in t)) {
            note({ module: name, platform, host: 'headless', readAs: 'undefined' });
            return module;
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
  if (registry?.get) {
    const get = registry.get.bind(registry);
    registry.get = (name: string) => get(name) ?? forModule(name) ?? null;
  }
  if (registry?.getEnforcing) {
    const getEnforcing = registry.getEnforcing.bind(registry);
    registry.getEnforcing = (name: string) => forModule(name) ?? getEnforcing(name);
  }
  qa.register('nativeValues', () => [...reads.values()]);
};

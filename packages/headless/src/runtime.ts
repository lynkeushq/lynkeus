import { installXMLHttpRequest } from './xhr.js';

// jest buffers console output until a test ends, and the host's test never does.
export const log = (line: string): void => {
  process.stderr.write(`[lynkeus-headless] ${line}\n`);
};

const resetters: Array<() => void> = [];

// What a fresh app must not inherit from the previous case: mocked stores, network rules, the clock.
export const onReset = (fn: () => void): void => {
  resetters.push(fn);
};

export const reset = (): void => {
  for (const fn of resetters) {
    try {
      fn();
    } catch (error) {
      log(`reset: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
};

export const resolvable = (id: string): boolean => {
  try {
    require.resolve(id);
    return true;
  } catch {
    return false;
  }
};

// A loaded image's size, which no host has: a square, so an image sized by its aspect ratio keeps one.
const IMAGE_SIZE = { width: 100, height: 100 };

type SizeCallback = (width: number, height: number) => void;
type ImageStatics = { getSize?: (...args: unknown[]) => unknown; getSizeWithHeaders?: (...args: unknown[]) => unknown };

// Jest's image loader answers nothing, so `Image.getSize(uri)` threw reading `then` of undefined inside a layout effect
// and took the whole screen down (an auto-sizing image scrolled into view). The host answers as a device does once the
// image has loaded, through the promise or the callbacks. An app's own working mock is left alone.
const installImageSize = (): void => {
  const { Image } = require('react-native') as { Image?: ImageStatics };
  if (!Image) return;
  let works = false;
  try {
    const answer = Image.getSize?.('lynkeus://probe');
    works = typeof (answer as { then?: unknown } | undefined)?.then === 'function';
    (answer as Promise<unknown> | undefined)?.catch?.(() => undefined);
  } catch {
    works = false;
  }
  if (works) return;
  const answered = (success: unknown, failure: unknown) => {
    const size = Promise.resolve({ ...IMAGE_SIZE });
    if (typeof success !== 'function') return size;
    size.then((s) => (success as SizeCallback)(s.width, s.height)).catch(typeof failure === 'function' ? (failure as (e: unknown) => void) : () => undefined);
    return undefined;
  };
  Image.getSize = (_uri: unknown, success?: unknown, failure?: unknown) => answered(success, failure);
  Image.getSizeWithHeaders = (_uri: unknown, _headers: unknown, success?: unknown, failure?: unknown) => answered(success, failure);
};

// What React Native's InitializeCore does to the global scope and its jest
// preset does not, needed before any app module evaluates.
export const installRuntime = (): void => {
  // react-navigation reads `navigator.product` once, at load, to flush state in
  // a layout effect; without it a RESET of a nested navigator is overwritten
  // by that navigator's own unmount cleanup and the stack stays where it was.
  const g = globalThis as { navigator?: { product?: string } };
  if (g.navigator === undefined) {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { product: 'ReactNative' } });
  } else if (g.navigator.product !== 'ReactNative') {
    Object.defineProperty(g.navigator, 'product', { configurable: true, get: () => 'ReactNative' });
  }
  // The preset answers Dimensions with 750×1334 while the host lays screens out
  // on a phone: a slider sized from Dimensions would never reach its end.
  const { Dimensions } = require('react-native') as { Dimensions: { set?: (dims: Record<string, unknown>) => void } };
  const window = { width: 390, height: 844, scale: 3, fontScale: 1 };
  Dimensions.set?.({ window, screen: window });
  installXMLHttpRequest();
  installImageSize();
  // A development build loads its bundle from Metro and says so; jest's says null, and dev tooling that reads the
  // dev server's address from it (Expo's metro runtime, Reactotron) throws or warns at import.
  const { NativeModules, Platform } = require('react-native') as {
    NativeModules: Record<string, { getConstants?: () => Record<string, unknown> } | undefined>;
    Platform: { OS: string };
  };
  const source = 'SourceCode' in NativeModules ? NativeModules.SourceCode : undefined;
  const constants = source?.getConstants?.();
  if (source && constants && constants.scriptURL == null)
    source.getConstants = () => ({ ...constants, scriptURL: `http://localhost:8081/index.bundle?platform=${Platform.OS}&dev=true` });
};

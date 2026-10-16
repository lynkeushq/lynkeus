// The cases config's `nativeMocks`: what a native SDK the host cannot run (Sumsub, Intercom) answers, and the
// page it shows meanwhile. A mock keyed "Module.method" resolves the call with its `result`, or puts up a
// stand-in page whose buttons each resolve it with a result of their own, pressable as `#native-mock-<label>`.
// The page is drawn over the app's root, so a case sees and presses it like any other screen; fastsim's host
// answers the same `nativeMocks` command with the same defaults.
import { qa } from 'lynkeus-agent';
import { createElement, useSyncExternalStore, type ReactElement } from 'react';

import { log, onReset } from '../runtime.js';

type Screen = { title?: string; subtitle?: string; image?: string; buttons?: Record<string, unknown> };
type NativeMock = { result?: unknown; screen?: Screen };
type Shown = { key: string; screen: Screen; resolve: (result: unknown) => void };

// Without configuration, the SDK's own screen stands in as a titled page, and the answers are the ones its
// library resolves with when the user finishes or backs out.
const DEFAULTS: Record<string, NativeMock> = {
  'SNSMobileSDKModule.launch': {
    screen: {
      title: 'Sumsub',
      subtitle: 'Identity verification',
      buttons: {
        Submit: { success: true, status: 'Pending' },
        Close: { success: false, status: 'Incomplete', errorType: 'Unknown' },
      },
    },
  },
  'IntercomModule.presentIntercom': { screen: { title: 'Intercom', subtitle: 'Messenger', buttons: { Close: true } } },
  'IntercomModule.presentIntercomSpace': { screen: { title: 'Intercom', subtitle: 'Messenger', buttons: { Close: true } } },
  'IntercomModule.presentContent': { screen: { title: 'Intercom', subtitle: 'Help content', buttons: { Close: true } } },
  'IntercomModule.presentMessageComposer': { screen: { title: 'Intercom', subtitle: 'New message', buttons: { Close: true } } },
};

let mocks: Record<string, NativeMock> = { ...DEFAULTS };
let shown: Shown | null = null;
const watchers = new Set<() => void>();

const show = (next: Shown | null) => {
  shown = next;
  for (const watcher of watchers) watcher();
};

export const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

export const callNative = (module: string, method: string): Promise<unknown> | undefined => {
  const key = `${module}.${method}`;
  const mock = mocks[key];
  if (!mock) return undefined;
  if (!mock.screen) return Promise.resolve(mock.result);
  log(`native mock: ${key} shows "${mock.screen.title ?? key}"`);
  return new Promise((resolve) => {
    // A second launch while one is up replaces it, as the SDKs present over themselves.
    shown?.resolve(mock.result);
    show({ key, screen: mock.screen!, resolve });
  });
};

// `replace` sets the whole table (the config's, at the start of a case); `set` merges keys into it; `null`
// for a key takes its mock away. The defaults stay unless replaced.
export const configureNativeMocks = (params: { replace?: Record<string, NativeMock | null>; set?: Record<string, NativeMock | null> } = {}) => {
  if (params.replace) mocks = { ...DEFAULTS, ...(params.replace as Record<string, NativeMock>) };
  for (const [key, mock] of Object.entries(params.set ?? {})) {
    if (mock === null) delete mocks[key];
    else mocks[key] = mock;
  }
  for (const [key, mock] of Object.entries(params.replace ?? {})) if (mock === null) delete mocks[key];
  standIn();
  return { mocked: Object.keys(mocks).sort() };
};

type RN = { NativeModules: Record<string, Record<string, unknown> | undefined> };

// A module the app has no native side for gets one whose mocked methods answer here. It is read when the
// SDK's JavaScript loads (`const { SNSMobileSDKModule } = NativeModules`), so this runs before the app does.
const standIn = () => {
  const rn = require('react-native') as RN;
  for (const key of Object.keys(mocks)) {
    const [module, method] = key.split('.') as [string, string];
    // NativeEventEmitter asks a module for these before it listens.
    const target = rn.NativeModules[module] ?? { addListener: () => undefined, removeListeners: () => undefined };
    rn.NativeModules[module] = target;
    if (typeof target[method] !== 'function' || (target[method] as { nativeMock?: boolean }).nativeMock) {
      const call = Object.assign((..._args: unknown[]) => callNative(module, method) ?? Promise.resolve(undefined), { nativeMock: true });
      target[method] = call;
    }
  }
};

export const installNativeMocks = (): void => {
  standIn();
  onReset(() => {
    mocks = { ...DEFAULTS };
    show(null);
  });
  qa.register('nativeMocks', (params) => configureNativeMocks((params ?? {}) as Parameters<typeof configureNativeMocks>[0]));
};

const subscribe = (watcher: () => void) => {
  watchers.add(watcher);
  return () => watchers.delete(watcher);
};

// The page a mocked SDK shows, over everything the app draws.
export const NativeMockScreen = (): ReactElement | null => {
  const current = useSyncExternalStore(subscribe, () => shown);
  if (!current) return null;
  const { Pressable, Text, View } = require('react-native') as typeof import('react-native');
  const { title, subtitle, buttons = {} } = current.screen;
  const answer = (result: unknown) => {
    show(null);
    current.resolve(result);
  };
  return createElement(
    View,
    {
      testID: 'native-mock',
      accessibilityViewIsModal: true,
      style: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#ffffff' },
    },
    title ? createElement(Text, null, title) : null,
    subtitle ? createElement(Text, null, subtitle) : null,
    ...Object.entries(buttons).map(([label, result]) =>
      createElement(Pressable, { key: label, testID: `native-mock-${slug(label)}`, onPress: () => answer(result) }, createElement(Text, null, label)),
    ),
  );
};

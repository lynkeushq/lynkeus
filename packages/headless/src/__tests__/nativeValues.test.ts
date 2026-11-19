import { beforeAll, describe, expect, it } from '@jest/globals';
import { host } from 'lynkeus-agent';
import { NativeModules, Platform } from 'react-native';

import { installNativeMocks } from '../mocks/native.js';
import { applyNativeValues, installNativeValues, resolveNativeValue, type NativeValueRead } from '../mocks/nativeValues.js';

const nativeMocks = (params: unknown) => (host.get('nativeMocks') as (p: unknown) => unknown)(params);
const report = () => (host.get('nativeValues') as () => NativeValueRead[])();
// Read through the import on every use: installing the watcher replaces the object `NativeModules` stands for.
const modules = new Proxy({} as Record<string, Record<string, unknown> | undefined>, {
  get: (_, name: string) => (NativeModules as Record<string, Record<string, unknown> | undefined>)[name],
  has: (_, name: string) => name in NativeModules,
});

beforeAll(() => {
  installNativeMocks();
  installNativeValues();
});

describe('resolveNativeValue', () => {
  it('takes a platform’s own value over the shared one, and false and null as values', () => {
    expect(resolveNativeValue({ value: 1, android: 2 }, 'android')).toEqual({ value: 2 });
    expect(resolveNativeValue({ value: 1, android: 2 }, 'ios')).toEqual({ value: 1 });
    expect(resolveNativeValue({ value: false }, 'ios')).toEqual({ value: false });
    expect(resolveNativeValue({ value: null }, 'ios')).toEqual({ value: null });
  });

  it('says a property is absent on the platforms listed, or on all', () => {
    expect(resolveNativeValue({ absent: true }, 'ios')).toEqual({ absent: true });
    expect(resolveNativeValue({ value: 1, absent: ['ios'] }, 'ios')).toEqual({ absent: true });
    expect(resolveNativeValue({ value: 1, absent: ['android'] }, 'ios')).toEqual({ value: 1 });
  });

  it('leaves a call mock alone', () => {
    expect(resolveNativeValue({ result: 1 }, 'ios')).toBeUndefined();
    expect(resolveNativeValue(null, 'ios')).toBeUndefined();
  });
});

describe('unknown native reads', () => {
  it('lists a property no module answers, once, and a module the host does not have', () => {
    expect(modules.DeviceInfo?.isTablet).toBeUndefined();
    expect(modules.DeviceInfo?.isTablet).toBeUndefined();
    expect(modules.RNMissing).toBeUndefined();
    const list = report();
    expect(list.filter((r) => r.module === 'DeviceInfo' && r.property === 'isTablet')).toEqual([
      { module: 'DeviceInfo', property: 'isTablet', platform: Platform.OS, host: 'headless', readAs: 'undefined' },
    ]);
    expect(list).toContainEqual({ module: 'RNMissing', platform: Platform.OS, host: 'headless', readAs: 'undefined' });
  });

  it('does not list the probes of promises, JSON and event emitters', () => {
    const probe = modules.DeviceInfo as Record<string, unknown>;
    void probe.then;
    void probe.toJSON;
    void probe.addListener;
    expect(report().some((r) => ['then', 'toJSON', 'addListener'].includes(r.property ?? ''))).toBe(false);
  });
});

describe('nativeMocks values', () => {
  it('sets a constant on a module, and a value that is false reads as false', () => {
    nativeMocks({ set: { 'RNFoo.isTablet': { value: false } } });
    expect(modules.RNFoo?.isTablet).toBe(false);
    expect(report().some((r) => r.module === 'RNFoo')).toBe(false);
  });

  it('answers per platform and takes a property away where it is absent', () => {
    nativeMocks({ set: { 'RNFoo.density': { ios: 3, android: 2.75 }, 'RNFoo.gone': { value: 1, absent: [Platform.OS] } } });
    expect(modules.RNFoo?.density).toBe(Platform.OS === 'android' ? 2.75 : 3);
    expect('gone' in (modules.RNFoo ?? {})).toBe(false);
    expect(report().some((r) => r.property === 'gone')).toBe(false);
  });

  it('applies the entries of the environment before the app reads them', () => {
    expect(applyNativeValues({ 'RNBar.level': { value: 7 }, 'RNBar.launch': { result: 1 } })).toEqual(['RNBar.level']);
    expect(modules.RNBar?.level).toBe(7);
  });
});

describe('LYNKEUS_NATIVE_VALUES', () => {
  it('is what a host started by the CLI applies before the app is required', () => {
    process.env.LYNKEUS_NATIVE_VALUES = JSON.stringify({ 'RNEnv.isTablet': { value: false }, 'RNEnv.sdk': { ios: 1, android: 2 } });
    try {
      jest.isolateModules(() => {
        (require('../mocks/nativeValues.js') as typeof import('../mocks/nativeValues.js')).installNativeValues();
      });
    } finally {
      delete process.env.LYNKEUS_NATIVE_VALUES;
    }
    expect(modules.RNEnv?.isTablet).toBe(false);
    expect(modules.RNEnv?.sdk).toBe(Platform.OS === 'android' ? 2 : 1);
  });

  it('ignores a value that is not JSON', () => {
    process.env.LYNKEUS_NATIVE_VALUES = '{nope';
    try {
      expect(() =>
        jest.isolateModules(() => {
          (require('../mocks/nativeValues.js') as typeof import('../mocks/nativeValues.js')).installNativeValues();
        }),
      ).not.toThrow();
    } finally {
      delete process.env.LYNKEUS_NATIVE_VALUES;
    }
  });
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { RunNativeValue } from 'lynkeus-protocol';

import { describeNativeValues, mergeNativeValues, nativeValuesEnv, readsOf } from '../nativeValues.js';
import { RunFile } from '../runfile.js';

const fastsim = (property: string, over: Partial<RunNativeValue> = {}): RunNativeValue => ({
  module: 'RNFoo',
  property,
  platform: 'ios',
  host: 'fastsim',
  readAs: 'function',
  called: false,
  ...over,
});

test('the host gets the constants of nativeMocks and none of the call mocks', () => {
  const env = nativeValuesEnv({
    'RNFoo.isTablet': { value: false },
    'RNFoo.density': { ios: 3, android: 2.75 },
    'RNFoo.gone': { absent: ['android'] },
    'SNSMobileSDKModule.launch': { result: { success: true } },
  });
  assert.deepEqual(JSON.parse(env ?? ''), {
    'RNFoo.isTablet': { value: false },
    'RNFoo.density': { ios: 3, android: 2.75 },
    'RNFoo.gone': { absent: ['android'] },
  });
  assert.equal(nativeValuesEnv({ 'A.b': { result: 1 } }), undefined);
  assert.equal(nativeValuesEnv(undefined), undefined);
});

test('a value of null or false still counts as a constant', () => {
  assert.deepEqual(JSON.parse(nativeValuesEnv({ 'A.b': { value: null }, 'A.c': { ios: false } }) ?? ''), { 'A.b': { value: null }, 'A.c': { ios: false } });
});

test('what a host answers that is not a read is dropped', () => {
  assert.deepEqual(readsOf([fastsim('a'), { module: 'x' }, null, 'no']), [fastsim('a')]);
  assert.deepEqual(readsOf({ error: 'unknown command' }), []);
});

test('a property read in several cases is listed once, and called when any case called it', () => {
  const merged = mergeNativeValues([[fastsim('isTablet'), fastsim('hasNotch')], undefined, [fastsim('isTablet', { called: true })]]);
  assert.deepEqual(
    merged.map((r) => [r.property, r.called]),
    [
      ['hasNotch', false],
      ['isTablet', true],
    ],
  );
});

test('FastSim says what read as true and gives a snippet to paste, leaving out what the app called', () => {
  const lines = describeNativeValues([fastsim('isTablet'), fastsim('addCard', { called: true })]);
  const text = lines.join('\n');
  assert.match(
    text,
    /your app read RNFoo\.isTablet on ios, which Lynkeus FastSim does not know; it read as a function and was never called: a constant read as true/,
  );
  assert.doesNotMatch(text, /addCard/);
  assert.match(text, /"nativeMocks": \{\s+"RNFoo\.isTablet": \{\s+"value": null/);
});

test('headless says undefined, and a module it does not have gets no snippet line of its own', () => {
  const text = describeNativeValues([
    { module: 'RNFoo', property: 'isTablet', platform: 'android', host: 'headless', readAs: 'undefined' },
    { module: 'RNGone', platform: 'android', host: 'headless', readAs: 'undefined' },
  ]).join('\n');
  assert.match(text, /RNFoo\.isTablet on android, which headless does not know; it read as undefined/);
  assert.match(text, /the native module RNGone on android/);
  assert.doesNotMatch(text, /"RNGone/);
});

test('nothing to say when every read was called or none was made', () => {
  assert.deepEqual(describeNativeValues([]), []);
  assert.deepEqual(describeNativeValues([fastsim('addCard', { called: true })]), []);
});

test('the run file keeps the list', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-nv-'));
  const run = new RunFile(path.join(dir, 'run'), dir);
  run.finish({ platform: 'ios', nativeValues: [fastsim('isTablet')] });
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'run', 'run.json'), 'utf8')) as { nativeValues?: RunNativeValue[] };
  assert.deepEqual(manifest.nativeValues, [fastsim('isTablet')]);
  const bare = new RunFile(path.join(dir, 'bare'), dir);
  bare.finish({ nativeValues: [] });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'bare', 'run.json'), 'utf8')).nativeValues, undefined);
});

test('what the headless fallback answered is told once, grouped by module, with where a better answer goes', () => {
  const headless = (over: Partial<RunNativeValue>): RunNativeValue => ({
    module: 'KeyboardController',
    platform: 'ios',
    host: 'headless',
    readAs: 'function',
    ...over,
  });
  const reads = mergeNativeValues([
    [
      headless({ readAs: 'empty', package: 'react-native-keyboard-controller' }),
      headless({ property: 'setInputMode', called: true }),
      headless({ property: 'isVisible', called: false }),
    ],
    [headless({ property: 'setInputMode', called: true }), { module: 'RNOther', property: 'x', platform: 'ios', host: 'headless', readAs: 'undefined' }],
  ]);
  const lines = describeNativeValues(reads, { entry: 'cases/headless.tsx' });
  const text = lines.join('\n');
  assert.match(text, /^answered empty by default \(1 native module with no mock/);
  assert.match(text, /• KeyboardController \(react-native-keyboard-controller\): called setInputMode; read, never called: isVisible/);
  assert.match(text, /a better answer goes in cases\/headless\.tsx, where the app keeps its own mocks:/);
  assert.match(text, /jest\.mock\('react-native-keyboard-controller', \(\) => \(\{/);
  assert.match(text, /"nativeMocks": \{ "KeyboardController\.setInputMode": \{ "result": <what it resolves> \} \}/);
  // Said once per run, and the fallback's reads are not listed again as unknown constants.
  assert.equal(lines.filter((l) => l.includes('KeyboardController (')).length, 1);
  assert.doesNotMatch(text, /KeyboardController\.isVisible on ios/);
  assert.match(text, /RNOther\.x on ios, which headless does not know/);
  // Few lines, for an agent that reads them after every run.
  assert.equal(
    lines.findIndex((l) => l.startsWith('native values')),
    5,
  );
});

test('a module the cases config declares absent is not listed as one the host does not know', () => {
  const read = (module: string, platform: 'ios' | 'android'): RunNativeValue => ({ module, platform, host: 'headless', readAs: 'undefined' });
  const reads = [read('EXDevLauncher', 'ios'), read('EXOther', 'ios'), read('EXAndroidOnly', 'ios')];
  const text = describeNativeValues(reads, { nativeMocks: { EXDevLauncher: { absent: true }, EXAndroidOnly: { absent: ['android'] } } }).join('\n');
  assert.doesNotMatch(text, /EXDevLauncher/);
  assert.match(text, /EXOther/);
  assert.match(text, /EXAndroidOnly/);
  assert.deepEqual(describeNativeValues([read('EXDevLauncher', 'ios')], { nativeMocks: { EXDevLauncher: { absent: true } } }), []);
});

test('a member read and never called that the spec declares a method is not a finding; a declared constant is', () => {
  const specs = new Map([
    [
      'RNFoo',
      new Map([
        ['setFocusTo', 'method' as const],
        ['isTablet', 'constant' as const],
      ]),
    ],
  ]);
  assert.deepEqual(describeNativeValues([fastsim('setFocusTo')], { specs }), []);
  const text = describeNativeValues([fastsim('setFocusTo'), fastsim('isTablet')], { specs }).join('\n');
  assert.doesNotMatch(text, /setFocusTo/);
  assert.match(text, /RNFoo\.isTablet on ios, which Lynkeus FastSim does not know; its spec declares it a constant, and it read as true/);
  assert.doesNotMatch(text, /for a constant only/);
});

test('a member no spec covers is told as a constant or a reference, and its snippet is for a constant only', () => {
  const text = describeNativeValues([fastsim('hasNotch')]).join('\n');
  assert.match(text, /it read as a function and was never called: a constant read as true, or a method the app only took a reference to/);
  assert.doesNotMatch(text, /a constant with a wrong value/);
  assert.match(text, /for a constant only: a method given a value stops being callable/);
  assert.match(text, /"RNFoo\.hasNotch": \{\s+"value": null/);
});

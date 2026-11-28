import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { parseSpec, readNativeSpecs } from '../nativeSpecs.js';

// react-native-keyboard-controller's spec, as it ships.
const KEYBOARD = `import { TurboModuleRegistry } from "react-native";

import type { TurboModule } from "react-native";

export interface Spec extends TurboModule {
  readonly getConstants: () => {};

  // methods
  setInputMode(mode: number): void;
  setDefaultMode(): void;
  preload(): void;
  dismiss(keepFocus: boolean, animated: boolean): void;
  setFocusTo(direction: string): void;

  // event emitter
  addListener: (eventName: string) => void;
  removeListeners: (count: number) => void;
}

export default TurboModuleRegistry.get<Spec>("KeyboardController");
`;

test('a TypeScript spec gives its methods, and the constants getConstants returns', () => {
  const spec = parseSpec(KEYBOARD);
  assert.equal(spec?.module, 'KeyboardController');
  assert.equal(spec?.members.get('setFocusTo'), 'method');
  assert.equal(spec?.members.get('addListener'), 'method');
  const device = parseSpec(`import type {TurboModule} from 'react-native';
import {TurboModuleRegistry} from 'react-native';
export interface Spec extends TurboModule {
  getConstants(): { isTablet: boolean; model: string; density?: number };
  getBattery(): Promise<number>;
}
export default TurboModuleRegistry.getEnforcing<Spec>('RNDevice');`);
  assert.deepEqual(Object.fromEntries(device?.members ?? []), { isTablet: 'constant', model: 'constant', density: 'constant', getBattery: 'method' });
});

test('a Flow spec reads the same', () => {
  const spec = parseSpec(`// @flow
import type {TurboModule} from 'react-native/Libraries/TurboModule/RCTExport';
import * as TurboModuleRegistry from 'react-native/Libraries/TurboModule/TurboModuleRegistry';
export interface Spec extends TurboModule {
  +getConstants: () => {|
    isTesting: boolean,
    reactNativeVersion: {| major: number, minor: number |},
  |};
  +openSettings: () => void;
}
export default (TurboModuleRegistry.getEnforcing<Spec>('PlatformThing'): Spec);`);
  assert.deepEqual(Object.fromEntries(spec?.members ?? []), { isTesting: 'constant', reactNativeVersion: 'constant', openSettings: 'method' });
});

test('the specs are found where codegenConfig says, for the modules asked about', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-specs-'));
  const pkg = path.join(root, 'node_modules', 'react-native-keyboard-controller');
  fs.mkdirSync(path.join(pkg, 'src', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'react-native-keyboard-controller', codegenConfig: { jsSrcsDir: './src/specs' } }));
  fs.writeFileSync(path.join(pkg, 'src', 'specs', 'NativeKeyboardController.ts'), KEYBOARD);
  fs.mkdirSync(path.join(root, 'node_modules', '@scope', 'plain'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', '@scope', 'plain', 'package.json'), '{}');
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  assert.equal(readNativeSpecs(root, ['KeyboardController']).get('KeyboardController')?.get('setFocusTo'), 'method');
  assert.equal(readNativeSpecs(root, ['Other']).size, 0);
  assert.equal(readNativeSpecs(root, []).size, 0);
});

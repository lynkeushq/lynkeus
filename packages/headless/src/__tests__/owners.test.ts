import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from '@jest/globals';

import { owners, readerOf } from '../mocks/owners.js';

const pkg = (files: Record<string, string>) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-owners-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
};

describe('owners', () => {
  it('says a library owns a module its native code defines, and not one its JavaScript only checks for', () => {
    const dir = pkg({
      'android/src/main/java/KeyboardControllerModule.kt': 'const val NAME = "KeyboardController"',
      'build/Constants.js': 'if (NativeModules.EXDevLauncher) {}',
    });
    expect(owners.owns({ package: 'lib', dir }, 'KeyboardController')).toBe(true);
    expect(owners.owns({ package: 'lib', dir }, 'EXDevLauncher')).toBe(false);
  });

  it('counts a TurboModule spec in the JavaScript a package ships as its own', () => {
    const dir = pkg({ 'src/specs/NativeFoo.ts': "export default TurboModuleRegistry.getEnforcing<Spec>('RNFoo')" });
    expect(owners.owns({ package: 'lib', dir }, 'RNFoo')).toBe(true);
  });

  it('names the test file as the reader when no package read it', () => {
    expect(readerOf(path.resolve(__dirname, '..', '..'))).toEqual({ dir: path.resolve(__dirname, '..', '..') });
  });
});

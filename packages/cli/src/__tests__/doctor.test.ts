import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { doctor } from '../commands/doctor.js';

test('doctor reads what the code does, not what its comments say', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-doctor-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'demo' }));
  fs.mkdirSync(path.join(root, 'qa'));
  fs.writeFileSync(
    path.join(root, 'qa/headless.tsx'),
    "// App-specific mocks go here:\n//   jest.mock('some-native-package', () => ({}))\njest.mock('react-native-real', () => ({}))\n",
  );
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(
    path.join(root, 'src/bridge.ts'),
    "import { NativeModules } from 'react-native'\n/* NativeModules.OldBridge was removed */\n// NativeModules.Commented\nconst url = 'http://example.com' // NativeModules.Trailing is kept\nexport const live = NativeModules.LiveBridge\n",
  );
  const out = doctor(root, 'qa/headless.tsx').join('\n');
  assert.match(out, /react-native-real/);
  assert.doesNotMatch(out, /some-native-package/);
  assert.match(out, /LiveBridge.*src\/bridge\.ts:5/);
  assert.doesNotMatch(out, /OldBridge|Commented/);
});

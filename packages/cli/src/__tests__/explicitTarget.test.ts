import assert from 'node:assert/strict';
import { test } from 'node:test';

import { argvFor } from '../cases/runner.js';
import { driveCommands } from '../commands/drive.js';

const wait = driveCommands.find((c) => c.name === 'wait')!;

test('an explicit target: key reads a bare capitalized word as a text unless it is a known route', () => {
  const none = () => false;
  assert.deepEqual(argvFor(wait, { target: 'TextField', scroll: true }, none).slice(0, 2), ['wait', '"TextField"']);
  assert.deepEqual(argvFor(wait, { target: 'Settings' }, (r) => r === 'Settings').slice(0, 2), ['wait', 'Settings']);
  assert.deepEqual(argvFor(wait, { target: 'route:Home' }, none).slice(0, 2), ['wait', 'route:Home']);
  assert.deepEqual(argvFor(wait, { what: 'TextField' }, none).slice(0, 2), ['wait', 'TextField']);
});

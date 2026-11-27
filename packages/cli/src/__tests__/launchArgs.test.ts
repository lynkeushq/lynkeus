import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { simulatorArgv, simulatorCommand } from '../commands/device.js';
import { iosLaunchArgv, keepLaunchArgs, keptLaunchArgs } from '../device/launchArgs.js';

const isolate = () => {
  process.env.LYNKEUS_LAUNCH_ARGS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-launch-args-'));
};
const exec = async () => ({ stdout: '' });

test('os language on a Simulator keeps its launch arguments for every later launch of that app there', async () => {
  isolate();
  await simulatorCommand('ios', 'SIM-1', 'language', ['en-US'], 'com.example.shop', exec);
  const language = ['-AppleLanguages', '(en-US)', '-AppleLocale', 'en_US'];
  assert.deepEqual(keptLaunchArgs('SIM-1', 'com.example.shop'), language);
  // app.relaunch, the relaunch before a case and the foreground fallback all launch through this.
  assert.deepEqual(iosLaunchArgv('SIM-1', 'com.example.shop', true), [
    'simctl',
    'launch',
    '--terminate-running-process',
    'SIM-1',
    'com.example.shop',
    ...language,
  ]);
  assert.deepEqual(simulatorArgv('ios', 'SIM-1', 'appstate', ['active'], 'com.example.shop')[0]!.args, [
    'simctl',
    'launch',
    'SIM-1',
    'com.example.shop',
    ...language,
  ]);
  // Another app, or the same app on another Simulator, launches plain.
  assert.deepEqual(iosLaunchArgv('SIM-1', 'com.example.other', false), ['simctl', 'launch', 'SIM-1', 'com.example.other']);
  assert.deepEqual(iosLaunchArgv('SIM-2', 'com.example.shop', false), ['simctl', 'launch', 'SIM-2', 'com.example.shop']);
});

test('a later os language replaces the kept arguments, and an empty list forgets them', async () => {
  isolate();
  await simulatorCommand('ios', 'SIM-1', 'language', ['en-US'], 'com.example.shop', exec);
  await simulatorCommand('ios', 'SIM-1', 'language', ['de-DE'], 'com.example.shop', exec);
  assert.deepEqual(keptLaunchArgs('SIM-1', 'com.example.shop'), ['-AppleLanguages', '(de-DE)', '-AppleLocale', 'de_DE']);
  keepLaunchArgs('SIM-1', 'com.example.shop', []);
  assert.deepEqual(keptLaunchArgs('SIM-1', 'com.example.shop'), []);
});

test('a failed os language keeps nothing, and Android keeps the app locale itself', async () => {
  isolate();
  await assert.rejects(
    simulatorCommand('ios', 'SIM-1', 'language', ['en-US'], 'com.example.shop', async (_bin, args) => {
      if (args[1] === 'launch') throw new Error('no such app');
      return { stdout: '' };
    }),
  );
  assert.deepEqual(keptLaunchArgs('SIM-1', 'com.example.shop'), []);
  await simulatorCommand('android', 'emu', 'language', ['en-US'], 'com.example.shop', async () => ({ stdout: '34' }));
  assert.deepEqual(fs.readdirSync(process.env.LYNKEUS_LAUNCH_ARGS_DIR!), []);
});

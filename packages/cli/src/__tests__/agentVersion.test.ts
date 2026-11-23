import assert from 'node:assert/strict';
import { test } from 'node:test';

import { agentMismatch, appSwitched, CLI_VERSION, helloIdentity, devicePlatformMismatch } from '../device/agentVersion.js';

test('an agent of the CLI release is not worth a word', () => {
  assert.equal(agentMismatch({ agentVersion: CLI_VERSION }), undefined);
});

test('an agent of another release, or one too old to say, is named with how to line the two up', () => {
  assert.match(agentMismatch({ agentVersion: '0.1.9' }, '0.2.1')!, /lynkeus-agent 0\.1\.9, this CLI is Lynkeus 0\.2\.1.*lynkeus-agent@0\.2\.1/);
  assert.match(agentMismatch({}, '0.2.1')!, /too old to say its version, this CLI is Lynkeus 0\.2\.1/);
});

test('a different app taking the port over is told once, a relaunch of the same one is not', () => {
  const a = helloIdentity({ platform: 'ios', native: false, app: { name: 'lynkeus-main', runtime: 'headless' } });
  const b = helloIdentity({ platform: 'ios', native: false, app: { name: 'login-qa', runtime: 'headless' } });
  assert.equal(a, 'lynkeus-main (ios, headless)');
  assert.equal(appSwitched(undefined, a, 8790), undefined);
  assert.equal(appSwitched(a, a, 8790), undefined);
  assert.match(appSwitched(a, b, 8790)!, /port 8790: lynkeus-main \(ios, headless\) gave way to login-qa \(ios, headless\)/);
});

test('an iOS app answering for the Android device --device or LYNKEUS_DEVICE names is refused, with what to do', () => {
  const emulator = { id: 'emulator-5580', name: 'emulator-5580', platform: 'android' };
  const iosApp = { platform: 'ios', native: true, app: { name: 'lynkeus_sample', runtime: 'flutter' } };
  const told = devicePlatformMismatch(iosApp, emulator, { flag: 'emulator-5580' }, 8139);
  assert.match(told ?? '', /lynkeus_sample \(ios, flutter\)/);
  assert.match(told ?? '', /--device emulator-5580 is emulator-5580 \(emulator-5580\), an Android device/);
  assert.match(told ?? '', /LYNKEUS_PORT/);
  assert.match(devicePlatformMismatch(iosApp, emulator, { env: 'emulator-5580' }, 8139) ?? '', /LYNKEUS_DEVICE=emulator-5580 is/);
});

test('an Android device named only by the config does not refuse an iOS app: the config serves both platforms', () => {
  const emulator = { id: 'emulator-5554', name: 'emulator-5554', platform: 'android' };
  assert.equal(devicePlatformMismatch({ platform: 'ios', native: true }, emulator, {}, 8123), undefined);
});

test('a simulator named by the config, --device or LYNKEUS_DEVICE does not refuse an Android app, as Android ignores names that are no serial', () => {
  const simulator = { id: 'C098', name: 'iPhone 16', platform: 'ios' };
  const androidApp = { platform: 'android', native: true, app: { name: 'example', runtime: 'react-native' } };
  assert.equal(devicePlatformMismatch(androidApp, simulator, {}, 8123), undefined);
  assert.equal(devicePlatformMismatch(androidApp, simulator, { flag: 'iPhone 16' }, 8123), undefined);
  assert.equal(devicePlatformMismatch(androidApp, simulator, { env: 'iPhone 16' }, 8123), undefined);
});

test('the app the device names, a headless host, or a platform it does not say, are let through', () => {
  const emulator = { id: 'emulator-5580', name: 'emulator-5580', platform: 'android' };
  const given = { flag: 'emulator-5580' };
  assert.equal(devicePlatformMismatch({ platform: 'android', native: true }, emulator, given, 8123), undefined);
  assert.equal(devicePlatformMismatch({ platform: 'ios', native: false, app: { runtime: 'headless' } }, emulator, given, 8123), undefined);
  assert.equal(devicePlatformMismatch({ platform: 'ios', native: true, app: { runtime: 'flutter-headless' } }, emulator, given, 8123), undefined);
  assert.equal(devicePlatformMismatch({ platform: 'web', native: false }, emulator, given, 8123), undefined);
});

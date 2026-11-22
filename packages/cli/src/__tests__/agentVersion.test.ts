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

test('an app on the other platform than --device names is refused, with what to do', () => {
  const emulator = { id: 'emulator-5580', name: 'fastsim-e2e-android', platform: 'android' };
  const iosApp = { platform: 'ios', native: true, app: { name: 'lynkeus_sample', runtime: 'flutter' } };
  const told = devicePlatformMismatch(iosApp, emulator, 'emulator-5580', 8139);
  assert.match(told ?? '', /lynkeus_sample \(ios, flutter\)/);
  assert.match(told ?? '', /--device emulator-5580 is fastsim-e2e-android \(emulator-5580\), an Android device/);
  assert.match(told ?? '', /LYNKEUS_PORT/);
  const simulator = { id: 'C098', name: 'lynkeus-flutter', platform: 'ios' };
  assert.match(devicePlatformMismatch({ platform: 'android', native: true }, simulator, 'lynkeus-flutter', 8123) ?? '', /an iOS device/);
});

test('the app the device names, a headless host, or a platform it does not say, are let through', () => {
  const simulator = { id: 'C098', name: 'lynkeus-flutter', platform: 'ios' };
  assert.equal(devicePlatformMismatch({ platform: 'ios', native: true }, simulator, 'lynkeus-flutter', 8123), undefined);
  assert.equal(devicePlatformMismatch({ platform: 'android', native: false, app: { runtime: 'headless' } }, simulator, 'x', 8123), undefined);
  assert.equal(devicePlatformMismatch({ platform: 'web', native: false }, simulator, 'x', 8123), undefined);
});

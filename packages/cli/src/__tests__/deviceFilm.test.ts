import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import { runsInLaunchctl } from '../device/devices.js';
import { startRecorder } from '../device/platform.js';

const fakeRecorder = () => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null, kill: () => true });
  return child as unknown as ChildProcess & { stdout: PassThrough; stderr: PassThrough };
};

test('a recorder counts its film from when it says it began, not from when it was started', async () => {
  const child = fakeRecorder();
  const asked = Date.now();
  setTimeout(() => child.stderr.write('Recording started\n'), 150);
  const started = await startRecorder('xcrun', ['simctl'], /Recording started/, 5000, () => child);
  assert.ok(started.startedAt - asked >= 140, `counted from ${started.startedAt - asked} ms`);
  child.emit('exit', 0);
  assert.equal(await started.exited, 0);
});

test('a recorder that quits before it begins says why, and one that says nothing is taken as filming after the wait', async () => {
  const quits = fakeRecorder();
  setTimeout(() => {
    quits.stderr.write('Error: no booted device\n');
    quits.emit('exit', 1);
  }, 20);
  await assert.rejects(
    startRecorder('adb', ['-s', 'x', 'shell'], /Content area/, 5000, () => quits),
    /did not start filming: Error: no booted device/,
  );
  const silent = fakeRecorder();
  const t0 = Date.now();
  await startRecorder('adb', [], /Content area/, 100, () => silent);
  assert.ok(Date.now() - t0 >= 95);
  silent.emit('exit', 0);
});

test('launchctl tells a running app from one that exited, by its bundle id', () => {
  const listing = [
    'PID\tStatus\tLabel',
    '4512\t0\tUIKitApplication:com.example.shop[3f2a][rb-legacy]',
    '-\t0\tUIKitApplication:com.example.closed[91bc][rb-legacy]',
    '77\t0\tcom.apple.springboard',
  ].join('\n');
  assert.equal(runsInLaunchctl(listing, 'com.example.shop'), true);
  assert.equal(runsInLaunchctl(listing, 'com.example.closed'), false);
  assert.equal(runsInLaunchctl(listing, 'com.example'), false);
  assert.equal(runsInLaunchctl('', 'com.example.shop'), false);
});

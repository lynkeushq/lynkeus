import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { AgentServer } from 'lynkeus-client';
import type { HelloEvent } from 'lynkeus-protocol';

import { appDevice, type DeviceInfo, type Platform } from '../device/devices.js';
import { Device } from '../device/driver.js';

const sim = (id: string, name = 'iPhone 17 Pro'): DeviceInfo => ({ id, name, platform: 'ios', type: 'simulator', connected: true });
const emu = (id: string): DeviceInfo => ({ id, name: id, platform: 'android', type: 'emulator', connected: true });

const machine = (devices: DeviceInfo[], running: Record<string, string[]>) => ({
  list: async (platform: Platform) => devices.filter((d) => d.platform === platform),
  runs: async (d: DeviceInfo, appId: string) => (running[d.id] ?? []).includes(appId),
});

test('an Android app is filmed on its emulator even with an iOS Simulator booted beside it', async () => {
  const m = machine([sim('E92C'), emu('emulator-5554')], { E92C: ['com.shop'], 'emulator-5554': ['com.shop'] });
  assert.equal((await appDevice('android', 'com.shop', undefined, m)).id, 'emulator-5554');
  assert.equal((await appDevice('ios', 'com.shop', undefined, m)).id, 'E92C');
});

test('of several booted devices of one platform, the one the app runs on, never simply the first', async () => {
  const m = machine([sim('AAAA', 'iPhone 16'), sim('BBBB', 'iPhone 17 Pro'), emu('emulator-5554'), emu('emulator-5556')], {
    BBBB: ['com.shop'],
    'emulator-5556': ['com.shop'],
  });
  assert.equal((await appDevice('ios', 'com.shop', undefined, m)).id, 'BBBB');
  assert.equal((await appDevice('android', 'com.shop', undefined, m)).id, 'emulator-5556');
  // The device asked for wins among those running the app, and is no reason to film one that does not run it.
  const both = machine([sim('AAAA', 'iPhone 16'), sim('BBBB', 'iPhone 17 Pro')], { AAAA: ['com.shop'], BBBB: ['com.shop'] });
  assert.equal((await appDevice('ios', 'com.shop', '17 Pro', both)).id, 'BBBB');
  assert.equal((await appDevice('ios', 'com.shop', 'iPhone 16', m)).id, 'BBBB');
  // A simulator's name asked for while the app is on Android says nothing about which emulator.
  assert.equal((await appDevice('android', 'com.shop', 'iPhone 16', m)).id, 'emulator-5556');
});

test('without the app id, or with no device running it, the one asked for, else the first', async () => {
  const m = machine([sim('AAAA', 'iPhone 16'), sim('BBBB', 'iPhone 17 Pro')], {});
  assert.equal((await appDevice('ios', undefined, undefined, m)).id, 'AAAA');
  assert.equal((await appDevice('ios', 'com.shop', 'BBBB', m)).id, 'BBBB');
  await assert.rejects(appDevice('android', 'com.shop', undefined, m), /No Android device or emulator is up/);
});

const hello = (platform: string, appId = 'com.shop'): HelloEvent => ({ event: 'hello', protocolVersion: 1, platform, native: true, commands: [], appId });

const portServer = (first: HelloEvent) => {
  const server = Object.assign(new EventEmitter(), { hello: first as HelloEvent | null });
  const say = (next: HelloEvent) => {
    server.hello = next;
    server.emit('hello', next);
  };
  return { server: server as unknown as AgentServer, say };
};

test('when the Android app takes the port from the iOS one, the device is looked up again for it', async () => {
  const { server, say } = portServer(hello('ios'));
  const asked: string[] = [];
  const locate = async (said: HelloEvent) => {
    asked.push(said.platform);
    return said.platform === 'android' ? emu('emulator-5554') : sim('E92C');
  };
  const device = new Device({ id: 'headless', name: 'shop', platform: 'ios', type: 'simulator', connected: true }, { server, locate });
  assert.equal((await device.resolved()).id, 'E92C');
  // A reconnect of the same app keeps what was found.
  say(hello('ios'));
  assert.equal((await device.resolved()).id, 'E92C');
  say(hello('android'));
  assert.equal(device.info.platform, 'android');
  assert.equal((await device.resolved()).id, 'emulator-5554');
  assert.deepEqual(asked, ['ios', 'android']);
});

test('a screenshot after the switch goes through adb to the emulator, not simctl to the Simulator', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-locate-'));
  const log = path.join(dir, 'log');
  for (const tool of ['adb', 'xcrun']) fs.writeFileSync(path.join(dir, tool), `#!/bin/sh\necho "${tool} $*" >> "${log}"\nprintf png\n`, { mode: 0o755 });
  const saved = process.env.PATH;
  process.env.PATH = `${dir}:${saved}`;
  try {
    const { server, say } = portServer(hello('ios'));
    const locate = async (said: HelloEvent) => (said.platform === 'android' ? emu('emulator-5554') : sim('E92C'));
    const device = new Device({ id: 'headless', name: 'shop', platform: 'ios', type: 'simulator', connected: true }, { server, locate });
    say(hello('android'));
    await device.screenshot(path.join(dir, 'shot.png'));
    assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), ['adb -s emulator-5554 exec-out screencap -p']);
  } finally {
    process.env.PATH = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

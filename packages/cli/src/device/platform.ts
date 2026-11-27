import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import type { Platform } from './devices.js';

const run = promisify(execFile);

/** A film the OS is taking of a simulator or emulator: `startedAt` is when its first frame was, `stop` answers whether a film was kept. */
export type Recording = { file: string; startedAt: number; stop: () => Promise<boolean> };

export type PlatformLifecycle = {
  launchApp(deviceId: string, appId: string, fresh: boolean): Promise<void>;
  screenshot(deviceId: string, destination: string): Promise<void>;
  freezeChrome(deviceId: string): Promise<void>;
  recordVideo(deviceId: string, destination: string): Promise<Recording>;
};

/** Runs a recorder until `ready` says it has begun (or `readyMs` passes), and gives back the process and when. */
export const startRecorder = async (
  command: string,
  args: string[],
  ready: RegExp,
  readyMs: number,
  launch: (command: string, args: string[]) => ChildProcess = (c, a) => spawn(c, a, { stdio: ['ignore', 'pipe', 'pipe'] }),
): Promise<{ child: ChildProcess; startedAt: number; exited: Promise<number | null> }> => {
  const child = launch(command, args);
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
    child.once('error', () => resolve(-1));
  });
  let said = '';
  const begun = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(true), readyMs);
    const hear = (chunk: Buffer) => {
      said += chunk.toString();
      if (ready.test(said)) {
        clearTimeout(timer);
        resolve(true);
      }
    };
    child.stdout?.on('data', hear);
    child.stderr?.on('data', hear);
    void exited.then(() => {
      clearTimeout(timer);
      resolve(false);
    });
  });
  // A recorder left running past the CLI would film on, and simctl's film would never get its header.
  const orphaned = () => child.kill('SIGINT');
  process.once('exit', orphaned);
  void exited.then(() => process.off('exit', orphaned));
  if (!begun) throw new Error(`${command} ${args.slice(0, 3).join(' ')} did not start filming${said.trim() ? `: ${said.trim().split('\n').at(-1)}` : ''}`);
  return { child, startedAt: Date.now(), exited };
};

/** Asks a recorder to finish its file (SIGINT, as Ctrl-C does) and waits for it, killing it after `graceMs`. */
const finish = async (child: ChildProcess, exited: Promise<number | null>, graceMs = 10_000): Promise<void> => {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGINT');
  const late = setTimeout(() => child.kill('SIGKILL'), graceMs);
  await exited;
  clearTimeout(late);
};

const kept = (file: string) => (fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0) > 0;

const ios: PlatformLifecycle = {
  async launchApp(deviceId, appId, fresh) {
    const args = ['simctl', 'launch'];
    if (fresh) args.push('--terminate-running-process');
    await run('xcrun', [...args, deviceId, appId]);
  },

  async screenshot(deviceId, destination) {
    await run('xcrun', ['simctl', 'io', deviceId, 'screenshot', destination]);
  },

  // simctl writes the film's header only once it is stopped with SIGINT; it says "Recording started" once the first
  // frame is taken, which is the instant each step's second in the film counts from.
  async recordVideo(deviceId, destination) {
    const { child, startedAt, exited } = await startRecorder(
      'xcrun',
      ['simctl', 'io', deviceId, 'recordVideo', '--codec=h264', '--force', destination],
      /Recording started/,
      5000,
    );
    return {
      file: destination,
      startedAt,
      stop: async () => {
        await finish(child, exited);
        return kept(destination);
      },
    };
  },

  async freezeChrome(deviceId) {
    await run('xcrun', [
      'simctl',
      'status_bar',
      deviceId,
      'override',
      '--time',
      '9:41',
      '--batteryState',
      'charged',
      '--batteryLevel',
      '100',
      '--cellularMode',
      'active',
      '--cellularBars',
      '4',
      '--wifiMode',
      'active',
      '--wifiBars',
      '3',
    ]);
  },
};

const adb = (deviceId: string, args: string[]) => run('adb', ['-s', deviceId, ...args]);

const android: PlatformLifecycle = {
  async launchApp(deviceId, appId, fresh) {
    if (fresh) await adb(deviceId, ['shell', 'am', 'force-stop', appId]);
    // Monkey aborts on a device with no physical keys unless system-key events are turned off.
    await adb(deviceId, ['shell', 'monkey', '--pct-syskeys', '0', '-p', appId, '-c', 'android.intent.category.LAUNCHER', '1']);
  },

  async screenshot(deviceId, destination) {
    const { stdout } = await run('adb', ['-s', deviceId, 'exec-out', 'screencap', '-p'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
    await writeFile(destination, stdout);
  },

  // screenrecord films on the device and stops by itself after 3 minutes. Killing adb would leave its file without
  // the index a player needs: it is told to stop on the device, where it finishes the file, which is then pulled.
  async recordVideo(deviceId, destination) {
    const remote = `/sdcard/lynkeus-${randomBytes(6).toString('hex')}.mp4`;
    const { child, startedAt, exited } = await startRecorder('adb', ['-s', deviceId, 'shell', 'screenrecord', '--verbose', '--bit-rate', '4000000', remote], /Content area|Configuring|encoder/i, 1500);
    return {
      file: destination,
      startedAt,
      stop: async () => {
        await adb(deviceId, ['shell', 'pkill', '-INT', 'screenrecord']).catch(() => undefined);
        await finish(child, exited);
        const pulled = await adb(deviceId, ['pull', remote, destination]).then(
          () => kept(destination),
          () => false,
        );
        await adb(deviceId, ['shell', 'rm', '-f', remote]).catch(() => undefined);
        return pulled;
      },
    };
  },

  async freezeChrome(deviceId) {
    await adb(deviceId, ['shell', 'settings', 'put', 'global', 'sysui_demo_allowed', '1']);
    const demo = (args: string[]) => adb(deviceId, ['shell', 'am', 'broadcast', '-a', 'com.android.systemui.demo', ...args]);
    await demo(['-e', 'command', 'enter']);
    await demo(['-e', 'command', 'clock', '-e', 'hhmm', '0941']);
    await demo(['-e', 'command', 'battery', '-e', 'level', '100', '-e', 'plugged', 'false']);
    await demo(['-e', 'command', 'network', '-e', 'wifi', 'show', '-e', 'level', '4']);
    await demo(['-e', 'command', 'notifications', '-e', 'visible', 'false']);
  },
};

export const lifecycleFor = (platform: Platform): PlatformLifecycle => (platform === 'ios' ? ios : android);

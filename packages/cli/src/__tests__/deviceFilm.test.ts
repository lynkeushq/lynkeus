import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import { runsInLaunchctl } from '../device/devices.js';
import { checkFilm } from '../cases/film.js';
import { mp4Of } from '../cases/__tests__/mp4.js';
import { recordAndroid, startRecorder } from '../device/platform.js';

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

/**
 * An emulator as adb sees it: screenrecord runs there under the pid its shell echoes, writes its film's index only
 * once SIGINT ends it (300 ms later here), and loses the index when the adb client is killed first (the shell hangs up).
 */
const fakeEmulator = () => {
  const files = new Map<string, Buffer>();
  const running = new Map<string, { remote: string; child: ChildProcess & { exitCode: number | null }; started: number }>();
  const log: string[] = [];
  let nextPid = 4000;
  const end = (pid: string, complete: boolean) => {
    const proc = running.get(pid);
    if (!proc) return;
    running.delete(pid);
    files.set(proc.remote, complete ? mp4Of(Math.max(0.1, (Date.now() - proc.started) / 1000)) : Buffer.from('mdat-without-index'));
    log.push(`${pid} ${complete ? 'finished' : 'cut off'}`);
    proc.child.exitCode = 0;
    proc.child.emit('exit', 0);
  };
  const launch = (_command: string, args: string[]) => {
    const pid = String(nextPid++);
    const remote = /(\/sdcard\/\S+\.mp4)/.exec(args.at(-1) ?? '')![1]!;
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null,
      kill: () => {
        log.push(`adb client killed while ${running.has(pid) ? 'recording' : 'done'}`);
        end(pid, false);
        return true;
      },
    }) as unknown as ChildProcess & { exitCode: number | null; stdout: PassThrough };
    running.set(pid, { remote, child, started: Date.now() });
    log.push(`start ${pid}`);
    setTimeout(() => child.stdout.write(`lynkeus-pid:${pid}\nContent area is 1080x2400 at offset x=0 y=0\n`), 5);
    return child;
  };
  const adb = async (args: string[]): Promise<{ stdout: string }> => {
    if (args[0] === 'shell' && args[1] === 'kill' && args[2] === '-INT') {
      log.push(`SIGINT ${args[3]}`);
      setTimeout(() => end(args[3]!, true), 300);
      return { stdout: '' };
    }
    if (args[0] === 'shell' && args[1] === 'pidof') {
      if (running.size === 0) throw new Error('exit 1');
      return { stdout: `${[...running.keys()].join(' ')}\n` };
    }
    if (args[0] === 'pull') {
      const body = files.get(args[1]!);
      if (!body) throw new Error('no such file');
      log.push(`pull ${running.size ? 'while recording' : 'after it ended'}`);
      fs.writeFileSync(args[2]!, body);
      return { stdout: '' };
    }
    if (args[0] === 'shell' && args[1] === 'rm') {
      files.delete(args[3]!);
      return { stdout: '' };
    }
    throw new Error(`unexpected adb ${args.join(' ')}`);
  };
  return { files, running, log, launch, adb, expire: (pid: string) => end(pid, true) };
};

const filmDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-android-film-'));

test('an Android film is stopped on the device and waited for before it is pulled, so it keeps its index and plays', async () => {
  const emulator = fakeEmulator();
  const file = path.join(filmDir(), 'video.mp4');
  const recording = await recordAndroid('emulator-5554', file, { adb: emulator.adb, launch: emulator.launch, pollMs: 20 });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await recording.stop(), true);
  assert.ok('seconds' in checkFilm(file), JSON.stringify(checkFilm(file)));
  assert.deepEqual(emulator.log, ['start 4000', 'SIGINT 4000', '4000 finished', 'pull after it ended']);
  assert.equal(emulator.files.size, 0, 'the film is removed from the device');
});

test('a case longer than screenrecord’s 3 minutes films in segments that are joined, or kept side by side when they cannot be', async () => {
  for (const joins of [true, false]) {
    const emulator = fakeEmulator();
    const dir = filmDir();
    const file = path.join(dir, 'video.mp4');
    let joined: string[] = [];
    const recording = await recordAndroid('emulator-5554', file, {
      adb: emulator.adb,
      launch: emulator.launch,
      pollMs: 20,
      join: async (parts, destination) => {
        joined = parts.map((p) => path.basename(p));
        if (joins) fs.writeFileSync(destination, mp4Of(181));
        return joins;
      },
    });
    await new Promise((r) => setTimeout(r, 30));
    // The time limit ends the first segment on the device; the next starts at once.
    emulator.expire('4000');
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual([...emulator.running.keys()], ['4001']);
    assert.equal(await recording.stop(), true);
    assert.deepEqual(joined, ['video.segment1.mp4', 'video.segment2.mp4']);
    assert.ok(emulator.log.indexOf('4001 finished') < emulator.log.indexOf('pull after it ended'));
    assert.ok(!emulator.log.some((l) => l.startsWith('adb client killed while recording')));
    if (joins) {
      assert.deepEqual(fs.readdirSync(dir), ['video.mp4']);
      assert.equal(recording.notes, undefined);
    } else {
      assert.deepEqual(fs.readdirSync(dir).sort(), ['video.2.mp4', 'video.mp4']);
      assert.match(recording.notes?.[0] ?? '', /in 2 parts of up to 3 minutes .*not joined \(no ffmpeg\)/);
    }
  }
});

test('a screenrecord that will not end in time is cut off and its film reported as one that does not play', async () => {
  const emulator = fakeEmulator();
  const file = path.join(filmDir(), 'video.mp4');
  const stuck = { ...emulator, adb: async (args: string[]) => (args[1] === 'kill' ? { stdout: '' } : emulator.adb(args)) };
  const recording = await recordAndroid('emulator-5554', file, { adb: stuck.adb, launch: emulator.launch, pollMs: 20, stopMs: 150 });
  await new Promise((r) => setTimeout(r, 30));
  const t0 = Date.now();
  assert.equal(await recording.stop(), false);
  assert.ok(Date.now() - t0 < 2000);
  assert.match(JSON.stringify(checkFilm(file)), /no index \(moov\)/);
});

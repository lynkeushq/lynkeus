import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import { type Platform, runsInLaunchctl } from './devices.js';
import { checkFilm } from '../cases/film.js';
import { iosLaunchArgv } from './launchArgs.js';

const run = promisify(execFile);

/**
 * A film the OS is taking of a simulator or emulator: `startedAt` is when its first frame was, `stop` answers whether a
 * film was kept. `notes`, once stopped, says what a reader of the film should know (it is in several files).
 */
export type Recording = { file: string; startedAt: number; stop: () => Promise<boolean>; notes?: string[] };

export type PlatformLifecycle = {
  launchApp(deviceId: string, appId: string, fresh: boolean): Promise<void>;
  /** Whether the app's process runs on the device now (it may be loading its JavaScript), whatever its agent says. */
  running(deviceId: string, appId: string): Promise<boolean>;
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
): Promise<{ child: ChildProcess; startedAt: number; exited: Promise<number | null>; output: () => string }> => {
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
  return { child, startedAt: Date.now(), exited, output: () => said };
};

/** Asks a recorder to finish its file (SIGINT, as Ctrl-C does) and waits for it, killing it after `graceMs`. */
const finish = async (child: ChildProcess, exited: Promise<number | null>, graceMs = 10_000): Promise<void> => {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGINT');
  const late = setTimeout(() => child.kill('SIGKILL'), graceMs);
  await exited;
  clearTimeout(late);
};

const kept = (file: string) => (fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0) > 0;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Joins films into one with ffmpeg's concat demuxer, without encoding again; false when ffmpeg is not there or fails. */
const ffmpegJoin = async (parts: string[], destination: string): Promise<boolean> => {
  const list = `${destination}.parts.txt`;
  fs.writeFileSync(list, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
  try {
    await run('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', destination]);
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(list, { force: true });
  }
};

export type AndroidFilmDeps = {
  /** `adb -s <device> …`, answering its stdout; rejects when the command exits non-zero. */
  adb: (args: string[]) => Promise<{ stdout: string }>;
  launch?: (command: string, args: string[]) => ChildProcess;
  /** Joins the segments of a film longer than screenrecord's 3 minutes into `destination`; false when it cannot. */
  join?: (parts: string[], destination: string) => Promise<boolean>;
  /** How long a stopped screenrecord may take to finish its file, and how often it is asked whether it has. */
  stopMs?: number;
  pollMs?: number;
};

// screenrecord stops by itself at 3 minutes (its longest --time-limit): a longer case films in segments.
const SEGMENT_S = 180;

/**
 * Films an Android emulator or phone with screenrecord, which writes the film on the device. It writes the index a
 * player needs (moov) only as it ends, so it is stopped there with SIGINT and waited for (its pid gone from `pidof`)
 * before the file is pulled; stopping adb first hung up the shell and cut screenrecord off before its index (trial
 * run 9: 12 of 12 films without one). A segment that reaches the 3-minute limit is followed by the next, and the
 * segments are joined once pulled.
 */
export const recordAndroid = async (deviceId: string, destination: string, deps: AndroidFilmDeps): Promise<Recording> => {
  const { adb } = deps;
  const stopMs = deps.stopMs ?? 10_000;
  const pollMs = deps.pollMs ?? 200;
  type Segment = { remote: string; pid?: string; child: ChildProcess; exited: Promise<number | null>; done: boolean };
  const segments: Segment[] = [];
  let stopping = false;
  let chain: Promise<unknown> = Promise.resolve();
  const startSegment = async (): Promise<Segment> => {
    const remote = `/sdcard/lynkeus-${randomBytes(6).toString('hex')}.mp4`;
    // exec keeps the shell's pid, so the one echoed is screenrecord's own.
    const script = `echo lynkeus-pid:$$; exec screenrecord --verbose --time-limit ${SEGMENT_S} --bit-rate 4000000 ${remote}`;
    const started = await startRecorder('adb', ['-s', deviceId, 'shell', script], /Content area|Configuring|encoder/i, 1500, deps.launch);
    const pid = /lynkeus-pid:(\d+)/.exec(started.output())?.[1];
    const segment: Segment = { remote, ...(pid ? { pid } : {}), child: started.child, exited: started.exited, done: false };
    segments.push(segment);
    void started.exited.then(() => {
      segment.done = true;
      if (!stopping) chain = startSegment().catch(() => undefined);
    });
    return segment;
  };
  const first = await startSegment();
  const startedAt = Date.now();
  const alive = async (segment: Segment): Promise<boolean> => {
    // pidof exits 1 when nothing has that name: no screenrecord at all.
    const { stdout } = await adb(['shell', 'pidof', 'screenrecord']).catch(() => ({ stdout: '' }));
    const pids = stdout.trim().split(/\s+/).filter(Boolean);
    return segment.pid ? pids.includes(segment.pid) : pids.length > 0;
  };
  const recording: Recording = {
    file: destination,
    startedAt,
    stop: async () => {
      stopping = true;
      await chain;
      const last = segments.at(-1) ?? first;
      if (!last.done) {
        await adb(['shell', ...(last.pid ? ['kill', '-INT', last.pid] : ['pkill', '-INT', 'screenrecord'])]).catch(() => undefined);
        for (const until = Date.now() + stopMs; Date.now() < until && (await alive(last)); ) await sleep(pollMs);
      }
      // adb ends with the device's process; one still there now is only a client left open.
      await finish(last.child, last.exited, 3000);
      const pulled: string[] = [];
      for (const [i, segment] of segments.entries()) {
        const local = segments.length === 1 ? destination : destination.replace(/\.mp4$/, `.segment${i + 1}.mp4`);
        if (
          await adb(['pull', segment.remote, local]).then(
            () => kept(local),
            () => false,
          )
        )
          pulled.push(local);
        await adb(['shell', 'rm', '-f', segment.remote]).catch(() => undefined);
      }
      if (pulled.length > 1) {
        if (await (deps.join ?? ffmpegJoin)(pulled, destination)) for (const part of pulled) fs.rmSync(part, { force: true });
        else {
          // Not joined: the first segment is the film the steps' seconds count in, the others sit beside it.
          fs.renameSync(pulled[0]!, destination);
          const rest = pulled.slice(1).map((part, i) => {
            const named = destination.replace(/\.mp4$/, `.${i + 2}.mp4`);
            fs.renameSync(part, named);
            return named;
          });
          recording.notes = [
            `the film is in ${pulled.length} parts of up to 3 minutes (screenrecord's limit), not joined (no ffmpeg): ${destination} and ${rest.join(', ')}`,
          ];
        }
      } else if (pulled.length === 1 && pulled[0] !== destination) fs.renameSync(pulled[0]!, destination);
      return 'seconds' in checkFilm(destination);
    },
  };
  return recording;
};

const ios: PlatformLifecycle = {
  async launchApp(deviceId, appId, fresh) {
    await run('xcrun', iosLaunchArgv(deviceId, appId, fresh));
  },

  async running(deviceId, appId) {
    const { stdout } = await run('xcrun', ['simctl', 'spawn', deviceId, 'launchctl', 'list'], { maxBuffer: 8 * 1024 * 1024 });
    return runsInLaunchctl(stdout, appId);
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

  // pidof exits 1 when no process has that name.
  async running(deviceId, appId) {
    return adb(deviceId, ['shell', 'pidof', appId]).then(
      ({ stdout }) => stdout.trim().length > 0,
      () => false,
    );
  },

  async screenshot(deviceId, destination) {
    const { stdout } = await run('adb', ['-s', deviceId, 'exec-out', 'screencap', '-p'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
    await writeFile(destination, stdout);
  },

  async recordVideo(deviceId, destination) {
    return recordAndroid(deviceId, destination, { adb: (args) => adb(deviceId, args) });
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

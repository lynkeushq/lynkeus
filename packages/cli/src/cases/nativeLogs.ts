import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

import type { DeviceInfo } from '../device/devices.js';
import type { LogLine } from './runner.js';

const run = promisify(execFile);
const KEEP = 5000;
const LONG = 4000;

/** The app's native log while a run goes on: `take` hands over what came since the last take. */
export type NativeLogs = { take: () => LogLine[]; stop: () => void };

const cut = (text: string) => (text.length > LONG ? `${text.slice(0, LONG)}…` : text);

// `log stream --style ndjson`: one JSON object a line. React Native's own console lines (category javascript)
// come from the agent already, with their stacks.
export const parseOsLog = (line: string): LogLine | undefined => {
  if (!line.startsWith('{')) return undefined;
  let e: { timestamp?: string; messageType?: string; eventMessage?: string; subsystem?: string; category?: string };
  try {
    e = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!e.eventMessage || !e.timestamp) return undefined;
  if (e.subsystem === 'com.facebook.react.log' && e.category === 'javascript') return undefined;
  // "2026-10-16 14:55:01.123456-0300" → an instant.
  const at = Date.parse(
    e.timestamp
      .replace(' ', 'T')
      .replace(/(\.\d{3})\d*/, '$1')
      .replace(/([+-]\d\d)(\d\d)$/, '$1:$2'),
  );
  if (Number.isNaN(at)) return undefined;
  const type = (e.messageType ?? '').toLowerCase();
  const level = type === 'error' || type === 'fault' ? 'error' : type === 'debug' ? 'debug' : 'info';
  return { at, level, source: 'native', text: cut(e.eventMessage) };
};

// `logcat -v epoch,uid`: "  1760637301.123  10123  4521  4533 E Tag: message". ReactNativeJS repeats the console.
export const parseLogcat = (line: string, uid: string): LogLine | undefined => {
  const m = /^\s*(\d+\.\d+)\s+(\S+)\s+\d+\s+\d+\s+([VDIWEF])\s+([^:]*?)\s*:\s?(.*)$/.exec(line);
  if (!m || m[2] !== uid) return undefined;
  const [, seconds, , priority, tag, message] = m;
  if (tag === 'ReactNativeJS') return undefined;
  const level = priority === 'E' || priority === 'F' ? 'error' : priority === 'W' ? 'warn' : priority === 'I' ? 'info' : 'debug';
  return { at: Math.round(Number(seconds) * 1000), level, source: 'native', text: cut(`${tag}: ${message}`) };
};

const executable = async (udid: string, bundleId: string): Promise<string | undefined> => {
  const { stdout } = await run('xcrun', ['simctl', 'appinfo', udid, bundleId]);
  return /CFBundleExecutable = "?([^";\n]+)"?;/.exec(stdout)?.[1];
};

const androidUid = async (serial: string, appId: string): Promise<string | undefined> => {
  const { stdout } = await run('adb', ['-s', serial, 'shell', 'cmd', 'package', 'list', 'packages', '-U', appId]);
  const line = stdout.split('\n').find((l) => l.startsWith(`package:${appId} `));
  return line ? /uid:(\d+)/.exec(line)?.[1] : undefined;
};

/**
 * Streams the app's native log on a simulator or an emulator. A device lynkeus cannot read a log from, or an app it
 * cannot find there, gives none: the run goes on without it.
 */
export const startNativeLogs = async (device: DeviceInfo, appId: string): Promise<NativeLogs | undefined> => {
  if (device.type === 'physical' || device.id === 'headless') return undefined;
  const lines: LogLine[] = [];
  let child: ChildProcess;
  let parse: (line: string) => LogLine | undefined;
  try {
    if (device.platform === 'ios') {
      const name = await executable(device.id, appId);
      if (!name) return undefined;
      // Inside the app's process every Apple framework logs too, thousands of lines a launch: keep its errors, and
      // the rest only from the app's own code (NSLog and print have no subsystem) and React Native's native side.
      const own = `subsystem == "" OR subsystem BEGINSWITH "${appId.replaceAll('"', '')}" OR subsystem BEGINSWITH "com.facebook.react"`;
      const predicate = `process == "${name.replaceAll('"', '')}" AND (messageType == error OR messageType == fault OR ${own})`;
      child = spawn('xcrun', ['simctl', 'spawn', device.id, 'log', 'stream', '--style', 'ndjson', '--level', 'default', '--predicate', predicate], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      parse = parseOsLog;
    } else {
      const uid = await androidUid(device.id, appId);
      if (!uid) return undefined;
      // From now on: `-T 1` starts at the newest line instead of replaying the buffer.
      child = spawn('adb', ['-s', device.id, 'logcat', '-v', 'epoch,uid', '-T', '1'], { stdio: ['ignore', 'pipe', 'ignore'] });
      parse = (line) => parseLogcat(line, uid);
    }
  } catch {
    return undefined;
  }
  let rest = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    const text = rest + chunk.toString('utf8');
    const parts = text.split('\n');
    rest = parts.pop() ?? '';
    for (const part of parts) {
      const line = parse(part);
      if (!line) continue;
      lines.push(line);
      if (lines.length > KEEP) lines.shift();
    }
  });
  child.on('error', () => undefined);
  return {
    take: () => lines.splice(0, lines.length),
    stop: () => {
      child.kill();
    },
  };
};

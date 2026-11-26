import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export type Platform = 'ios' | 'android';

export type DeviceInfo = {
  id: string;
  name: string;
  platform: Platform;
  type: 'simulator' | 'emulator' | 'physical';
  connected: boolean;
};

export const bootedSimulators = async (): Promise<DeviceInfo[]> => {
  // No Xcode (Linux, CI) means no simulators, not a crash: the app may be hosted headless.
  let stdout: string;
  try {
    ({ stdout } = await run('xcrun', ['simctl', 'list', 'devices', 'booted', '-j']));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const parsed = JSON.parse(stdout) as { devices: Record<string, { udid: string; name: string; state: string }[]> };
  return Object.values(parsed.devices)
    .flat()
    .filter((d) => d.state === 'Booted')
    .map((d) => ({ id: d.udid, name: d.name, platform: 'ios', type: 'simulator', connected: true }));
};

/** The serials `adb devices` lists as ready, in its order; none when there is no adb to ask. */
export const parseAdbDevices = (stdout: string): DeviceInfo[] =>
  stdout
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(([serial, state]) => serial && state === 'device')
    .map(([serial]) => ({ id: serial!, name: serial!, platform: 'android', type: serial!.startsWith('emulator-') ? 'emulator' : 'physical', connected: true }));

export const androidDevices = async (): Promise<DeviceInfo[]> => {
  try {
    return parseAdbDevices((await run('adb', ['devices'])).stdout);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
};

/**
 * Gives each Android device and emulator the driver's port at its own localhost. A phone on USB cannot reach this
 * machine at 10.0.2.2 as the emulator can, and an emulator whose network blocks 10.0.2.2 (or an app whose network
 * security config does) reaches nothing either; `localhost` after `adb reverse` works on both, and the agent tries it
 * next. The serials it reversed; none, quietly, without adb or a device.
 */
export const reverseAndroid = async (port: number, devices?: DeviceInfo[]): Promise<string[]> => {
  const list = devices ?? (await androidDevices().catch(() => []));
  const done: string[] = [];
  // One after the other: a few milliseconds each, and adb's own server takes them in turn anyway.
  for (const d of list.filter((one) => one.platform === 'android')) {
    const reversed = await run('adb', ['-s', d.id, 'reverse', `tcp:${port}`, `tcp:${port}`]).then(
      () => true,
      () => false,
    );
    if (reversed) done.push(d.id);
  }
  return done;
};

/** The Android device an app that said it runs on Android is on: the one asked for, or the first that is up. */
export const pickAndroidDevice = async (wanted?: string): Promise<DeviceInfo> => {
  const devices = await androidDevices();
  const id = wanted ?? process.env.LYNKEUS_DEVICE;
  // A name meant for a simulator (the config's `device` when both platforms are driven) is not a reason to fail here.
  const device = (id ? devices.find((d) => d.id === id) : undefined) ?? devices[0];
  if (!device) throw new Error('No Android device or emulator is up (adb devices lists none).');
  return device;
};

export const HEADLESS_HOST: DeviceInfo = { id: 'headless', name: 'headless host', platform: 'ios', type: 'simulator', connected: true };

export const pickAgentDevice = async (wanted?: string): Promise<DeviceInfo> => {
  const devices = await bootedSimulators();
  const id = wanted ?? process.env.LYNKEUS_DEVICE;
  const device = id ? devices.find((d) => d.id === id || d.name.includes(id)) : devices[0];
  if (!device && id) {
    // An adb serial names an Android device; which platform the app is on is only known once it dials in.
    const android = (await androidDevices()).find((d) => d.id === id);
    if (android) return android;
  }
  if (!device) {
    // A headless host dials the driver itself: nothing to boot or attach to.
    if (!id && devices.length === 0) return HEADLESS_HOST;
    throw new Error(id ? `No booted simulator matching "${id}".` : 'No booted simulator. Boot one first.');
  }
  return device;
};

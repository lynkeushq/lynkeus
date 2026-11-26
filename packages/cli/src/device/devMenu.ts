/**
 * expo-dev-client opens its dev menu's onboarding sheet over the app on the first launch of a development build, and
 * keeps a floating button over it after that. Both are native views outside React Native: the agent sees every
 * control as covered and cannot press the sheet's own buttons. On a simulator or emulator Lynkeus marks the
 * onboarding finished and the button hidden in the dev menu's own preferences, which it reads at launch.
 */
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import type { DeviceInfo } from './devices.js';

const run = promisify(execFile);

/** Whether the app is a development build with expo-dev-client, the package that brings the dev menu. */
export const usesDevClient = (root: string): boolean => {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return !!(manifest.dependencies?.['expo-dev-client'] ?? manifest.devDependencies?.['expo-dev-client']);
  } catch {
    return false;
  }
};

const read = (file: string): string => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

/** A literal identifier from text that may compute it (`bundleIdentifier: 'com.x'` in app.config.ts); none for `$(VAR)` or an expression. */
const literal = (text: string, key: RegExp): string | undefined => {
  const found = new RegExp(`${key.source}['"]?\\s*[:=]?\\s*(['"]?)([A-Za-z][\\w-]*(?:\\.[\\w-]+)+)\\1\\s*[,;]?\\s*$`, 'm').exec(text);
  return found?.[2];
};

/**
 * The app's bundle identifier and Android package: the configured `app` for both, else what Expo's app.json or
 * app.config says, else the native projects.
 */
export const appIdsOf = (root: string, configured?: string): { ios?: string; android?: string } => {
  if (configured) return { ios: configured, android: configured };
  let json: { expo?: Record<string, unknown> } & Record<string, unknown> = {};
  try {
    json = JSON.parse(read(path.join(root, 'app.json')) || '{}') as typeof json;
  } catch {}
  const expo = (json.expo ?? json) as { ios?: { bundleIdentifier?: string }; android?: { package?: string } };
  const config = ['app.config.ts', 'app.config.js', 'app.config.mjs', 'app.config.cjs'].map((f) => read(path.join(root, f))).join('\n');
  const pbxproj = (() => {
    try {
      const project = fs.readdirSync(path.join(root, 'ios')).find((f) => f.endsWith('.xcodeproj'));
      return project ? read(path.join(root, 'ios', project, 'project.pbxproj')) : '';
    } catch {
      return '';
    }
  })();
  const gradle = read(path.join(root, 'android', 'app', 'build.gradle')) || read(path.join(root, 'android', 'app', 'build.gradle.kts'));
  return {
    ios: expo.ios?.bundleIdentifier ?? literal(config, /bundleIdentifier/) ?? literal(pbxproj, /PRODUCT_BUNDLE_IDENTIFIER\s*=/),
    android: expo.android?.package ?? literal(config, /\bpackage/) ?? literal(gradle, /applicationId/),
  };
};

export type DevMenuOutcome = 'done' | 'already' | 'not installed' | 'failed';

const IOS_ONBOARDED = 'EXDevMenuIsOnboardingFinished';
const IOS_FAB = 'EXDevMenuShowFloatingActionButton';

const finishOnSimulator = async (udid: string, bundle: string): Promise<DevMenuOutcome> => {
  try {
    await run('xcrun', ['simctl', 'get_app_container', udid, bundle, 'data']);
  } catch {
    return 'not installed';
  }
  const value = await run('xcrun', ['simctl', 'spawn', udid, 'defaults', 'read', bundle, IOS_ONBOARDED]).then(
    (r) => r.stdout.trim(),
    () => '',
  );
  if (value === '1') return 'already';
  try {
    await run('xcrun', ['simctl', 'spawn', udid, 'defaults', 'write', bundle, IOS_ONBOARDED, '-bool', 'YES']);
    await run('xcrun', ['simctl', 'spawn', udid, 'defaults', 'write', bundle, IOS_FAB, '-bool', 'NO']);
    return 'done';
  } catch {
    return 'failed';
  }
};

// expo-dev-menu's Android preferences (DevMenuPreferences.kt): one SharedPreferences file, a key per property.
export const ANDROID_PREFS = 'shared_prefs/expo.modules.devmenu.sharedpreferences.xml';

/** The preferences file with the onboarding finished and the floating button hidden, keeping every other entry. */
export const onboardedPrefs = (xml: string): string => {
  const kept = [...xml.matchAll(/^\s*(<(boolean|string|int|long|float|set)\b[^>]*name="([^"]+)"[\s\S]*?(\/>|<\/\2>))/gm)]
    .filter((m) => m[3] !== 'isOnboardingFinished' && m[3] !== 'showFab')
    .map((m) => `    ${m[1]}`);
  return [
    "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>",
    '<map>',
    ...kept,
    '    <boolean name="isOnboardingFinished" value="true" />',
    '    <boolean name="showFab" value="false" />',
    '</map>',
    '',
  ].join('\n');
};

const adbWrite = (serial: string, args: string[], input: string): Promise<boolean> =>
  new Promise((resolve) => {
    const child = spawn('adb', ['-s', serial, ...args], { stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
    child.stdin.end(input);
  });

const finishOnEmulator = async (serial: string, pkg: string): Promise<DevMenuOutcome> => {
  // run-as reaches only a debuggable build's files, which a development build is.
  const current = await run('adb', ['-s', serial, 'shell', 'run-as', pkg, 'cat', ANDROID_PREFS]).then(
    (r) => ({ ok: true, text: r.stdout }),
    (error: { stdout?: string; stderr?: string }) => ({ ok: false, text: `${error.stdout ?? ''}${error.stderr ?? ''}` }),
  );
  if (!current.ok && /unknown package|not debuggable|is unknown/i.test(current.text)) return 'not installed';
  const xml = current.ok ? current.text : '';
  if (/name="isOnboardingFinished" value="true"/.test(xml) && /name="showFab" value="false"/.test(xml)) return 'already';
  const wrote = await adbWrite(serial, ['shell', `run-as ${pkg} sh -c 'mkdir -p shared_prefs && cat > ${ANDROID_PREFS}'`], onboardedPrefs(xml));
  return wrote ? 'done' : 'failed';
};

/** Marks the dev menu's onboarding finished for the app on a simulator or emulator; a phone is left as it is. */
export const finishDevMenuOnboarding = async (device: DeviceInfo, ids: { ios?: string; android?: string }): Promise<DevMenuOutcome | undefined> => {
  if (device.type === 'physical' || device.id === 'headless') return undefined;
  const id = device.platform === 'ios' ? ids.ios : ids.android;
  if (!id) return undefined;
  return device.platform === 'ios' ? finishOnSimulator(device.id, id) : finishOnEmulator(device.id, id);
};

/** What `status` says for each simulator and emulator: nothing for a device where the app is not installed or it was already done. */
export const prepareDevMenu = async (root: string, configured: string | undefined, devices: DeviceInfo[]): Promise<string[]> => {
  if (!usesDevClient(root)) return [];
  const ids = appIdsOf(root, configured);
  const lines = await Promise.all(
    devices.map(async (device) => {
      const outcome = await finishDevMenuOnboarding(device, ids).catch(() => 'failed' as const);
      if (outcome === 'done')
        return `Expo dev menu: marked its onboarding sheet seen and its floating button hidden on ${device.name}, so neither covers the app; relaunch the app if the sheet is showing now`;
      if (outcome === 'failed') return `Expo dev menu: could not mark its onboarding sheet seen on ${device.name}; close the sheet by hand, it covers the app`;
      return undefined;
    }),
  );
  return lines.filter((l): l is string => !!l);
};

const attachedOnce = new Set<string>();

/** Once per process and device: an app that attaches on a simulator or emulator has the dev menu out of its way from its next launch. */
export const devMenuOnAttach = async (root: string, configured: string | undefined, device: DeviceInfo, say: (line: string) => void): Promise<void> => {
  const key = `${device.id}:${root}`;
  if (attachedOnce.has(key) || device.type === 'physical' || device.id === 'headless') return;
  attachedOnce.add(key);
  for (const line of await prepareDevMenu(root, configured, [device]).catch(() => [])) say(line);
};

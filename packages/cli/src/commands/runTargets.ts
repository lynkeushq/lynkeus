/** Where `status` says cases can run on this machine, where to write them, and which to use in CI. */
import { androidDevices, bootedSimulators, type DeviceInfo } from '../device/devices.js';
import type { SetupCheck } from './init.js';

/** The simulators, emulators and phones this machine has up; asking takes a fraction of a second, and none without Xcode or adb. */
export const machineTargets = async (): Promise<{ simulators: DeviceInfo[]; android: DeviceInfo[] }> => {
  const [simulators, android] = await Promise.all([bootedSimulators().catch(() => []), androidDevices().catch(() => [])]);
  return { simulators, android };
};

export type RunFacts = {
  attached?: string;
  port: number;
  /** Undefined when the machine was not asked (`--offline`). */
  simulators?: DeviceInfo[];
  android?: (DeviceInfo & { reversed?: boolean })[];
  headless: SetupCheck;
  fastsim: { version: string; variant: string }[];
};

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

export const runTargets = (facts: RunFacts): { checks: SetupCheck[]; advice: string } => {
  const group = 'runs-on' as const;
  const checks: SetupCheck[] = [];
  if (facts.simulators)
    checks.push(
      facts.simulators.length
        ? { what: `iOS Simulator: ${facts.simulators.map((d) => d.name).join(', ')} (booted)`, ok: true, group }
        : { what: 'iOS Simulator: none booted', ok: false, optional: true, group, fix: 'boot one and open a development build of the app on it' },
    );
  if (facts.android) {
    const emulators = facts.android.filter((d) => d.type === 'emulator');
    const phones = facts.android.filter((d) => d.type === 'physical');
    const listed = (list: (DeviceInfo & { reversed?: boolean })[]) =>
      list.map((d) => `${d.name}${d.reversed ? ` (adb reverse tcp:${facts.port} done)` : ''}`).join(', ');
    checks.push(
      emulators.length
        ? { what: `Android emulator: ${listed(emulators)}`, ok: true, group }
        : { what: 'Android emulator: none running', ok: false, optional: true, group, fix: 'start one and open a development build of the app on it' },
    );
    if (phones.length) checks.push({ what: `${plural(phones.length, 'phone')} on adb: ${listed(phones)}`, ok: true, group });
  }
  checks.push({
    ...facts.headless,
    what: facts.headless.ok ? 'headless, in Node with no simulator: ready' : 'headless, in Node with no simulator: not set up',
    optional: true,
    group,
  });
  checks.push(
    facts.fastsim.length
      ? { what: `Lynkeus FastSim: ${facts.fastsim.map((h) => `${h.version}, ${h.variant}`).join('; ')}`, ok: true, group }
      : {
          what: 'Lynkeus FastSim: not installed',
          ok: false,
          optional: true,
          group,
          fix: '`lynkeus fastsim install --platform ios|android` (Team plan); headless and a Simulator or emulator cover the same cases for free',
        },
  );
  const device = facts.simulators?.[0]?.name ?? facts.android?.[0]?.name;
  // Write where a run is cheapest and has no system prompts or browsers to wander into; a device when the case needs one.
  const write = facts.fastsim.length
    ? 'FastSim'
    : facts.headless.ok
      ? 'headless (`case run --host`)'
      : facts.attached
        ? `the attached app (${facts.attached})`
        : device
          ? `a development build on ${device}`
          : 'a development build on a Simulator or emulator, or headless after `lynkeus headless init`';
  const ci = facts.fastsim.length
    ? 'FastSim hosts side by side (`case run --jobs <n> --host-command`, see its README)'
    : `headless (\`case run --host\`, no simulator and no build${facts.headless.ok ? '' : ', after `lynkeus headless init`'})`;
  return { checks, advice: `write cases on ${write}; a case is done when \`case run --on all\` passes; in CI: ${ci}` };
};

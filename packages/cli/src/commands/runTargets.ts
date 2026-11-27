/** Where `status` says cases can run on this machine, where a case must pass for the project, where to write them, and which to use in CI. */
import fs from 'node:fs';
import path from 'node:path';

import { CI_TARGETS, type TargetName } from '../cases/onTargets.js';
import { androidDevices, bootedSimulators, type DeviceInfo } from '../device/devices.js';
import type { SetupCheck } from './init.js';

export type Platform = 'ios' | 'android';

/**
 * The platforms the app builds for, from its native folders; an app with neither (Expo with no prebuild) builds for
 * both.
 */
export const appPlatforms = (root: string): Platform[] => {
  const found = (['ios', 'android'] as const).filter((p) => fs.existsSync(path.join(root, p)));
  return found.length > 0 ? [...found] : ['ios', 'android'];
};

/** Whether the folder is an app's, for which a project's targets mean something. */
export const isAppFolder = (root: string): boolean => ['package.json', 'pubspec.yaml'].some((f) => fs.existsSync(path.join(root, f)));

/**
 * The `cases.targets` to propose when a project declares none: FastSim for each of the app's platforms when this
 * machine has it installed (a seat downloaded it), else headless and the app's device platforms.
 */
export const proposeTargets = (o: { fastsim: readonly Platform[]; platforms: readonly Platform[] }): TargetName[] =>
  o.fastsim.length > 0 ? o.platforms.map((p): TargetName => `fastsim:${p}`) : ['headless', ...o.platforms];

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
  /** What `cases.targets` says and what to propose without it; left out, status says nothing of the project's targets. */
  targets?: {
    /** The project's targets, a sentence when they name something that is not one, undefined when none are declared. */
    declared: TargetName[] | string | undefined;
    /** The app's platforms. */
    platforms: Platform[];
    /** The platforms an installed FastSim draws, and those a bundle under .lynkeus is for. */
    kits: Platform[];
    bundles: string[];
  };
};

/** Whether this machine can run on a target now, from what status found: undefined when ready, else why not. */
export const targetGap = (t: TargetName, facts: RunFacts): string | undefined => {
  const kits = facts.targets?.kits ?? [];
  const fastsim = (p: Platform) =>
    !kits.includes(p)
      ? `Lynkeus FastSim for ${p} not installed (\`lynkeus fastsim install --platform ${p}\`)`
      : facts.targets?.bundles.includes(p)
        ? undefined
        : `no ${p} bundle under .lynkeus yet (\`case run --on targets\` says the fastsim-bundle command)`;
  const devices = (list: DeviceInfo[] | undefined, none: string) => (list === undefined ? 'not asked (--offline)' : list.length ? undefined : none);
  switch (t) {
    case 'headless':
      return facts.headless.ok ? undefined : `not set up${facts.headless.fix ? ` (${facts.headless.fix})` : ''}`;
    case 'fastsim:ios':
      return fastsim('ios');
    case 'fastsim:android':
      return fastsim('android');
    case 'fastsim':
      return kits.length ? undefined : 'Lynkeus FastSim not installed';
    case 'ios':
      return devices(facts.simulators, 'no iOS Simulator booted with the app');
    case 'android':
      return devices(facts.android, 'no Android emulator or phone with the app');
    case 'simulator':
      return facts.simulators === undefined && facts.android === undefined
        ? 'not asked (--offline)'
        : facts.simulators?.length || facts.android?.length
          ? undefined
          : 'no Simulator, emulator or phone up';
  }
};

const json = (targets: readonly string[]) => JSON.stringify(targets);

/** The lines status gives the project's targets: each declared one and whether it runs here, or the value to propose. */
const declaredChecks = (facts: RunFacts): SetupCheck[] => {
  const t = facts.targets;
  if (!t) return [];
  const group = 'targets' as const;
  if (typeof t.declared === 'string') return [{ what: t.declared, ok: false, group, fix: 'fix cases.targets in lynkeus.config.json' }];
  if (!t.declared) {
    const proposed = proposeTargets({ fastsim: t.kits, platforms: t.platforms });
    return [
      {
        what: 'cases.targets: none declared, so nothing says where a case must pass',
        ok: false,
        optional: true,
        group,
        fix: `propose ${json(proposed)} (from this machine and the app's platforms) to the person and, once they confirm, set "cases": { "targets": ${json(proposed)} } in lynkeus.config.json`,
      },
    ];
  }
  return t.declared.map((target) => {
    const gap = targetGap(target, facts);
    return gap ? { what: `${target}: not available here`, ok: false, group, fix: gap } : { what: `${target}: available here`, ok: true, group };
  });
};

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

export const runTargets = (facts: RunFacts): { checks: SetupCheck[]; declared: SetupCheck[]; advice: string } => {
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
  const declared = Array.isArray(facts.targets?.declared) ? facts.targets.declared : undefined;
  const inCi = declared?.filter((t) => CI_TARGETS.includes(t));
  const ci = inCi?.length
    ? `\`lynkeus ci\` runs the declared ${inCi.join(', ')}${inCi.length < declared!.length ? ` (${declared!.filter((t) => !inCi.includes(t)).join(', ')} need a device)` : ''}`
    : facts.fastsim.length
      ? 'FastSim hosts side by side (`case run --jobs <n> --host-command`, see its README)'
      : `headless (\`case run --host\`, no simulator and no build${facts.headless.ok ? '' : ', after `lynkeus headless init`'})`;
  const done = declared
    ? `a case is done when \`case run --on targets\` passes on the project's targets (${declared.join(', ')})`
    : facts.targets
      ? `a case is done when it passes on the project's targets, and none are declared: ask the person which matter (proposed: ${json(proposeTargets({ fastsim: facts.targets.kits, platforms: facts.targets.platforms }))}), set cases.targets, then check with \`case run --on targets\``
      : 'a case is done when `case run --on targets` passes on the targets the project declared (cases.targets)';
  return { checks, declared: declaredChecks(facts), advice: `write cases on ${write}; ${done}; in CI: ${ci}` };
};

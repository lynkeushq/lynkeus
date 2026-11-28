import assert from 'node:assert/strict';
import { test } from 'node:test';

import { caseLaunch, fillLaunch, ignoredByHost, launchEnv, recordLaunch, resolveLaunch } from '../launch.js';

test('flags win over the config, the config over the environment', () => {
  const launch = resolveLaunch(
    { seed: 'flag' },
    { launch: { seed: 'config', locale: 'de-DE', timeZone: 'Europe/Berlin' } },
    { LYNKEUS_SEED: 'env', LYNKEUS_LOCALE: 'fr-FR', LYNKEUS_TIME_ZONE: 'UTC', LYNKEUS_EPOCH: '1772355600000' },
  );
  assert.deepEqual(launch, { seed: 'flag', locale: 'de-DE', timeZone: 'Europe/Berlin', epoch: '2026-03-01T09:00:00.000Z' });
});

test('a run that asks for nothing launches with nothing', () => {
  assert.deepEqual(resolveLaunch({}, {}, {}), {});
  assert.equal(recordLaunch({}, true), undefined);
});

test('a value that cannot be used stops the run with what to write instead', () => {
  assert.match(resolveLaunch({ 'time-zone': 'Mars/Olympus' }, {}, {}) as string, /not an IANA time zone/);
  assert.match(resolveLaunch({ locale: 'es_AR' }, {}, {}) as string, /not a language tag/);
  assert.match(resolveLaunch({ epoch: 'tomorrow' }, {}, {}) as string, /not an instant/);
});

test('a host the run starts gets every fact, in the environment and in the command', () => {
  const launch = { seed: '7', locale: 'es-AR', timeZone: 'America/Argentina/Buenos_Aires', epoch: '2026-03-01T09:00:00.000Z' };
  assert.deepEqual(launchEnv(launch), {
    LYNKEUS_SEED: '7',
    LYNKEUS_LOCALE: 'es-AR',
    LYNKEUS_TIME_ZONE: 'America/Argentina/Buenos_Aires',
    TZ: 'America/Argentina/Buenos_Aires',
    LYNKEUS_EPOCH: '2026-03-01T09:00:00.000Z',
  });
  assert.equal(
    fillLaunch('fastsim --locale {locale} --timezone {time-zone} --epoch {epoch} --seed {seed}', launch),
    'fastsim --locale es-AR --timezone America/Argentina/Buenos_Aires --epoch 2026-03-01T09:00:00.000Z --seed 7',
  );
  assert.equal(recordLaunch(launch, true), launch);
});

test('an attached app keeps its own random values, locale, time zone and clock, and the manifest says so', () => {
  const launch = { seed: '7', locale: 'es-AR', epoch: '2026-03-01T09:00:00.000Z' };
  assert.deepEqual(recordLaunch(launch, false), { ...launch, unsupported: ['seed', 'locale', 'epoch'] });
  assert.deepEqual(recordLaunch({ seed: '7' }, false), { seed: '7', unsupported: ['seed'] });
});

test('a host started for a case draws its own values, the same on every run', () => {
  const launch = { seed: '7', locale: 'es-AR' };
  assert.deepEqual(caseLaunch(launch, 'login-sign-up'), { seed: '7:login-sign-up', locale: 'es-AR' });
  assert.equal(caseLaunch(launch, 'login-sign-up', 2)?.seed, '7:login-sign-up:2');
  assert.notEqual(caseLaunch(launch, 'login-sign-up')?.seed, caseLaunch(launch, 'onboarding-kyc')?.seed);
  assert.deepEqual(caseLaunch({ locale: 'es-AR' }, 'login-sign-up'), { locale: 'es-AR' });
  assert.equal(caseLaunch(undefined, 'login-sign-up'), undefined);
});

test('a FastSim host that does not apply the locale has it listed as unsupported, until its kit says launch-locale', () => {
  const launch = { locale: 'es-AR', timeZone: 'America/Argentina/Buenos_Aires', seed: 's' };
  // Trial run 13: the app on FastSim still read "Log In" while run.json claimed es-AR.
  assert.deepEqual(ignoredByHost(true, []), ['locale']);
  assert.deepEqual(recordLaunch(launch, true, ignoredByHost(true, ['host-token']))?.unsupported, ['locale']);
  assert.deepEqual(ignoredByHost(true, ['launch-locale']), []);
  assert.equal(recordLaunch(launch, true, ignoredByHost(true, ['launch-locale'])), launch);
  // Headless applies it; a run with no locale lists nothing.
  assert.equal(recordLaunch(launch, true, ignoredByHost(false, [])), launch);
  assert.equal(recordLaunch({ seed: 's' }, true, ['locale'])?.unsupported, undefined);
});

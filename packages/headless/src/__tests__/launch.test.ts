import vm from 'node:vm';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { host } from 'lynkeus-agent';

import { installControls } from '../mocks/controls.js';
import { localize } from '../mocks/factories.js';
import { launchLocale } from '../mocks/install.js';
import { defaultIntlLocale, expoLocalization, localeFacts } from '../mocks/locale.js';
import { reset } from '../runtime.js';

const RealDate = Date;
const RealRandom = Math.random;

describe('launch facts', () => {
  beforeAll(() => {
    process.env.LYNKEUS_EPOCH = '2026-03-01T09:00:00.000Z';
    process.env.LYNKEUS_SEED = 'compare';
    installControls();
  });
  afterAll(() => {
    delete process.env.LYNKEUS_EPOCH;
    delete process.env.LYNKEUS_SEED;
    Math.random = RealRandom;
    (globalThis as { Date: unknown }).Date = RealDate;
  });

  it('starts Date at the epoch and lets it run', () => {
    const now = Date.now();
    expect(now).toBeGreaterThanOrEqual(RealDate.parse('2026-03-01T09:00:00.000Z'));
    expect(now).toBeLessThan(RealDate.parse('2026-03-01T09:00:10.000Z'));
  });

  it('a clock reset goes back to the epoch, not to the real time', async () => {
    await (host.get('clock') as (p: unknown) => unknown)({ advanceMs: 86_400_000 });
    await (host.get('clock') as (p: unknown) => unknown)({ reset: true });
    expect(new Date().toISOString().startsWith('2026-03-01T09:00')).toBe(true);
  });

  it('seeds Math.random and starts the sequence again after a reset', () => {
    const first = [Math.random(), Math.random(), Math.random()];
    expect(new Set(first).size).toBe(3);
    reset();
    expect([Math.random(), Math.random(), Math.random()]).toEqual(first);
  });
});

describe('launchLocale', () => {
  it('leaves the entry defaults alone without launch facts', () => {
    expect(launchLocale({ country: 'DE', languageTag: 'de-DE', languageCode: 'de' }, {})).toEqual({ country: 'DE', languageTag: 'de-DE', languageCode: 'de' });
  });

  it('takes the language tag and the time zone from the environment', () => {
    expect(launchLocale({ country: 'DE' }, { LYNKEUS_LOCALE: 'es-AR', LYNKEUS_TIME_ZONE: 'America/Argentina/Buenos_Aires' })).toEqual({
      country: 'AR',
      languageTag: 'es-AR',
      languageCode: 'es',
      timeZone: 'America/Argentina/Buenos_Aires',
    });
  });
});

describe('the launch locale everywhere the app reads it', () => {
  it('derives what a phone in es-AR reports', () => {
    expect(localeFacts({ languageTag: 'es-AR', languageCode: 'es', country: 'AR', timeZone: 'America/Argentina/Buenos_Aires' })).toMatchObject({
      languageTag: 'es-AR',
      regionCode: 'AR',
      currencyCode: 'ARS',
      decimalSeparator: ',',
      groupingSeparator: '.',
      textDirection: 'ltr',
      measurementSystem: 'metric',
      firstWeekday: 2,
      timeZone: 'America/Argentina/Buenos_Aires',
    });
    expect(localeFacts()).toMatchObject({ languageTag: 'en-US', currencyCode: 'USD', measurementSystem: 'us', uses24hourClock: false, firstWeekday: 1 });
    expect(localeFacts({ languageTag: 'ar-EG' }).textDirection).toBe('rtl');
    expect(localeFacts({ languageTag: 'de-DE' }).uses24hourClock).toBe(true);
  });

  it('answers expo-localization and react-native-localize from the same locale', () => {
    const base = launchLocale({}, { LYNKEUS_LOCALE: 'es-AR', LYNKEUS_TIME_ZONE: 'UTC' });
    const expo = expoLocalization(base)() as {
      getLocales: () => { languageTag: string; decimalSeparator: string }[];
      getCalendars: () => { timeZone: string }[];
    };
    expect(expo.getLocales()[0]).toMatchObject({ languageTag: 'es-AR', decimalSeparator: ',' });
    expect(expo.getCalendars()[0]?.timeZone).toBe('UTC');
    const rnl = localize(base)() as { getLocales: () => { languageTag: string }[]; getNumberFormatSettings: () => { decimalSeparator: string } };
    expect(rnl.getLocales()[0]?.languageTag).toBe('es-AR');
    expect(rnl.getNumberFormatSettings().decimalSeparator).toBe(',');
  });

  it('formats for the launch locale when the app names none, and as asked when it names one', () => {
    const context = vm.createContext();
    const run = (code: string) => vm.runInContext(code, context) as unknown;
    expect(defaultIntlLocale('es-AR', run('globalThis') as typeof globalThis)).toBe(true);
    expect(run('(1234.5).toLocaleString()')).toBe('1.234,5');
    expect(run("(1234.5).toLocaleString('en-US')")).toBe('1,234.5');
    expect(run('new Intl.NumberFormat().resolvedOptions().locale')).toBe('es-AR');
    expect(run('Intl.DateTimeFormat().resolvedOptions().locale')).toBe('es-AR');
    expect(run("['b', 'a'].sort((x, y) => x.localeCompare(y)).join()")).toBe('a,b');
  });
});

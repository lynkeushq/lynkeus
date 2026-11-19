import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { host } from 'lynkeus-agent';

import { installControls } from '../mocks/controls.js';
import { launchLocale } from '../mocks/install.js';
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

  it('a clock reset goes back to the epoch, not to the real time', () => {
    (host.get('clock') as (p: unknown) => unknown)({ advanceMs: 86_400_000 });
    (host.get('clock') as (p: unknown) => unknown)({ reset: true });
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

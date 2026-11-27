// The launch locale and time zone as the app reads them: expo-localization, react-native-localize and Intl itself.
// Every answer is derived from the language tag with Intl, so a case launched in es-AR reads Spanish, commas for
// decimals and a 24-hour clock wherever the app asks, not English from one library and Spanish from another.
import { log } from '../runtime.js';
import type { LocaleDefault, MockFactory } from './factories.js';

// jest injects `jest` as a module-scoped local, not onto globalThis.
declare const jest: { requireActual(name: string): unknown };

// Intl has no region → currency table; the regions an app is most often tested in. Elsewhere the currency is unknown.
const EURO = ['AT', 'BE', 'CY', 'DE', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PT', 'SI', 'SK'];
const CURRENCIES: Record<string, string> = {
  ...Object.fromEntries(EURO.map((region) => [region, 'EUR'])),
  AE: 'AED',
  AR: 'ARS',
  AU: 'AUD',
  BO: 'BOB',
  BR: 'BRL',
  CA: 'CAD',
  CH: 'CHF',
  CL: 'CLP',
  CN: 'CNY',
  CO: 'COP',
  CR: 'CRC',
  CZ: 'CZK',
  DK: 'DKK',
  DO: 'DOP',
  EC: 'USD',
  EG: 'EGP',
  GB: 'GBP',
  GT: 'GTQ',
  HK: 'HKD',
  HU: 'HUF',
  ID: 'IDR',
  IL: 'ILS',
  IN: 'INR',
  JP: 'JPY',
  KR: 'KRW',
  MX: 'MXN',
  MY: 'MYR',
  NG: 'NGN',
  NO: 'NOK',
  NZ: 'NZD',
  PA: 'PAB',
  PE: 'PEN',
  PH: 'PHP',
  PK: 'PKR',
  PL: 'PLN',
  PR: 'USD',
  PY: 'PYG',
  RO: 'RON',
  SA: 'SAR',
  SE: 'SEK',
  SG: 'SGD',
  SV: 'USD',
  TH: 'THB',
  TR: 'TRY',
  TW: 'TWD',
  UA: 'UAH',
  US: 'USD',
  UY: 'UYU',
  VE: 'VES',
  VN: 'VND',
  ZA: 'ZAR',
};
const RTL = new Set(['ar', 'dv', 'fa', 'he', 'ku', 'ps', 'sd', 'ug', 'ur', 'yi']);
const FAHRENHEIT = new Set(['US', 'BS', 'BZ', 'KY', 'LR', 'PW']);

export type LocaleFacts = {
  languageTag: string;
  languageCode: string;
  scriptCode: string | null;
  regionCode: string | null;
  currencyCode: string | null;
  currencySymbol: string | null;
  decimalSeparator: string;
  groupingSeparator: string;
  textDirection: 'ltr' | 'rtl';
  measurementSystem: 'metric' | 'us' | 'uk';
  temperatureUnit: 'celsius' | 'fahrenheit';
  uses24hourClock: boolean;
  /** 1 is Sunday, as expo-localization counts. */
  firstWeekday: number;
  timeZone: string;
};

type IntlLocaleInfo = Intl.Locale & {
  getTextInfo?: () => { direction?: string };
  textInfo?: { direction?: string };
  getWeekInfo?: () => { firstDay?: number };
  weekInfo?: { firstDay?: number };
};

/** What a phone set to this locale reports. Defaults: en-US in America/New_York. */
export const localeFacts = ({ country, languageTag, languageCode, timeZone = 'America/New_York' }: LocaleDefault = {}): LocaleFacts => {
  const tag = languageTag ?? (languageCode ? `${languageCode}${country ? `-${country}` : ''}` : 'en-US');
  const locale = new Intl.Locale(tag).maximize() as IntlLocaleInfo;
  const region = country ?? new Intl.Locale(tag).region ?? locale.region ?? null;
  const language = languageCode ?? locale.language;
  const parts = new Intl.NumberFormat(tag).formatToParts(1234567.5);
  const currencyCode = region ? (CURRENCIES[region] ?? null) : null;
  const currencySymbol = currencyCode
    ? (new Intl.NumberFormat(tag, { style: 'currency', currency: currencyCode }).formatToParts(0).find((p) => p.type === 'currency')?.value ?? null)
    : null;
  const direction = (locale.getTextInfo?.() ?? locale.textInfo)?.direction ?? (RTL.has(language) ? 'rtl' : 'ltr');
  const hourCycle = new Intl.DateTimeFormat(tag, { hour: 'numeric' }).resolvedOptions().hourCycle;
  // Intl counts Monday as 1 and Sunday as 7.
  const isoFirstDay = (locale.getWeekInfo?.() ?? locale.weekInfo)?.firstDay ?? (region === 'US' ? 7 : 1);
  return {
    languageTag: tag,
    languageCode: language,
    scriptCode: locale.script ?? null,
    regionCode: region,
    currencyCode,
    currencySymbol,
    decimalSeparator: parts.find((p) => p.type === 'decimal')?.value ?? '.',
    groupingSeparator: parts.find((p) => p.type === 'group')?.value ?? ',',
    textDirection: direction === 'rtl' ? 'rtl' : 'ltr',
    measurementSystem: region === 'US' || region === 'LR' || region === 'MM' ? 'us' : region === 'GB' ? 'uk' : 'metric',
    temperatureUnit: region && FAHRENHEIT.has(region) ? 'fahrenheit' : 'celsius',
    uses24hourClock: hourCycle === 'h23' || hourCycle === 'h24',
    firstWeekday: (isoFirstDay % 7) + 1,
    timeZone,
  };
};

// jest-expo answers expo-localization from a fixed en-US stand-in, whatever the launch says. The module is built
// again on the library's own exports, so its other members (listeners, types) stay; the hooks read the same answers.
export const expoLocalization =
  (base: LocaleDefault = {}): MockFactory =>
  () => {
    const facts = localeFacts(base);
    let actual: Record<string, unknown> = {};
    try {
      actual = jest.requireActual('expo-localization') as Record<string, unknown>;
    } catch {
      // A version that cannot load under jest: the answers below are the whole module.
    }
    const locale = {
      languageTag: facts.languageTag,
      languageCode: facts.languageCode,
      languageScriptCode: facts.scriptCode,
      regionCode: facts.regionCode,
      languageRegionCode: facts.regionCode,
      currencyCode: facts.currencyCode,
      currencySymbol: facts.currencySymbol,
      languageCurrencyCode: facts.currencyCode,
      languageCurrencySymbol: facts.currencySymbol,
      decimalSeparator: facts.decimalSeparator,
      digitGroupingSeparator: facts.groupingSeparator,
      textDirection: facts.textDirection,
      measurementSystem: facts.measurementSystem,
      temperatureUnit: facts.temperatureUnit,
    };
    const calendar = { calendar: 'gregory', uses24hourClock: facts.uses24hourClock, firstWeekday: facts.firstWeekday, timeZone: facts.timeZone };
    const getLocales = () => [{ ...locale }];
    const getCalendars = () => [{ ...calendar }];
    // The constants of SDKs before 51; set only where the installed version still has them.
    const legacy: Record<string, unknown> = {
      locale: facts.languageTag,
      locales: [facts.languageTag],
      timezone: facts.timeZone,
      isRTL: facts.textDirection === 'rtl',
      region: facts.regionCode,
      currency: facts.currencyCode,
      isoCurrencyCodes: facts.currencyCode ? [facts.currencyCode] : [],
      decimalSeparator: facts.decimalSeparator,
      digitGroupingSeparator: facts.groupingSeparator,
      isMetric: facts.measurementSystem === 'metric',
    };
    const kept = Object.fromEntries(Object.entries(legacy).filter(([key]) => key in actual));
    const getLocalizationAsync = async () => ({ ...legacy, isoCurrencyCodes: legacy.isoCurrencyCodes });
    const api = {
      ...actual,
      ...kept,
      getLocales,
      getCalendars,
      useLocales: getLocales,
      useCalendars: getCalendars,
      ...('getLocalizationAsync' in actual ? { getLocalizationAsync } : {}),
    };
    return { ...api, default: api, __esModule: true };
  };

type Constructor = abstract new (...args: never[]) => unknown;
const INTL_SERVICES = ['DateTimeFormat', 'NumberFormat', 'Collator', 'PluralRules', 'RelativeTimeFormat', 'ListFormat', 'DisplayNames', 'Segmenter'] as const;

/**
 * Intl's default locale is the host process's (LANG, or en-US), not the launch's: `toLocaleString()` and
 * `new Intl.NumberFormat()` with no locale would format for the Mac or the CI runner. Each service and
 * `toLocale*String` take the launch locale when the app names none; a locale the app names still wins.
 */
export const defaultIntlLocale = (tag: string, scope: typeof globalThis = globalThis): boolean => {
  const intl = scope.Intl as unknown as Record<string, Constructor | undefined>;
  if (new scope.Intl.DateTimeFormat().resolvedOptions().locale === new scope.Intl.Locale(tag).toString()) return false;
  const locales = (given: unknown) => (given === undefined ? tag : given);
  for (const name of INTL_SERVICES) {
    const Service = intl[name];
    if (!Service) continue;
    intl[name] = new Proxy(Service, {
      construct: (target, args: unknown[], newTarget) => Reflect.construct(target, [locales(args[0]), ...args.slice(1)], newTarget),
      // DateTimeFormat, NumberFormat and Collator may be called without `new`.
      apply: (target, self, args: unknown[]) => Reflect.apply(target as unknown as (...a: unknown[]) => unknown, self, [locales(args[0]), ...args.slice(1)]),
    });
  }
  const methods: [object, string, number][] = [
    [scope.Number.prototype, 'toLocaleString', 0],
    [scope.BigInt.prototype, 'toLocaleString', 0],
    [scope.Date.prototype, 'toLocaleString', 0],
    [scope.Date.prototype, 'toLocaleDateString', 0],
    [scope.Date.prototype, 'toLocaleTimeString', 0],
    [scope.Array.prototype, 'toLocaleString', 0],
    [scope.String.prototype, 'localeCompare', 1],
    [scope.String.prototype, 'toLocaleUpperCase', 0],
    [scope.String.prototype, 'toLocaleLowerCase', 0],
  ];
  for (const [proto, name, at] of methods) {
    const original = (proto as Record<string, unknown>)[name] as ((...args: unknown[]) => unknown) | undefined;
    if (typeof original !== 'function') continue;
    Object.defineProperty(proto, name, {
      configurable: true,
      writable: true,
      value: function (this: unknown, ...args: unknown[]) {
        const filled = [...args];
        filled[at] = locales(args[at]);
        return original.apply(this, filled);
      },
    });
  }
  log(`locale: Intl formats for ${tag} when the app names no locale`);
  return true;
};

import { redactText, redactValue } from './redact';

// What the app writes to its console and the errors it does not catch, kept so a run can file each line under the
// step that printed it. Every call still reaches the console as before.
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogLine = { at: number; level: LogLevel; source: 'js'; text: string; stack?: string };

const kept: LogLine[] = [];
const KEEP = 2000;
const LONG = 4000;

const show = (value: unknown): string => {
  if (typeof value === 'string') return redactText(value);
  if (value instanceof Error) return redactText(`${value.name}: ${value.message}`);
  try {
    return JSON.stringify(redactValue(value)) ?? String(value);
  } catch {
    return String(value);
  }
};

const keep = (level: LogLevel, args: unknown[], stack?: string) => {
  const text = args.map(show).join(' ');
  const error = args.find((a): a is Error => a instanceof Error);
  const stackText = stack ?? error?.stack;
  kept.push({
    at: Date.now(),
    level,
    source: 'js',
    text: text.length > LONG ? `${text.slice(0, LONG)}…` : text,
    ...(stackText ? { stack: redactText(stackText) } : {}),
  });
  if (kept.length > KEEP) kept.shift();
};

const LEVELS: [keyof Console, LogLevel][] = [
  ['debug', 'debug'],
  ['log', 'info'],
  ['info', 'info'],
  ['warn', 'warn'],
  ['error', 'error'],
];

type Global = {
  console: Console;
  ErrorUtils?: { getGlobalHandler: () => (e: unknown, fatal?: boolean) => void; setGlobalHandler: (h: (e: unknown, fatal?: boolean) => void) => void };
  __lynkeusLogs?: boolean;
};

/** Wraps the console and the global error handler once; answers whether it did now. */
export const tapLogs = (g: Global = globalThis as unknown as Global): boolean => {
  if (g.__lynkeusLogs) return false;
  g.__lynkeusLogs = true;
  for (const [method, level] of LEVELS) {
    const original = g.console[method] as (...a: unknown[]) => void;
    if (typeof original !== 'function') continue;
    (g.console as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
      try {
        keep(level, args);
      } catch {}
      original.apply(g.console, args);
    };
  }
  const errors = g.ErrorUtils;
  if (errors) {
    const before = errors.getGlobalHandler();
    errors.setGlobalHandler((e, fatal) => {
      try {
        keep('error', [`${fatal ? 'Uncaught (fatal) ' : 'Uncaught '}${show(e)}`], e instanceof Error ? e.stack : undefined);
      } catch {}
      before(e, fatal);
    });
  }
  return true;
};

/** `logs`: what the app printed, oldest first; `{ take: true }` empties it after reading. */
export const readLogs = (params: unknown): LogLine[] => {
  const out = [...kept];
  if ((params as { take?: boolean } | undefined)?.take) kept.length = 0;
  return out;
};

import type { Element, Target } from 'lynkeus-protocol';

export const TARGET_HELP = '#testId | "text" | 12 (index) | 100,200';

/**
 * `#testId`, `12` (an index), `100,200` (a point), anything else a text; `#testId[2]` or `text[2]` is the third match.
 * A text in quotes is that text and nothing else: `"12"` is not an index, and `"Next"` is not a route.
 */
export const parseTarget = (raw: string): Target => {
  const quoted = /^(["'])((?:(?!\1).)*)\1$/s.exec(raw);
  if (quoted) return { text: quoted[2]! };
  const nth = /^(.+)\[(\d+)\]$/.exec(raw);
  if (nth && !/^\d+$/.test(nth[1]!)) {
    const base = parseTarget(nth[1]!);
    if ('testId' in base || 'text' in base) return { ...base, nth: Number(nth[2]) };
  }
  if (raw.startsWith('#')) return { testId: raw.slice(1) };
  if (/^\d+,\d+$/.test(raw)) {
    const [x, y] = raw.split(',').map(Number);
    return { x: x!, y: y! };
  }
  if (/^\d+$/.test(raw)) return { i: Number(raw) };
  return { text: raw };
};

/** A target narrowed to the match nearest another (`--in`) and to a position among the matches (`--nth`). */
export const scopedTarget = (raw: string, flags: { in?: unknown; nth?: unknown }): Target => {
  const target = parseTarget(raw);
  if (!('testId' in target) && !('text' in target)) return target;
  const scope = typeof flags.in === 'string' ? parseTarget(flags.in) : undefined;
  if (scope && !('testId' in scope) && !('text' in scope)) throw new Error('--in takes a #testId or a text');
  return {
    ...target,
    ...(scope ? { within: 'testId' in scope ? { testId: scope.testId } : { text: scope.text } } : {}),
    ...(typeof flags.nth === 'number' ? { nth: flags.nth } : {}),
  };
};

const ROUTE_PREFIX = 'route:';

/**
 * A word that starts with a capital is a route (`Home.Main`), as React Navigation names them. A router
 * that names routes after files (Expo Router's `index`, `(tabs)/settings`) says so: `route:index`.
 */
export const isRoute = (raw: string) => raw.startsWith(ROUTE_PREFIX) || /^[A-Z]\w*(\.[A-Z]\w*)*$/.test(raw);

/** The route a target names, without the prefix that marked it as one. */
export const routeOf = (raw: string) => (raw.startsWith(ROUTE_PREFIX) ? raw.slice(ROUTE_PREFIX.length) : raw);

export type Expected = { testId?: string; text?: string; route?: string };

/** What a command was looking for, as `why` reads it. */
export const expectedOf = (raw: string | undefined): Expected | undefined => {
  if (!raw) return undefined;
  if (isRoute(raw)) return { route: routeOf(raw) };
  const t = parseTarget(raw);
  return 'testId' in t ? { testId: t.testId } : 'text' in t ? { text: t.text } : undefined;
};

const distance = (a: string, b: string): number => {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length]!;
};

/**
 * A bare capitalized word is read as a route; when the app has no route of that name Lynkeus knows of and a text on
 * screen is that word or close to it, the author most likely meant the text. `known` is empty when nothing is known.
 */
export const bareWordNote = (raw: string, texts: string[], known: Set<string>): string | undefined => {
  if (raw.startsWith(ROUTE_PREFIX) || !isRoute(raw) || known.has(raw)) return undefined;
  const word = raw.toLowerCase();
  const shown = [...new Set(texts.map((t) => t.trim()).filter((t) => t.length > 0 && t.length <= 60))];
  const exact = shown.find((t) => t.toLowerCase() === word);
  const close = exact
    ? undefined
    : shown
        .map((t) => ({ t, d: distance(t.toLowerCase(), word) }))
        .filter(({ t, d }) => d <= Math.max(1, Math.floor(word.length / 4)) || t.toLowerCase().split(/\W+/).includes(word))
        .sort((a, b) => a.d - b.d)[0]?.t;
  if (!exact && !close) return undefined;
  const route = known.size ? `the app has no route ${raw} that Lynkeus knows of` : 'Lynkeus knows no routes of this app to check it against';
  const text = exact ? `${JSON.stringify(exact)} is a text on screen` : `the closest text on screen is ${JSON.stringify(close)}`;
  return `${raw} was read as a route (a bare word that starts with a capital is one), and ${route}; ${text}: quote it ('"${exact ?? close}"') to mean the text, or write route:${raw} for a route`;
};

/**
 * When a text target matched only part of the element acted on (a control's label also matches by part), the element
 * it was, named so a wrong match shows: `"Favorite" matched only part of "Only Show Favorites" (button #fav-toggle)`.
 */
export const partMatchNote = (target: Target, element: Element | undefined): string | undefined => {
  if (!element || !('text' in target)) return undefined;
  const want = target.text.toLowerCase().trim();
  const labels = [element.text, element.accessibilityLabel, element.placeholder].filter((v): v is string => typeof v === 'string');
  if (labels.length === 0 || labels.some((l) => l.toLowerCase().trim() === want)) return undefined;
  const label = labels.find((l) => l.toLowerCase().includes(want)) ?? labels[0]!;
  return `${JSON.stringify(target.text)} matched only part of ${JSON.stringify(label)} (${element.kind}${element.testId ? ` #${element.testId}` : ''})`;
};

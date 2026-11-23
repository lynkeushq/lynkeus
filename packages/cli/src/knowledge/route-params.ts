/**
 * Which routes open without parameters, read from the app's React Navigation
 * `ParamList` type: `undefined`, or an object whose keys are all optional.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { ScreenGraph } from './types.js';

export type RouteParamsInfo = { route: string; free: boolean; shape: string };

export const readRouteParams = (root: string, paramsFile = 'app/navigation/types.d.ts'): RouteParamsInfo[] => {
  const file = path.join(root, paramsFile);
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  const start = Math.max(0, text.search(/\b\w*ParamList\b|ScreenRouteParams/));
  const out = new Map<string, RouteParamsInfo>();
  const entry = /'([A-Z][\w.]+)':\s*/g;
  entry.lastIndex = start;
  for (const match of text.matchAll(entry)) {
    const route = match[1]!;
    let i = match.index + match[0].length;
    let shape = '';
    if (text.startsWith('undefined', i)) {
      shape = 'undefined';
    } else if (text[i] === '{') {
      let depth = 0;
      const from = i;
      for (; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}' && --depth === 0) break;
      }
      shape = text.slice(from, i + 1);
    } else {
      shape = text.slice(i, text.indexOf('\n', i)).trim();
    }
    const free = shape === 'undefined' || (shape.startsWith('{') && !/^\s*\w+\s*:/m.test(shape.slice(1, -1).replace(/\{[^}]*\}/g, '')));
    if (!out.has(route)) out.set(route, { route, free, shape: shape.replace(/\s+/g, ' ').slice(0, 120) });
  }
  return [...out.values()];
};

/**
 * A Flutter app has no params type: what a route needs is read with the route itself (go_router's `:id`, a required
 * `extra`), and a widget pushed without a name cannot be opened by one.
 */
export const flutterRouteParams = (graph: ScreenGraph): RouteParamsInfo[] =>
  Object.values(graph.screens).map((s) => ({
    route: s.route,
    free: !s.unnamed && !s.params?.length,
    shape: s.unnamed ? 'pushed without a name' : s.params?.length ? `{ ${s.params.join(', ')} }` : 'undefined',
  }));

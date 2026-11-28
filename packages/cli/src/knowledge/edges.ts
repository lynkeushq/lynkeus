/**
 * Navigations a run has actually walked, as `edges.jsonl`: one sorted line per
 * distinct edge so concurrent edits merge in git, and a counter instead of a
 * row per sighting so the file converges instead of growing.
 *
 * A run appends one line per sighting to a part of its own and folds it in once
 * at the end; reading merges the store with every part, so a run that is killed
 * halfway loses nothing, and runs side by side never write the same file.
 */
import { appendShared, foldShared, readShared, today } from '../files.js';

export type ObservedEdge = {
  from: string;
  to: string;
  /** A testID, or `text:<label>` when the control had none. */
  via: string;
  /** The layer open over `from` when the press happened, named after the control that opened it. */
  fromLayer?: string;
  /** The layer left open over `to`, named the same way. */
  toLayer?: string;
  seen: number;
  /** A date, not a timestamp, so a run does not churn every line. */
  last: string;
};

export type EdgeObservation = Pick<ObservedEdge, 'from' | 'to' | 'via' | 'fromLayer' | 'toLayer'>;

const nodeId = (route: string, layer?: string) => (layer ? `${route}#${layer}` : route);

export const splitNode = (node: string): { route: string; layer?: string } => {
  const at = node.indexOf('#');
  return at === -1 ? { route: node } : { route: node.slice(0, at), layer: node.slice(at + 1) };
};

export const edgeFrom = (edge: EdgeObservation) => nodeId(edge.from, edge.fromLayer);
export const edgeTo = (edge: EdgeObservation) => nodeId(edge.to, edge.toLayer);

const key = (edge: EdgeObservation) => `${edgeFrom(edge)} ${edge.via} ${edgeTo(edge)}`;

const merge = (into: ObservedEdge, row: ObservedEdge) => {
  into.seen += row.seen;
  if (row.last > into.last) into.last = row.last;
};

const merged = (rows: ObservedEdge[]): Map<string, ObservedEdge> => {
  const byKey = new Map<string, ObservedEdge>();
  for (const row of rows) {
    const found = byKey.get(key(row));
    if (found) merge(found, row);
    else byKey.set(key(row), { ...row });
  }
  return byKey;
};

const sorted = (rows: ObservedEdge[]) => [...merged(rows).values()].sort((a, b) => key(a).localeCompare(key(b)));

export const load = (file: string): ObservedEdge[] => [...merged(readShared<ObservedEdge>(file)).values()];

/** One sighting, appended to this process's part: no read, so a press that led somewhere costs one small write. */
export const append = (file: string, observation: EdgeObservation): void => {
  const row: ObservedEdge = { ...observation, seen: 1, last: today() };
  appendShared(file, row);
};

/** Folds this process's sightings into the store, one sorted line per edge. */
export const fold = (file: string): void => {
  foldShared<ObservedEdge>(file, sorted);
};

/** The edges in a file, kept in memory while a run adds to them. */
export const open = (file: string) => {
  const known = merged(readShared<ObservedEdge>(file));
  let appended = false;
  return {
    all: (): ObservedEdge[] => [...known.values()],
    /** True when the edge is new. */
    record: (observation: EdgeObservation): boolean => {
      append(file, observation);
      appended = true;
      const row: ObservedEdge = { ...observation, seen: 1, last: today() };
      const found = known.get(key(row));
      if (found) merge(found, row);
      else known.set(key(row), { ...row });
      return !found;
    },
    compact: () => {
      if (appended) fold(file);
    },
  };
};

/** Drops the edges of routes that no longer exist, so the store is collected against the app rather than a clock. */
export const prune = (file: string, routes: Set<string>): number => {
  if (load(file).length === 0) return 0;
  let dropped = 0;
  foldShared<ObservedEdge>(
    file,
    (rows) => {
      const all = sorted(rows);
      const kept = all.filter((e) => routes.has(e.from) && routes.has(e.to));
      dropped = all.length - kept.length;
      return kept;
    },
    true,
  );
  return dropped;
};

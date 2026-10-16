import type { RequestRecord } from './index.js';
/**
 * What a run of cases leaves behind: a directory anything can read without
 * knowing how the run was made.
 *
 *   run.json            a RunManifest
 *   cases.jsonl         one RunCase per line, one line per attempt, in the order they ran
 *   <case id>/…         what a case's steps point at: frames, a film
 *
 * Whoever writes it is an engine; whoever reads it (a report, a dashboard, a
 * script) depends on this file and on nothing else. A field is only ever
 * added. Anything that would change the meaning of an existing field raises
 * RUN_SCHEMA, and a reader refuses a schema it does not know.
 */
export const RUN_SCHEMA = 1;

/** Where an event was observed: inside the app, or by the backend the app talks to. */
export type RunEventOrigin = 'app' | 'server';

export type RunEvent = {
  origin: RunEventOrigin;
  name: string;
  props?: Record<string, unknown>;
  /** Who it was sent to, when the engine can tell: 'mixpanel', 'datadog', … */
  provider?: string;
  /** The route the app was on, for an event observed in the app. */
  route?: string;
  /** ISO 8601, when the source says. */
  at?: string;
  /** The request that caused it, for a server event: what files it under a step. */
  requestId?: string;
};

/** `unsupported`: the host the run was on has no way to do the step; it says nothing about the app. */
export type RunStepStatus = 'passed' | 'failed' | 'skipped' | 'unsupported';

/**
 * What the backend did for a step, from the traces it exported: the request the step's app sent, and the
 * queries, jobs and calls out it set off. One per span, in the order they began; `depth` nests them.
 */
export type RunBackendSpan = {
  name: string;
  /** server, client, internal, producer or consumer, as OpenTelemetry says. */
  kind: string;
  /** Milliseconds after the step began. */
  at: number;
  ms: number;
  depth: number;
  /** The service that exported it, when it says. */
  service?: string;
  error?: string;
  /** What it did: method, route, status, table, job class, host called. */
  attributes?: Record<string, string | number | boolean>;
};

export type RunStep = {
  /** The step as the case words it. */
  step: string;
  status: RunStepStatus;
  ms: number;
  error?: string;
  /** Which part of the case it belongs to. */
  section?: 'setup' | 'steps';
  events?: RunEvent[];
  /** A frame taken once the step was done, relative to the run directory. */
  screenshot?: string;
  /** The second of the case's film this step starts at. */
  videoS?: number;
  /** What the backend did for it, when the backend exports traces to the run. */
  backend?: RunBackendSpan[];
  /** The requests the app sent while it ran, with headers and bodies whose secrets are hidden. */
  requests?: RequestRecord[];
  /** What the app printed while it ran: its console, the errors it did not catch, its native log. */
  logs?: RunLogLine[];
};

/** A printed line: `at` in ms since the epoch; `source` is `js`, `native` or `host`. */
export type RunLogLine = { at: number; level: 'debug' | 'info' | 'warn' | 'error'; source: string; text: string; stack?: string };

export type RunCase = {
  id: string;
  title?: string;
  description?: string;
  /** What the case says about itself: why it matters, what is true when it starts, its ticket and expected outcome. */
  about?: { description?: string; why?: string; given?: string; ticket?: string; expected?: string };
  /** The case file, relative to where the run was started. */
  file: string;
  /** 1 for the first try; a case that failed and ran again has a line for each. */
  attempt: number;
  /** `unsupported`: one of its steps could not be done on this host, so it proved nothing here. */
  result: 'passed' | 'failed' | 'unsupported';
  /** ISO 8601. */
  startedAt: string;
  ms: number;
  steps: RunStep[];
  /** Why it failed, as rules read off the screen, the requests and the trace. */
  diagnosis?: string[];
  /** When a step failed: the screen, the requests since the case began, and why. */
  evidence?: { screen?: string; requests?: string[]; why?: string };
  /** The case's film, relative to the run directory. */
  video?: string;
};

export type RunManifest = {
  schema: typeof RUN_SCHEMA;
  /** ISO 8601. */
  startedAt: string;
  /** Absent while the run is going, or when it was cut short. */
  finishedAt?: string;
  /** What the app said it runs on: 'ios', 'android', … */
  platform?: string;
  /** Whether the app ran on a device or simulator (true) or hosted without one. */
  native?: boolean;
  /** Where the run was made from, when it was a git checkout. */
  /** `remote`: the repository's web address (no credentials); `changed`: files with changes no commit has (at most 20 of `changedCount`). */
  git?: { branch?: string; commit?: string; remote?: string; changed?: string[]; changedCount?: number };
  /** Cases by their last attempt. */
  totals?: { cases: number; passed: number; failed: number; unsupported: number; retried: number };
};

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
  /** The numbered section of the case's steps it falls under, from the comment that opens it (`# 3 A wrong PIN` reads `3 A wrong PIN`). */
  heading?: string;
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
  /** On a failed `app.see` or `app.wait` for a target: what the step saw of the screen and of its target. */
  looked?: RunLooked;
};

/** What a failed `see` or `wait` kept: the whole listing at the failure, the scrolls it made, and what its target was last seen as. */
export type RunLooked = {
  /** Every element of the screen at the failure, as `lynkeus screen --all` lists them: off the window, hidden with its reason, covered. Cut at 150 elements. */
  listing: string;
  /** The scrolls the step made, in order (the first 20). */
  scrolls: RunScroll[];
  /** How many scrolls the step made, when more than `scrolls` holds. */
  scrollsTotal: number;
  /** What the target was seen as: `found` is false when it was never in the element tree during the step. */
  target?: { found: boolean; last?: string; seen: RunSighting[] };
};

/** A scroll the step made: which way the content was taken, when (ms into the step), and the first and last element of the listing before and after. */
export type RunScroll = { atMs: number; direction: 'down' | 'up'; moved: boolean; before: RunEdges; after: RunEdges };
export type RunEdges = { count: number; first?: string; last?: string };
/** The target's state when it changed (at most 8), `atMs` into the step and `scrolls` made so far: `not in the tree`, `on screen`, `below the window`, `covered`, `inert`, `hidden (<reason>)`… */
export type RunSighting = { atMs: number; scrolls: number; state: string };

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

/** The four facts a run can pin at launch. */
export type RunLaunchFact = 'seed' | 'locale' | 'timeZone' | 'epoch';

/**
 * What the run asked its hosts to start with. `seed` makes random values repeatable, `locale` is a language tag
 * (`es-AR`), `timeZone` an IANA name, `epoch` the instant (ISO 8601, UTC) the app's clock starts at. `unsupported`
 * names the facts that were asked for and the host the run used could not apply (an attached simulator or emulator
 * has the Mac's time zone and clock); the run is still valid, it just did not have them.
 */
export type RunLaunch = {
  seed?: string;
  locale?: string;
  timeZone?: string;
  epoch?: string;
  unsupported?: RunLaunchFact[];
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
  /**
   * `pushed`: what of it the remote has, as the clone knew when the run began (its remote-tracking refs, not a
   * request): the branch, and the commit on any remote branch. A report links only what is there. A branch only this
   * machine has is replaced by the remote branch that holds the commit, and `localBranch` keeps its name.
   */
  git?: {
    branch?: string;
    localBranch?: string;
    commit?: string;
    remote?: string;
    changed?: string[];
    changedCount?: number;
    pushed?: { branch: boolean; commit: boolean };
  };
  /** The seed, locale, time zone and epoch the run was asked to launch with; absent when it asked for none. */
  launch?: RunLaunch;
  /** Cases by their last attempt. */
  totals?: { cases: number; passed: number; failed: number; unsupported: number; retried: number };
};

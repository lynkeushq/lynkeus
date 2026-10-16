/**
 * The fixtures protocol: how a case prepares and reads a backend through a server the project writes. lynkeus starts
 * the command `cases.fixtures` names and speaks JSON lines to it, one request and one answer per line.
 * The full contract is docs/FIXTURES.md.
 */
export const FIXTURES_PROTOCOL = 1;

/** One step, as lynkeus sends it: `params` as the case wrote them, `env` the same flattened to upper-case strings. */
export type FixtureRequest = { command: string; params: Record<string, unknown>; env: Record<string, string> };

/** Any JSON object; `ok: false` with an `error` when the step failed. */
export type FixtureAnswer = { ok?: boolean; error?: string } & Record<string, unknown>;

/** A parameter a command takes, for authors and models choosing a setup. */
export type FixtureParam = {
  type?: 'string' | 'number' | 'boolean' | 'object' | 'array';
  summary?: string;
  /** The values it takes, when they are few. */
  values?: (string | number | boolean)[];
  default?: unknown;
  required?: boolean;
};

/** What a command does, for authors and models: what state it makes or reads, its parameters, one example. */
export type FixtureCommand = {
  name: string;
  summary?: string;
  params?: Record<string, FixtureParam>;
  /** The params of one call that works, as a case would write them. */
  example?: Record<string, unknown>;
  /** What its answer carries that a later step reads (`user_id`, `api_key`…). */
  answers?: string[];
  /** `false` for a command that only reads: safe to call while checking a server. */
  changes?: boolean;
};

/**
 * The answer to `lynkeus.describe`. `commands` lists names, or descriptions, or both; a server from before
 * descriptions answers names only, and that stays valid. `down` says the server runs but cannot serve.
 */
export type FixturesDescription = { protocol?: number; commands: (string | FixtureCommand)[]; down?: string };

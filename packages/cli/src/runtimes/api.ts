/**
 * The one module a runtime's directory imports from the core: the adapter it implements and the few helpers it may
 * use. A runtime reaching past this into the core's internals is refused by scripts/check-runtime-boundary.mjs, so a
 * runtime could later be its own package with this file as its contract.
 */
import type { LynkeusConfig } from '../config.js';
import type { SetupCheck } from '../commands/init.js';
import type { RouteParamsInfo } from '../knowledge/route-params.js';
import type { ScreenGraph } from '../knowledge/types.js';
import type { Ctx, Result } from '../registry.js';
import type { RuntimeId } from './detect.js';

export { ensureToken, lynkeusDir, portFromEnv, readToken, tokenFile } from '../config.js';
export type { LynkeusConfig } from '../config.js';
export { runHost } from '../commands/hostProcess.js';
export type { SetupCheck } from '../commands/init.js';
export type { FileFacts, NavigationEdge, NavigationTrigger, ScreenGraph, ScreenNode, Selector, SourcePath } from '../knowledge/types.js';
export type { RouteParamsInfo } from '../knowledge/route-params.js';
export type { Ctx, Result } from '../registry.js';
export { pubspecName, runtimeOf, type RuntimeId } from './detect.js';

/**
 * React Native's own code that still lives in the core, where it was before runtimes had directories. Its runtime
 * reaches it only through here; moving it under runtimes/react-native is listed in docs/ARCHITECTURE.md.
 */
export { headlessMissing, installAgent, mountAgent, setupChecks } from '../commands/init.js';
export { readRouteParams } from '../knowledge/route-params.js';
/** The TypeScript reader brings a compiler with it: only a command that builds the graph pays for loading it. */
export const reactNativeExtractor = () => import('../knowledge/extract.js');

/** What the core asks a runtime, instead of asking which runtime a folder is. */
export type RuntimeAdapter = {
  id: RuntimeId;
  /** `lynkeus init`: sets the agent up and says what is left to do. */
  init: (root: string, options: { install: boolean; headless: boolean }) => string[];
  /** `lynkeus status`, from the files alone. */
  setupChecks: (root: string) => SetupCheck[];
  /** What attaches an app when none is attached. */
  attachFix: string;
  /** Whether the app can run headless; `entry` is the headless entry the flags or config name. */
  headlessCheck: (root: string, entry: string) => SetupCheck;
  /** `lynkeus headless start`; without it, the core's Node host under jest. */
  startHeadless?: (ctx: Ctx, token: string) => Promise<Result>;
  /** Why the route graph cannot be read here, or undefined when it can. */
  graphMissing: (root: string) => string | undefined;
  /** The route graph; what could not be read is told to `warn`, for a runtime whose reader reports it. */
  buildGraph: (root: string, warn?: (line: string) => void) => Promise<ScreenGraph>;
  /** The files of a diff that are the app's source, and whether the diff is named from the app's folder. */
  sources: { pattern: RegExp; relative: boolean };
  /** What each route needs to open, for `smoke`. */
  routeParams: (appRoot: string, paramsFile: string | undefined, graph: ScreenGraph) => RouteParamsInfo[];
  /** The FastSim build for `--platform`: a platform per build, or one build for both. Throws on a platform it lacks. */
  fastsimBuild: (platform: string) => string;
  /** What a host started with `--host-command` reads from the environment. */
  hostCommandEnv: (config: LynkeusConfig) => Record<string, string>;
  /** How the case runner reaches what a step names. */
  runner: {
    /** A control just below the window is reached in short pulls rather than screenfuls. */
    shortPullsBelow: boolean;
    /** `app.wait: { text: X }` always waits for the text X, never a route. */
    waitTextIsText: boolean;
  };
};

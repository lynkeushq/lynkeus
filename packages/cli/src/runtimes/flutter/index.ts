/** Flutter: the Dart agent, `flutter test` as the headless host, and the routes read from the Dart source. */
import fs from 'node:fs';
import path from 'node:path';

import { type Ctx, portFromEnv, type Result, type RuntimeAdapter, runHost } from '../api.js';
import { findFlutter, flutterHostEnv, flutterNetworkEnv, flutterProject, writeFlutterHost } from './host.js';
import { initFlutter } from './init.js';
import { extractFlutterGraph, flutterRouteParams } from './routes.js';
import { flutterChecks, flutterHeadlessCheck } from './status.js';

/** `headless start` for a Flutter app: its own main() inside `flutter test`, through lynkeus_headless. */
const startFlutter = async (ctx: Ctx, token: string): Promise<Result> => {
  const project = flutterProject(ctx.root)!;
  if (!project.hosted)
    return {
      text: 'lynkeus headless hosts a Flutter app through the lynkeus_headless package: add it to dev_dependencies in pubspec.yaml (`flutter pub add --dev lynkeus_headless`, or a path to flutter/lynkeus_headless).',
      code: 1,
    };
  const sdk = findFlutter(ctx.root);
  if (!sdk)
    return { text: 'lynkeus headless runs a Flutter app under `flutter test` and found no Flutter SDK: put flutter on PATH or set FLUTTER_ROOT.', code: 1 };
  const entry = (ctx.flags.entry as string | undefined) ?? (ctx.config.entry?.endsWith('.dart') ? ctx.config.entry : 'lib/main.dart');
  if (!fs.existsSync(path.join(ctx.root, entry)))
    return { text: `No ${entry} in ${ctx.root}: the host runs the app's main() from it (--entry to name another).`, code: 1 };
  const port = portFromEnv(ctx.config);
  const file = writeFlutterHost(ctx.root, project, entry, port);
  const env = { ...process.env, ...flutterHostEnv(sdk, token, port, ctx.config.flutterHost), LYNKEUS_HEADLESS: '1' };
  return { code: await runHost(ctx, sdk.bin, ['test', path.relative(ctx.root, file), ...ctx.passthrough], env) };
};

export const flutter: RuntimeAdapter = {
  id: 'flutter',
  init: (root, options) => initFlutter(root, options),
  setupChecks: flutterChecks,
  attachFix: 'run the app in debug with `flutter run --dart-define=LYNKEUS_TOKEN=$(cat .lynkeus/token)`; or `lynkeus headless start` for no simulator',
  headlessCheck: (root) => flutterHeadlessCheck(root),
  startHeadless: startFlutter,
  graphMissing: () => undefined,
  buildGraph: async (root, warn) => {
    const graph = extractFlutterGraph({ root });
    if (warn) for (const warning of graph.warnings) warn(`  warning  ${warning}`);
    return graph;
  },
  // A Flutter app's graph names files from the app's folder, which is often not the repository's root.
  sources: { pattern: /\.dart$/, relative: true },
  routeParams: (_appRoot, _paramsFile, graph) => flutterRouteParams(graph),
  // One build per machine draws both platforms: the platform is chosen when the app runs.
  fastsimBuild: () => 'flutter',
  // A Flutter FastSim host fences its app's network as headless does, to the same flutterHost.networkHosts.
  hostCommandEnv: (config) => flutterNetworkEnv(config.flutterHost),
  runner: {
    // A control known to be just below the window is reached in short pulls: a screenful would carry it out of the
    // window, and out of a list that only builds what is near the window.
    shortPullsBelow: true,
    // `{ text: Delete }` names a text, never a route, whatever its case, as it does in app.see.
    waitTextIsText: true,
  },
};

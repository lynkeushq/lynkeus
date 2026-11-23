/// Lets an app's plugins that have no method-channel default run on a Lynkeus host (headless or FastSim), where the
/// plugin registrant does not run and the agent's stand-ins answer the plugins' channels. On a simulator or a phone,
/// and in release builds, it does nothing.
library;

export 'src/plugins.dart' show LynkeusPlugins;

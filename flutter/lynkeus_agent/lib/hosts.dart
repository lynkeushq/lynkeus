/// For a host that runs a Flutter app with no native side under it (lynkeus_headless under `flutter test`; inside
/// Lynkeus FastSim the agent installs them itself): the stand-ins that answer the common plugins' channels.
library;

export 'src/plugins.dart' show PluginState, installPlugins;
export 'src/standins.dart' show StandIn, StandInMessenger, StandIns, explainHostError, noPlatformViews;

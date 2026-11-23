/// For a host that runs a Flutter app with no native side under it (lynkeus_headless under `flutter test`; inside
/// Lynkeus FastSim the agent installs them itself): the stand-ins that answer the common plugins' channels.
library;

export 'src/fence.dart' show FencedHttpOverrides, blockedMessage, defaultNetworkHosts, networkHostsFrom;
export 'src/plugins.dart' show PluginState, hostTimeZone, installPlugins;
export 'src/standins.dart' show StandIn, StandInMessenger, StandIns, explainHostError, noPlatformViews;

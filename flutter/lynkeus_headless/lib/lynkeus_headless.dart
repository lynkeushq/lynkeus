/// Hosts a Flutter app inside `flutter test` for Lynkeus: real layout and paint, a clock the host controls, and the
/// same agent the app carries on a device, so its cases run with no simulator.
library;

export 'src/host.dart' show HostConfig, hostApp;
export 'src/plugins.dart' show PluginState;
export 'src/standins.dart' show StandIn, StandIns;
export 'src/settings.dart' show HostSettings;

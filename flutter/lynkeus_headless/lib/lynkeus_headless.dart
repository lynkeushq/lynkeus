/// Hosts a Flutter app inside `flutter test` for Lynkeus: real layout and paint, a clock the host controls, and the
/// same agent the app carries on a device, so its cases run with no simulator.
library;

export 'src/host.dart' show hostApp;
export 'src/settings.dart' show HostSettings;

import 'package:flutter/foundation.dart';
import 'package:lynkeus_agent/lynkeus_agent.dart';
import 'package:shared_preferences_platform_interface/in_memory_shared_preferences_async.dart';
import 'package:shared_preferences_platform_interface/shared_preferences_async_platform_interface.dart';
import 'package:sqflite_platform_interface/sqflite_platform_interface.dart';

/*
 * A federated plugin's platform implementation is set by the app's plugin registrant, which a host does not run (its
 * native side is not there; what is, is a stand-in behind the plugin's method channel). A plugin whose platform
 * interface falls back to a method channel works as is. One with no such fallback throws until something is set:
 * each entry below sets it, and does so only when nothing is.
 *
 * The next one: find the platform interface's setter, add an entry that sets a channel-based or in-memory
 * implementation the interface package itself ships when it has one (it keeps pace with the interface), add the
 * interface to pubspec.yaml with the widest range whose both ends pass the tests, and a test here.
 */
final _withoutChannelDefault = <String, void Function()>{
  // sqflite 2.4 sets its factory only in sqflite_darwin's and sqflite_android's registerWith(); the method-channel
  // factory talks to com.tekartik.sqflite, which the agent answers with the system's SQLite.
  'sqflite': SqflitePlatform.initWithDatabaseFactoryMethodChannel,
  // SharedPreferencesAsync and SharedPreferencesWithCache have no channel at all; their in-memory implementation
  // lasts the run, as the legacy API's stand-in does, and is kept apart from it as Android's DataStore is.
  'shared_preferences (async)': () =>
      SharedPreferencesAsyncPlatform.instance ??= InMemorySharedPreferencesAsync.empty(),
};

/// The plugins without a method-channel default, made to work on a Lynkeus host.
abstract final class LynkeusPlugins {
  /// Call it on the line after `LynkeusAgent.start()`. It acts only when the agent runs on a Lynkeus host.
  static void ensureInitialized() {
    if (kReleaseMode || !LynkeusAgent.standingIn) return;
    for (final init in _withoutChannelDefault.values) {
      init();
    }
  }

  /// The plugins [ensureInitialized] sets up.
  static Iterable<String> get covered => _withoutChannelDefault.keys;
}

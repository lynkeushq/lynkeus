import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

import 'fastsim.dart';
import 'link.dart';
import 'methods.dart';
import 'network.dart';
import 'plugins.dart';
import 'routes.dart';

const agentVersion = '0.7.5';
const protocolVersion = 2;

const _token = String.fromEnvironment('LYNKEUS_TOKEN');
const _host = String.fromEnvironment('LYNKEUS_HOST');
const _port = int.fromEnvironment('LYNKEUS_PORT', defaultValue: 8123);

const _noToken =
    'lynkeus: no token, so the agent stays off. Build the app with --dart-define=LYNKEUS_TOKEN=\$(cat .lynkeus/token) '
    '(the token `lynkeus init` wrote), or pass LynkeusAgent.start(token: ...).';

/// Lets Lynkeus read and drive this app (docs/PROTOCOL.md): it dials the driver on the computer, proves it holds the
/// project's token, and answers what the screen shows and where to press. Off in release builds, where the compiler
/// leaves it out.
abstract final class LynkeusAgent {
  static Link? _link;
  static Methods? _methods;
  static final _pending = <String, Command>{};
  static ({String token, String? host, int? port, Map<String, Object?> app})? _hosted;

  /// For a host that runs the app itself (lynkeus_headless), before the app's `main()`: the token, the driver's
  /// address and the app description the app's own [start] call uses when it gives none.
  static void hostedBy({required String token, String? host, int? port, Map<String, Object?> app = const {}}) =>
      _hosted = (token: token, host: host, port: port, app: app);

  /// The app's requests in flight: a host that runs its own clock keeps it at the wall's pace while one is out.
  static int get requestsInFlight => _methods?.network?.inFlight ?? 0;

  /// Driver requests being served: a host fast-forwards its clock while the driver waits on the app.
  static int get serving => _methods?.serving ?? 0;

  /// Follows a Navigator's named routes: `MaterialApp(navigatorObservers: [LynkeusAgent.navigatorObserver])`. Used
  /// for `route`, `path` and `navigate` unless [start] is given routes of the app's own (a router's).
  static final navigatorObserver = LynkeusNavigatorObserver();

  /// Starts dialing the driver. Call once from `main()`, before `runApp`. The token comes from
  /// `--dart-define=LYNKEUS_TOKEN=...` unless given; `host` and `port` from `LYNKEUS_HOST` and `LYNKEUS_PORT`.
  ///
  /// Inside Lynkeus FastSim it must come before anything calls `WidgetsFlutterBinding.ensureInitialized()`: the
  /// binding it then makes gives the app the device's safe area. On a simulator or a phone the order changes nothing.
  static void start({
    String? token,
    String? host,
    int? port,
    Map<String, Object?> app = const {},
    LynkeusRoutes? routes,
  }) {
    if (kReleaseMode || _link != null) return;
    final fastsim = FastSimHost.detect();
    final hosted = _hosted;
    final secret = token ?? fastsim?.token ?? hosted?.token ?? _token;
    if (secret.isEmpty) {
      debugPrint(_noToken);
      return;
    }
    fastsim?.installBinding();
    WidgetsFlutterBinding.ensureInitialized();
    final methods = Methods()
      ..commands.addAll(_pending)
      ..routes = routes ?? navigatorObserver.routes;
    _pending.clear();
    _methods = methods;
    final where = host ?? fastsim?.driverHost ?? hosted?.host ?? (_host.isEmpty ? null : _host);
    _link = Link(
      token: secret,
      // The computer is 10.0.2.2 from the Android emulator, and localhost from a phone on USB once the CLI has run
      // `adb reverse`.
      hosts: where != null ? [where] : (Platform.isAndroid ? ['10.0.2.2', '127.0.0.1'] : ['127.0.0.1']),
      port: port ?? fastsim?.port ?? hosted?.port ?? _port,
      hello: () => {
        'protocolVersion': protocolVersion,
        'agentVersion': agentVersion,
        'platform': switch (defaultTargetPlatform) {
          TargetPlatform.iOS => 'ios',
          TargetPlatform.android => 'android',
          final other => other.name,
        },
        'native': true,
        'commands': methods.commandNames(),
        'route': ?methods.currentRoute(),
        'app': {
          'runtime': 'flutter',
          ...app,
          ...?hosted?.app,
          if (fastsim != null) ...{
            'runtime': 'flutter-fastsim',
            'fastsim': {'binding': fastsim.ownsBinding ? 'lynkeus' : 'app'},
          },
        },
      },
      serve: methods.call,
    );
    methods.onNavigation = (route) => _link?.emit({'event': 'navigation', 'route': ?route});
    // After the link has its own HttpClient, so the agent's socket is not among the app's requests.
    final network = Network(trace: methods.record)..install();
    methods.network = network;
    for (final entry in network.commands.entries) {
      methods.commands.putIfAbsent(entry.key, () => entry.value);
    }
    final standIns = fastsim?.standIns;
    if (standIns != null) {
      final messenger = ServicesBinding.instance.defaultBinaryMessenger;
      installPlugins(
        standIns,
        PluginState(Directory.systemTemp.createTempSync('lynkeus-fastsim-')),
        register,
        // ignore: deprecated_member_use
        (channel, message) => messenger.handlePlatformMessage(channel, message, null),
        fastsim!.env['FASTSIM_OS'] ?? Platform.operatingSystem,
      );
    }
    final link = _link!;
    if (fastsim == null) {
      link.start();
      return;
    }
    void activity() => fastsim.activity(serving: methods.serving, inFlight: network.inFlight);
    methods.onServing = activity;
    network.onInFlight = activity;
    // The driver must see the host's commands (clock first of all) in its first hello, or it takes the app for one
    // on a device: dial once the host has said what it serves.
    unawaited(
      fastsim.hello(agentVersion).then((served) {
        for (final name in served) {
          methods.commands[name] = (params) => fastsim.call(name, params);
        }
        link.start();
      }),
    );
  }

  /// A command the driver can call by name, like a core method (`lynkeus call <name>`). Two names mean something to
  /// drivers: `reset` (leave the app as freshly installed) and `busy` (true while the app has work in flight).
  static void register(String name, FutureOr<Object?> Function(Object? params) handler) {
    if (!RegExp(r'^[a-zA-Z][\w.-]*$').hasMatch(name)) throw ArgumentError('Invalid command name "$name"');
    (_methods?.commands ?? _pending)[name] = handler;
  }

  static void unregister(String name) {
    _methods?.commands.remove(name);
    _pending.remove(name);
  }

  /// Stops dialing and drops the link.
  static void stop() {
    _link?.stop();
    _link = null;
    _methods = null;
  }
}

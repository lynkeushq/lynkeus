import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';

import 'link.dart';
import 'methods.dart';

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

  /// Starts dialing the driver. Call once from `main()`, before `runApp`. The token comes from
  /// `--dart-define=LYNKEUS_TOKEN=...` unless given; `host` and `port` from `LYNKEUS_HOST` and `LYNKEUS_PORT`.
  static void start({String? token, String? host, int? port, Map<String, Object?> app = const {}}) {
    if (kReleaseMode || _link != null) return;
    final secret = token ?? _token;
    if (secret.isEmpty) {
      debugPrint(_noToken);
      return;
    }
    WidgetsFlutterBinding.ensureInitialized();
    final methods = Methods()..commands.addAll(_pending);
    _pending.clear();
    _methods = methods;
    final where = host ?? (_host.isEmpty ? null : _host);
    _link = Link(
      token: secret,
      // The computer is 10.0.2.2 from the Android emulator, and localhost from a phone on USB once the CLI has run
      // `adb reverse`.
      hosts: where != null ? [where] : (Platform.isAndroid ? ['10.0.2.2', '127.0.0.1'] : ['127.0.0.1']),
      port: port ?? _port,
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
        'app': {'runtime': 'flutter', ...app},
      },
      serve: methods.call,
    )..start();
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

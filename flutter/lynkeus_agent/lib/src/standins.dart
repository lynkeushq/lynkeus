import 'dart:async';
import 'dart:ui' as ui;

import 'package:flutter/services.dart';

/// What a stand-in answers a call with: a value, or a [PlatformException] it throws.
typedef StandIn = FutureOr<Object?> Function(String method, List<Object?> args);

const _codec = StandardMessageCodec();
const _methods = StandardMethodCodec();

/*
 * Where there is no native side (the headless host under flutter test, the FastSim host in Flutter's embedder), a
 * plugin's platform channel goes unanswered: a method channel throws MissingPluginException, a Pigeon channel fails
 * to connect, and a message nobody replies to leaves its await hanging. A host that runs the app answers every
 * channel here instead. A stand-in answers the common plugins from memory, as their native side would; any other
 * channel gets an empty success (null) and one `[stub] <channel>` line, so the app's await never hangs and the log
 * says what to stand in. On a simulator or a phone none of this is installed: the real plugins answer.
 *
 * Plugins speak two shapes: a method channel (a method name and arguments, a success or error envelope) and Pigeon
 * (one channel per method, `dev.flutter.pigeon.<package>.<Api>.<method>`, arguments and reply as lists). Both decode
 * to a method name and a list of arguments here.
 */
class StandIns {
  /// [hostSaysViews]: the host's hello is yet to say whether it answers the native-view channels itself (FastSim);
  /// their calls wait for it. Otherwise the stand-ins answer them from the start.
  StandIns({required this.log, this.trace = false, bool hostSaysViews = false}) {
    // A host draws no native views: an app's UiKitView or AndroidView gets a clear error instead of the engine's
    // MissingPluginException, and the rest of the screen goes on.
    for (final channel in _platformViews) {
      add(channel, _platformView);
    }
    if (!hostSaysViews) hostAnswersPlatformViews(false);
  }

  static const _platformViews = ['flutter/platform_views', 'flutter/platform_views_2'];

  /// Whether [channel] is one of the engine's native-view channels.
  static bool isPlatformViews(String channel) => _platformViews.contains(channel);

  final _hostViews = Completer<bool>();

  /// Whether the host answers the native-view channels itself (FastSim's placeholder, `platformViews: "placeholder"`
  /// in its hello). Completes once the host has said, false for a host that does not.
  Future<bool> get hostViews => _hostViews.future;
  bool? _hostViewsNow;

  /// Set once, from the host's hello; a later call changes nothing.
  void hostAnswersPlatformViews(bool value) {
    if (_hostViews.isCompleted) return;
    _hostViewsNow = value;
    _hostViews.complete(value);
  }

  final void Function(String line) log;

  /// Print every call and its answer (LYNKEUS_CHANNELS=trace).
  final bool trace;

  /// By method-channel name, or by Pigeon API (`dev.flutter.pigeon.<package>.<Api>`).
  final handlers = <String, StandIn>{};
  final _stubbed = <String>{};

  void add(String channelOrApi, StandIn handler) => handlers[channelOrApi] = handler;

  /// The engine's own channels and the host's are not a plugin's: they go where they would go anyway. Native views
  /// are the one engine channel answered here, unless [hostViews] says the host answers them (FastSim draws a
  /// placeholder); headless and older hosts have nothing behind them.
  static bool handles(String channel, {bool hostViews = false}) =>
      (!hostViews && _platformViews.contains(channel)) ||
      (!channel.startsWith('flutter/') && !channel.startsWith('lynkeus/'));

  final _blankViews = <String>{};

  Object? _platformView(String method, List<Object?> args) {
    if (method != 'create') return null;
    final params = args.isNotEmpty && args.first is Map ? args.first! as Map : const {};
    final type = '${params['viewType'] ?? 'a native view'}';
    final message = noPlatformViews(type);
    if (_blankViews.add(type)) log(message);
    throw PlatformException(code: 'unsupported', message: message);
  }

  /// The reply a plugin's native side would give to [message] on [channel].
  Future<ByteData?> answer(String channel, ByteData? message) async {
    final pigeon = channel.startsWith('dev.flutter.pigeon.');
    final String api;
    final String method;
    final List<Object?> args;
    if (pigeon) {
      final dot = channel.lastIndexOf('.');
      api = channel.substring(0, dot);
      method = channel.substring(dot + 1);
      final decoded = message == null ? null : _codec.decodeMessage(message);
      args = decoded is List ? decoded : const [];
    } else {
      api = channel;
      MethodCall? call;
      try {
        call = message == null ? null : _methods.decodeMethodCall(message);
      } on Object {
        call = null;
      }
      method = call?.method ?? '';
      args = call == null ? const [] : (call.arguments is List ? call.arguments as List<Object?> : [call.arguments]);
    }
    final handler = handlers[api];
    Object? result;
    PlatformException? failure;
    if (handler == null) {
      if (_stubbed.add(channel)) log('[stub] $channel${method.isEmpty || pigeon ? '' : ' $method'}');
    } else {
      try {
        result = await handler(method, args);
      } on PlatformException catch (error) {
        failure = error;
      }
    }
    if (trace) log('[channel] $channel $method $args → ${failure?.code ?? result}');
    if (pigeon) {
      return _codec.encodeMessage(failure == null ? [result] : [failure.code, failure.message, failure.details]);
    }
    return failure == null
        ? _methods.encodeSuccessEnvelope(result)
        : _methods.encodeErrorEnvelope(code: failure.code, message: failure.message, details: failure.details);
  }
}

/// The app's messenger with the plugins' channels answered by [standIns]: what the FastSim binding gives the app.
class StandInMessenger extends BinaryMessenger {
  StandInMessenger(this.inner, this.standIns, {this.sent});

  final BinaryMessenger inner;
  final StandIns standIns;

  /// Shown every message the app sends on, before it goes: what the binding acts on as the device would.
  final void Function(String channel, ByteData? message)? sent;

  @override
  Future<ByteData?>? send(String channel, ByteData? message) {
    sent?.call(channel, message);
    final hostViews = standIns._hostViewsNow;
    // An app can make a native view before the host's hello reply is in: its calls wait for it, so the view goes
    // where the host says.
    if (hostViews == null && StandIns.isPlatformViews(channel)) {
      return standIns.hostViews.then((_) => _route(channel, message));
    }
    return _route(channel, message);
  }

  Future<ByteData?>? _route(String channel, ByteData? message) =>
      StandIns.handles(channel, hostViews: standIns._hostViewsNow ?? false)
      ? standIns.answer(channel, message)
      : inner.send(channel, message);

  @override
  void setMessageHandler(String channel, MessageHandler? handler) => inner.setMessageHandler(channel, handler);

  @override
  // ignore: deprecated_member_use
  Future<void> handlePlatformMessage(String channel, ByteData? data, ui.PlatformMessageResponseCallback? callback) =>
      // ignore: deprecated_member_use
      inner.handlePlatformMessage(channel, data, callback);
}

/// Why a native view stays blank under a host.
String noPlatformViews(String viewType) =>
    'lynkeus: $viewType is a native view (UiKitView, AndroidView), and a Lynkeus host (headless or FastSim) draws '
    'none: it stays blank there, and a step aimed inside it fails. Cases can still check everything around it; look '
    'at it on a simulator or a phone.';

/// A plugin with no method-channel default fails under a host, where the plugin registrant does not run and no
/// platform implementation is set: the line that says so, for the error the app reports; null for any other error.
String? explainHostError(Object error) {
  final text = '$error';
  final plugin =
      RegExp(r'platform implementation for `([\w]+)` has not been set').firstMatch(text)?.group(1) ??
      (text.contains('databaseFactory not initialized') ? 'sqflite' : null) ??
      (text.contains('SharedPreferencesAsyncPlatform instance must be set')
          ? 'shared_preferences (SharedPreferencesAsync, SharedPreferencesWithCache)'
          : null);
  if (plugin == null) return null;
  return 'lynkeus: `$plugin` has no method-channel default, and a Lynkeus host (headless or FastSim) registers no '
      "plugin's native implementation, so it does not work there${plugin == 'webview_flutter' ? ' (a web view is a native view, which a host does not draw)' : ''}. "
      'Cover that screen on a simulator or a phone.';
}

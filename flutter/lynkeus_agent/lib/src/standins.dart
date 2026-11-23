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
  StandIns({required this.log, this.trace = false});

  final void Function(String line) log;

  /// Print every call and its answer (LYNKEUS_CHANNELS=trace).
  final bool trace;

  /// By method-channel name, or by Pigeon API (`dev.flutter.pigeon.<package>.<Api>`).
  final handlers = <String, StandIn>{};
  final _stubbed = <String>{};

  void add(String channelOrApi, StandIn handler) => handlers[channelOrApi] = handler;

  /// The engine's own channels and the host's are not a plugin's: they go where they would go anyway.
  static bool handles(String channel) => !channel.startsWith('flutter/') && !channel.startsWith('lynkeus/');

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
    return StandIns.handles(channel) ? standIns.answer(channel, message) : inner.send(channel, message);
  }

  @override
  void setMessageHandler(String channel, MessageHandler? handler) => inner.setMessageHandler(channel, handler);

  @override
  // ignore: deprecated_member_use
  Future<void> handlePlatformMessage(String channel, ByteData? data, ui.PlatformMessageResponseCallback? callback) =>
      // ignore: deprecated_member_use
      inner.handlePlatformMessage(channel, data, callback);
}

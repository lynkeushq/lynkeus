import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

/// What a stand-in answers a call with: a value, or a [PlatformException] it throws.
typedef StandIn = FutureOr<Object?> Function(String method, List<Object?> args);

const _codec = StandardMessageCodec();
const _methods = StandardMethodCodec();

/*
 * Plugins talk to their native side over platform channels, which flutter_test leaves unanswered: a method channel
 * throws MissingPluginException and a Pigeon channel fails to connect. The host answers every channel itself. A
 * stand-in answers the common plugins from memory, as their native side would; any other channel gets an empty
 * success (null) and one `[stub] <channel>` line, so the app's await never hangs and the log says what to stand in.
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

  void install(TestDefaultBinaryMessenger messenger) {
    messenger.allMessagesHandler = (channel, mock, message) {
      // flutter_test's own (text input, the system channels it mocks) and anything a test set keep answering.
      if (mock != null) return mock(message);
      if (channel.startsWith('flutter/')) return messenger.delegate.send(channel, message);
      return _answer(channel, message);
    };
  }

  Future<ByteData?> _answer(String channel, ByteData? message) async {
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

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:clock/clock.dart';
import 'package:crypto/crypto.dart';

/// Fails a request with a message the driver shows as it is.
class AgentError implements Exception {
  AgentError(this.message, {this.code});
  final String message;
  final String? code;
  @override
  String toString() => message;
}

typedef Serve = Future<Object?> Function(String method, Object? params);

const _eagerMs = 3000;
const _replayWindow = 64;
final _nonce = RegExp(r'^[0-9a-f]{32,128}$');

String proofOf(String token, String who, String session, String driverNonce, String appNonce) =>
    Hmac(sha256, utf8.encode(token)).convert(utf8.encode('lynkeus/$who/$session/$driverNonce/$appNonce')).toString();

/// Equal strings, compared without stopping at the first difference.
bool sameHex(Object? a, String b) {
  if (a is! String || a.length != b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) {
    diff |= a.codeUnitAt(i) ^ b.codeUnitAt(i);
  }
  return diff == 0;
}

String _randomHex() {
  final random = Random.secure();
  return List.generate(16, (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0')).join();
}

/// The app end of the link (docs/PROTOCOL.md): dials the driver, retries quietly while nobody listens, proves the token
/// both ways and serves requests.
class Link {
  Link({
    required this.token,
    required this.hosts,
    required this.port,
    required this.hello,
    required this.serve,
    this.reconnectMs = 1500,
    this.onError,
  });

  final String token;

  /// Tried in turn while none answers: an Android emulator reaches the computer at 10.0.2.2, a phone on USB at
  /// localhost once the CLI has run `adb reverse`.
  final List<String> hosts;
  final int port;
  final Map<String, Object?> Function() hello;
  final Serve serve;

  /// The longest wait between dials. For 3 s after a link drops (or the app starts) it dials every 100 ms; then each
  /// wait doubles up to this.
  final int reconnectMs;
  final void Function(Object error, String context)? onError;

  final _client = HttpClient()..connectionTimeout = const Duration(seconds: 1);
  WebSocket? _socket;
  Timer? _timer;
  bool _stopped = false;
  int _at = 0;
  late int _delay = min(100, reconnectMs);
  late int _eagerUntil = clock.now().millisecondsSinceEpoch + _eagerMs;

  // The driver resends in-flight requests verbatim after a reconnect. One the app already ran (only the reply was
  // lost) answers from the recorded reply: a press is not idempotent. Keyed by driver session, since every driver
  // numbers its requests from 1.
  final _replies = <String, String>{};
  final _running = <String, Future<void>>{};
  String _session = '';

  bool get connected => _socket != null;

  void start() => _connect();

  void stop() {
    _stopped = true;
    _timer?.cancel();
    _socket?.close();
    _client.close(force: true);
  }

  /// Sends an event to the driver when one is attached; dropped otherwise.
  void emit(Map<String, Object?> event) => _send(_socket, event);

  void _send(WebSocket? ws, Map<String, Object?> message) => _sendText(ws, jsonEncode(message));

  void _sendText(WebSocket? ws, String text) {
    if (ws == null || ws.readyState != WebSocket.open) return;
    ws.add(text);
  }

  Future<void> _connect() async {
    if (_stopped) return;
    final WebSocket ws;
    try {
      ws = await WebSocket.connect('ws://${hosts[_at]}:$port', customClient: _client);
    } catch (_) {
      // Nobody listening is the normal case; stay quiet and try the next host.
      _at = (_at + 1) % hosts.length;
      _again();
      return;
    }
    if (_stopped) {
      await ws.close();
      return;
    }
    _socket = ws;
    _delay = min(100, reconnectMs);
    _eagerUntil = -1;
    final state = _Handshake();
    ws.listen(
      (data) => _onMessage(ws, state, data),
      onDone: () {
        if (identical(_socket, ws)) _socket = null;
        if (_stopped) return;
        if (_eagerUntil == -1) _eagerUntil = clock.now().millisecondsSinceEpoch + _eagerMs;
        _again();
      },
      onError: (Object error) => onError?.call(error, 'socket'),
      cancelOnError: false,
    );
  }

  void _again() {
    if (_stopped) return;
    _timer = Timer(Duration(milliseconds: _delay), _connect);
    if (_eagerUntil != -1 && clock.now().millisecondsSinceEpoch >= _eagerUntil) _delay = min(_delay * 2, reconnectMs);
  }

  void _onMessage(WebSocket ws, _Handshake state, Object? data) {
    final Object? parsed;
    try {
      parsed = jsonDecode(data is String ? data : utf8.decode(data as List<int>));
    } catch (_) {
      return;
    }
    if (parsed is! Map) return;
    final event = parsed['event'];
    if (event == 'auth') {
      final session = parsed['session'];
      if (session is! String || session.isEmpty) return;
      if (session != _session) {
        _replies.clear();
        _session = session;
      }
      // A driver that sends no nonce speaks the old handshake, which handed the token to whoever listened.
      final nonce = parsed['nonce'];
      if (nonce is! String || !_nonce.hasMatch(nonce)) return;
      state
        ..verified = false
        ..driverNonce = nonce
        ..appNonce = _randomHex();
      _send(ws, {
        ...hello(),
        'event': 'hello',
        'nonce': state.appNonce,
        'proof': proofOf(token, 'app', _session, state.driverNonce, state.appNonce),
      });
      return;
    }
    if (event == 'verified') {
      if (state.appNonce.isEmpty) return;
      // Whatever listens on the port gets nothing but our proof unless it proves the token too.
      if (sameHex(parsed['proof'], proofOf(token, 'driver', _session, state.driverNonce, state.appNonce))) {
        state.verified = true;
      } else {
        ws.close(1008);
      }
      return;
    }
    if (event != null) return;
    final id = parsed['id'];
    final method = parsed['method'];
    if (id is! num || method is! String) return;
    if (!state.verified) {
      _send(ws, {
        'id': id,
        'error': {'message': 'Not authenticated', 'code': 'unauthenticated'},
      });
      return;
    }
    unawaited(_serve(id, method, parsed['params']));
  }

  Future<void> _serve(num id, String method, Object? params) async {
    final key = '$_session:$id';
    final seen = _replies[key];
    if (seen != null) {
      _sendText(_socket, seen);
      return;
    }
    final active = _running[key];
    if (active != null) {
      await active;
      return;
    }
    final run = () async {
      String reply;
      try {
        // Encoded here, so a result that is not JSON (an app command's) fails this request rather than the link.
        reply = jsonEncode({'id': id, 'result': await serve(method, params)});
      } catch (error) {
        onError?.call(error, method);
        reply = jsonEncode({
          'id': id,
          'error': {
            'message': error is AgentError ? error.message : '$error',
            if (error is AgentError && error.code != null) 'code': error.code,
          },
        });
      }
      _replies[key] = reply;
      if (_replies.length > _replayWindow) _replies.remove(_replies.keys.first);
      _sendText(_socket, reply);
    }();
    _running[key] = run;
    try {
      await run;
    } finally {
      _running.remove(key);
    }
  }
}

class _Handshake {
  String driverNonce = '';
  String appNonce = '';
  bool verified = false;
}

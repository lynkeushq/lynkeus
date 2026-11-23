import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:lynkeus_agent/src/link.dart';

const token = 'project-token';
final driverNonce = 'ab' * 16;

/// A driver in a few lines: listens, sends auth, checks the app's proof, proves itself, sends requests.
class Driver {
  Driver._(this.server);
  final HttpServer server;
  final _sockets = StreamController<WebSocket>.broadcast();
  final _messages = StreamController<Map<String, Object?>>.broadcast();
  WebSocket? socket;

  static Future<Driver> listen() async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final driver = Driver._(server);
    server.transform(WebSocketTransformer()).listen((ws) {
      driver.socket = ws;
      driver._sockets.add(ws);
      ws.listen((data) => driver._messages.add((jsonDecode(data as String) as Map).cast<String, Object?>()));
    });
    return driver;
  }

  Future<WebSocket> next() => _sockets.stream.first.timeout(const Duration(seconds: 5));

  Future<Map<String, Object?>> receive() => _messages.stream.first.timeout(const Duration(seconds: 5));

  void send(Map<String, Object?> message) => socket!.add(jsonEncode(message));

  /// Runs the handshake on the socket that just connected and returns the app's hello.
  Future<Map<String, Object?>> handshake({String session = 'sess', bool prove = true}) async {
    final helloComing = receive();
    send({'event': 'auth', 'session': session, 'nonce': driverNonce});
    final hello = await helloComing;
    if (prove) {
      send({'event': 'verified', 'proof': proofOf(token, 'driver', session, driverNonce, hello['nonce']! as String)});
    }
    return hello;
  }

  Future<void> close() async {
    await socket?.close();
    await server.close(force: true);
  }
}

void main() {
  test('signs with the same HMAC-SHA256 the driver checks', () {
    expect(
      proofOf(token, 'app', 'sess', 'ab' * 16, 'cd' * 16),
      '3fe59738b1fb6228d6ca29bb5ca31913897cf7c6d9e91e0ec98b01403124a9c0',
    );
    expect(sameHex('abc', 'abc'), isTrue);
    expect(sameHex('abd', 'abc'), isFalse);
    expect(sameHex(null, 'abc'), isFalse);
  });

  group('the link', () {
    late Driver driver;
    late Link link;
    final served = <String>[];

    setUp(() async {
      served.clear();
      driver = await Driver.listen();
      link = Link(
        token: token,
        hosts: ['127.0.0.1'],
        port: driver.server.port,
        hello: () => {'protocolVersion': 2, 'platform': 'ios', 'native': true, 'commands': <String>[]},
        serve: (method, params) async {
          served.add(method);
          if (method == 'fail') throw AgentError('it failed', code: 'nope');
          return {'echo': params};
        },
      );
    });

    tearDown(() async {
      link.stop();
      await driver.close();
    });

    test('proves the token in its hello and serves only a driver that proves it too', () async {
      final connected = driver.next();
      link.start();
      await connected;
      final hello = await driver.handshake(prove: false);
      expect(hello['event'], 'hello');
      expect(hello['protocolVersion'], 2);
      expect(hello['proof'], proofOf(token, 'app', 'sess', driverNonce, hello['nonce']! as String));
      expect(hello.containsKey('token'), isFalse);

      final refused = driver.receive();
      driver.send({'id': 1, 'method': 'ping'});
      expect(await refused, {
        'id': 1,
        'error': {'message': 'Not authenticated', 'code': 'unauthenticated'},
      });
      expect(served, isEmpty);

      driver.send({
        'event': 'verified',
        'proof': proofOf(token, 'driver', 'sess', driverNonce, hello['nonce']! as String),
      });
      final reply = driver.receive();
      driver.send({
        'id': 2,
        'method': 'echo',
        'params': {'a': 1},
      });
      expect(await reply, {
        'id': 2,
        'result': {
          'echo': {'a': 1},
        },
      });
    });

    test('closes on a driver whose proof is wrong', () async {
      final connected = driver.next();
      link.start();
      final ws = await connected;
      await driver.handshake(prove: false);
      driver.send({'event': 'verified', 'proof': '00' * 32});
      await ws.done.timeout(const Duration(seconds: 5));
      expect(ws.closeCode, 1008);
    });

    test('ignores an auth without a nonce: the old handshake handed the token over', () async {
      final connected = driver.next();
      link.start();
      await connected;
      driver.send({'event': 'auth', 'session': 'sess'});
      await expectLater(driver.receive(), throwsA(isA<TimeoutException>()));
    });

    test('answers a request resent after a reconnect from the reply it kept', () async {
      var connected = driver.next();
      link.start();
      await connected;
      await driver.handshake();
      var reply = driver.receive();
      driver.send({'id': 7, 'method': 'press'});
      expect((await reply)['id'], 7);

      connected = driver.next();
      await driver.socket!.close();
      await connected;
      await driver.handshake();
      reply = driver.receive();
      driver.send({'id': 7, 'method': 'press'});
      expect((await reply)['id'], 7);
      expect(served, ['press'], reason: 'a press is not run twice');

      // A new driver numbers from 1 again: its id 7 is another request.
      connected = driver.next();
      await driver.socket!.close();
      await connected;
      await driver.handshake(session: 'other');
      reply = driver.receive();
      driver.send({'id': 7, 'method': 'press'});
      await reply;
      expect(served, ['press', 'press']);
    });

    test('reports a failure with its message and code', () async {
      final connected = driver.next();
      link.start();
      await connected;
      await driver.handshake();
      final reply = driver.receive();
      driver.send({'id': 3, 'method': 'fail'});
      expect(await reply, {
        'id': 3,
        'error': {'message': 'it failed', 'code': 'nope'},
      });
    });
  });

  test('dials again while nobody listens, every 100 ms at first', () async {
    final server = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    final port = server.port;
    await server.close();
    final link = Link(token: token, hosts: ['127.0.0.1'], port: port, hello: () => {}, serve: (_, _) async => null);
    link.start();
    await Future<void>.delayed(const Duration(milliseconds: 600));
    final driver = await HttpServer.bind(InternetAddress.loopbackIPv4, port);
    final arrived = Completer<void>();
    driver.transform(WebSocketTransformer()).listen((_) {
      if (!arrived.isCompleted) arrived.complete();
    });
    final started = DateTime.now();
    await arrived.future.timeout(const Duration(seconds: 2));
    expect(DateTime.now().difference(started).inMilliseconds, lessThan(500));
    link.stop();
    await driver.close(force: true);
  });
}

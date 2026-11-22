import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:lynkeus_agent/src/network.dart';

void main() {
  late HttpServer server;
  late Network network;
  late List<Map<String, Object?>> traced;
  late List<String> served;
  late Map<String, String> seenHeaders;

  setUp(() async {
    served = [];
    seenHeaders = {};
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((request) async {
      served.add('${request.method} ${request.uri}');
      request.headers.forEach((name, values) => seenHeaders[name] = values.join(','));
      final body = await utf8.decodeStream(request);
      request.response
        ..statusCode = request.uri.path == '/missing' ? 404 : 200
        ..headers.contentType = ContentType.json
        ..write(jsonEncode({'echo': body, 'accessToken': 'abc123'}));
      await request.response.close();
    });
    traced = [];
    network = Network(trace: traced.add)..install();
  });

  tearDown(() async {
    HttpOverrides.global = null;
    await server.close(force: true);
  });

  Uri at(String path) => Uri.parse('http://127.0.0.1:${server.port}$path');

  Future<(int, String)> fetch(String method, String path, {String? body}) async {
    final client = HttpClient();
    try {
      final request = await client.openUrl(method, at(path));
      if (body != null) request.write(body);
      final response = await request.close();
      return (response.statusCode, await utf8.decodeStream(response));
    } finally {
      client.close();
    }
  }

  List<Map<String, Object?>> records() => (network.requests(null)['requests']! as List).cast<Map<String, Object?>>();

  test('records each request with its status and a redacted URL, and traces it', () async {
    final (status, _) = await fetch('GET', '/items?page=2&token=secret');
    expect(status, 200);
    await fetch('GET', '/missing');
    final all = records();
    expect(all.map((r) => r['status']), [200, 404]);
    expect(all.first['url'], 'http://127.0.0.1:${server.port}/items?page=2&token=…');
    expect(all.first['method'], 'GET');
    expect(all.first.containsKey('request'), isFalse, reason: 'bodies only while a driver asks for them');
    expect(network.inFlight, 0);
    expect(traced.map((e) => e['status']), [200, 404]);
    expect(network.requests(all.first['id']! as int)['requests'], hasLength(1));
  });

  test('keeps headers and bodies, secrets replaced, while networkBodies is on', () async {
    network.commands['networkBodies']!({'on': true});
    await fetch('POST', '/login', body: jsonEncode({'user': 'ana', 'password': 'hunter2'}));
    final record = records().single;
    final request = record['request']! as Map;
    final response = record['response']! as Map;
    expect(request['body'], isNot(contains('hunter2')));
    expect(request['body'], contains('ana'));
    expect(response['body'], isNot(contains('abc123')));
    expect((response['headers']! as Map)['content-type'], contains('application/json'));
  });

  test('a netmock rule answers instead of the server, as many times as it says', () async {
    network.commands['netmock']!({
      'method': 'GET',
      'path': '/items',
      'status': 503,
      'body': {'error': 'down'},
      'times': 1,
    });
    final (status, body) = await fetch('GET', '/items');
    expect(status, 503);
    expect(jsonDecode(body), {'error': 'down'});
    expect(served, isEmpty);
    expect(records().single['mocked'], isTrue);
    expect(traced.single['mocked'], isTrue);
    final (again, _) = await fetch('GET', '/items');
    expect(again, 200);
    expect(served, ['GET /items']);
  });

  test(
    'a mocked request is in flight until it answers, but not on the wire: its delay is the agent\'s timer',
    () async {
      final changes = <(int, int)>[];
      network.onInFlight = () => changes.add((network.inFlight, network.onWire));
      network.commands['netmock']!({'method': 'GET', 'path': '/later', 'status': 200, 'delayMs': 200});
      final mocked = fetch('GET', '/later');
      await Future<void>.delayed(const Duration(milliseconds: 50));
      expect((network.inFlight, network.onWire), (1, 0));
      final real = fetch('GET', '/now');
      await Future<void>.delayed(Duration.zero);
      expect(network.onWire, 1);
      await real;
      await mocked;
      expect((network.inFlight, network.onWire), (0, 0));
      expect(changes, contains((1, 0)));
      expect(changes.last, (0, 0));
    },
  );

  test('a held request waits for the release and is not counted in flight', () async {
    network.commands['netmock']!({'action': 'hold', 'path': '^/slow'});
    final pending = fetch('GET', '/slow');
    await Future<void>.delayed(const Duration(milliseconds: 100));
    expect(network.held, 1);
    expect(network.inFlight, 0);
    expect(served, isEmpty);
    expect(network.commands['netmock']!({'action': 'release'}), {'released': 1, 'held': 0});
    final (status, _) = await pending;
    expect(status, 200);
    expect(served, ['GET /slow']);
  });

  test('a lost answer reaches the server and fails in the app', () async {
    network.commands['netmock']!({'method': 'POST', 'path': '/pay', 'lost': true});
    await expectLater(fetch('POST', '/pay', body: '{}'), throwsA(isA<HttpException>()));
    expect(served, ['POST /pay']);
    final record = records().single;
    expect(record['status'], 0);
    expect(record['mocked'], isTrue);
    expect(network.inFlight, 0);
  });

  test("sends the step's trace context, and clear drops every rule", () async {
    network.commands['traceContext']!({'traceparent': '00-${'a' * 32}-${'b' * 16}-01'});
    network.commands['netmock']!({'path': '/x', 'status': 500});
    network.commands['netmock']!({'action': 'clear'});
    await fetch('GET', '/x');
    expect(seenHeaders['traceparent'], '00-${'a' * 32}-${'b' * 16}-01');
    expect(records().single['status'], 200);
  });
}

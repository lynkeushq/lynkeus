import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:lynkeus_agent/src/fence.dart';
import 'package:lynkeus_agent/src/netcache.dart';
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

  test('a picture\'s body is told by its size, and the request still ends', () async {
    final picture = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    // Bytes a text redaction trips on: a real image's.
    final bytes = [137, 80, 78, 71, 13, 10, 26, 10, for (var i = 0; i < 4000; i++) (i * 37 + 11) % 256];
    picture.listen((r) {
      r.response
        ..headers.contentType = ContentType('image', 'png')
        ..add(bytes);
      r.response.close();
    });
    network.commands['networkBodies']!({'on': true});
    final client = HttpClient();
    try {
      final response = await (await client.getUrl(Uri.parse('http://127.0.0.1:${picture.port}/a.png'))).close();
      expect((await response.toList()).expand((c) => c).length, bytes.length);
    } finally {
      client.close();
      await picture.close(force: true);
    }
    expect(network.inFlight, 0);
    final record = records().single;
    expect(record['status'], 200);
    expect((record['response']! as Map)['body'], '[${bytes.length} bytes, image/png]');
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

  test('a request is done when its answer arrives, read or not', () async {
    final client = HttpClient();
    final response = await (await client.openUrl('GET', at('/missing'))).close();
    expect(response.statusCode, 404);
    // An image loader that turns down a status drops the body unread: the request must not stay in flight.
    expect(network.inFlight, 0);
    expect(records().single['status'], 404);
    expect(traced.single['status'], 404);
    client.close(force: true);
  });

  test(
    'behind the host\'s fence a request to another host fails at once, is listed, and netmock still answers',
    () async {
      HttpOverrides.global = FencedHttpOverrides({'127.0.0.1'});
      network = Network(trace: traced.add)..install();
      network.commands['netmock']!({
        'method': 'GET',
        'path': '/users/deer',
        'status': 200,
        'body': {'login': 'deer'},
      });
      final client = HttpClient();
      try {
        final mocked = await (await client.getUrl(Uri.parse('https://api.github.com/users/deer'))).close();
        expect(mocked.statusCode, 200);
        final watch = Stopwatch()..start();
        await expectLater(
          client.getUrl(Uri.parse('https://api.github.com/rate_limit')),
          throwsA(
            isA<SocketException>().having(
              (e) => e.message,
              'message',
              allOf(contains('api.github.com is outside networkHosts (127.0.0.1)'), contains('networkHosts')),
            ),
          ),
        );
        expect(watch.elapsedMilliseconds, lessThan(500));
      } finally {
        client.close();
      }
      final listed = records().map((r) => [r['url'], r['status']]).toList();
      expect(listed, [
        ['https://api.github.com/users/deer', 200],
        ['https://api.github.com/rate_limit', 0],
      ]);
      expect(records().last['error'], contains('outside networkHosts'));
      expect((await fetch('GET', '/now')).$1, 200);
    },
  );

  test('the fence\'s hosts come from LYNKEUS_NETWORK_HOSTS, or are this machine', () {
    expect(networkHostsFrom({}), {'127.0.0.1', 'localhost', '::1', '10.0.2.2'});
    expect(networkHostsFrom({'LYNKEUS_NETWORK_HOSTS': ' api.local , 127.0.0.1,'}), {'api.local', '127.0.0.1'});
  });

  test('records successful GETs from beyond this machine, and none that carried credentials unless asked', () async {
    network.local = {};
    network.commands['netcache']!({'record': true});
    await fetch('GET', '/photo.png');
    await fetch('POST', '/form', body: 'x');
    await fetch('GET', '/missing');
    final client = HttpClient();
    try {
      final private = await client.getUrl(at('/private'));
      private.headers.set(HttpHeaders.authorizationHeader, 'Bearer secret');
      await (await private.close()).drain<void>();
    } finally {
      client.close();
    }
    final taken = network.commands['netcache']!({'take': true})! as Map;
    final entries = (taken['entries']! as List).cast<Map<String, Object?>>();
    expect(entries.map((e) => e['url']), ['${at('/photo.png')}']);
    expect(entries.single['status'], 200);
    expect((entries.single['headers']! as Map)['content-type'], startsWith('application/json'));
    expect(jsonDecode(utf8.decode(base64.decode(entries.single['body']! as String))), containsPair('echo', ''));
    expect(taken['left'], 0);
    network.commands['netcache']!({'record': true, 'credentials': true});
    final again = HttpClient();
    try {
      final private = await again.getUrl(at('/private'));
      private.headers.set(HttpHeaders.authorizationHeader, 'Bearer secret');
      await (await private.close()).drain<void>();
    } finally {
      again.close();
    }
    expect(
      ((network.commands['netcache']!({'take': true})! as Map)['entries']! as List).single,
      containsPair('url', '${at('/private')}'),
    );
  });

  test(
    'records the body read through a cast stream, as dio reads it, which sets its handler after listening',
    () async {
      network.local = {};
      network.commands['netcache']!({'record': true});
      final client = HttpClient();
      try {
        final response = await (await client.getUrl(at('/data.json'))).close();
        // dio's adapter hands its response on as `response.cast()`, which listens with no handler and sets one after.
        final text = await response.cast<List<int>>().transform(utf8.decoder).join();
        expect(jsonDecode(text), containsPair('echo', ''));
      } finally {
        client.close();
      }
      final entry = (((network.commands['netcache']!({'take': true})! as Map)['entries']! as List).single as Map);
      expect(jsonDecode(utf8.decode(base64.decode(entry['body']! as String))), containsPair('echo', ''));
    },
  );

  test('records a HEAD (a connectivity check) and answers it from the folder with no body', () async {
    network.local = {};
    network.commands['netcache']!({'record': true});
    expect((await fetch('HEAD', '/ping')).$1, 200);
    final entry = (((network.commands['netcache']!({'take': true})! as Map)['entries']! as List).single as Map);
    expect(entry['method'], 'HEAD');
    expect(entry['url'], '${at('/ping')}');

    final folder = Directory.systemTemp.createTempSync('netcache');
    const check = 'https://captive.example/internet-check';
    File('${folder.path}/${netCacheName(check)}').writeAsBytesSync([]);
    File(
      '${folder.path}/${netCacheName(check)}.json',
    ).writeAsStringSync(jsonEncode({'url': check, 'status': 204, 'headers': <String, String>{}, 'method': 'HEAD'}));
    HttpOverrides.global = FencedHttpOverrides({'127.0.0.1'});
    network = Network(trace: traced.add)..install();
    network
      ..replay = NetCache(folder)
      ..fenced = (host) => host != '127.0.0.1';
    final client = HttpClient();
    try {
      final response = await (await client.openUrl('HEAD', Uri.parse(check))).close();
      expect(response.statusCode, 204);
      expect(await response.fold<int>(0, (n, chunk) => n + chunk.length), 0);
      await expectLater(client.getUrl(Uri.parse(check)).then((r) => r.close()), throwsA(isA<SocketException>()));
    } finally {
      client.close();
      folder.deleteSync(recursive: true);
    }
  });

  test('with the network off on a host every request fails, a replayed one too, and a mock still answers', () async {
    final folder = Directory.systemTemp.createTempSync('netcache');
    const photo = 'https://images.example/photo.png';
    File('${folder.path}/${netCacheName(photo)}').writeAsBytesSync([1, 2, 3]);
    HttpOverrides.global = FencedHttpOverrides({'127.0.0.1'});
    // The agent's link to the driver: made before the network log wraps the app's clients.
    final link = HttpClient();
    network = Network(trace: traced.add)..install();
    network
      ..replay = NetCache(folder)
      ..fenced = (host) => host != '127.0.0.1';
    network.commands['netmock']!({'method': 'GET', 'path': '/mocked', 'status': 200, 'body': 'mock'});
    HostNetwork.online = false;
    final client = HttpClient();
    try {
      await expectLater(client.getUrl(Uri.parse(photo)).then((r) => r.close()), throwsA(isA<SocketException>()));
      await expectLater(fetch('GET', '/now'), throwsA(isA<SocketException>()));
      expect((await (await client.getUrl(at('/mocked'))).close()).statusCode, 200);
      expect((await (await link.getUrl(at('/now'))).close()).statusCode, 200, reason: 'the driver stays reachable');
      expect(records().where((r) => r['status'] == 0).map((r) => r['error']), everyElement(contains('network is off')));
      HostNetwork.online = true;
      expect((await (await client.getUrl(Uri.parse(photo))).close()).statusCode, 200);
    } finally {
      HostNetwork.online = true;
      client.close();
      link.close();
      folder.deleteSync(recursive: true);
    }
  });

  test('a URL is kept under the React Native host\'s name for it', () {
    expect(netCacheName('https://images.example/photo.png'), 'd1f88d0472c300623644b9b7d2a9412a');
  });

  test('on a host, a fetch the fence would block is answered from the recorded folder, after netmock', () async {
    final folder = Directory.systemTemp.createTempSync('netcache');
    const photo = 'https://images.example/photo.png';
    final pixels = [137, 80, 78, 71, 1, 2, 3];
    File('${folder.path}/${netCacheName(photo)}').writeAsBytesSync(pixels);
    File('${folder.path}/${netCacheName(photo)}.json').writeAsStringSync(
      jsonEncode({
        'url': photo,
        'status': 200,
        'headers': {'content-type': 'image/png'},
      }),
    );
    // As the React Native host leaves them: the body alone, and an empty file for a URL it could not have.
    const old = 'https://images.example/old.jpg';
    File('${folder.path}/${netCacheName(old)}').writeAsBytesSync([255, 216]);
    File('${folder.path}/${netCacheName('https://images.example/gone.png')}').writeAsBytesSync([]);
    HttpOverrides.global = FencedHttpOverrides({'127.0.0.1'});
    network = Network(trace: traced.add)..install();
    network
      ..replay = NetCache(folder)
      ..fenced = (host) => host != '127.0.0.1';
    network.commands['netmock']!({'method': 'GET', 'path': '/mocked.png', 'status': 200, 'body': 'mock'});
    final client = HttpClient();
    Future<(int, String?, List<int>)> get(String url) async {
      final response = await (await client.getUrl(Uri.parse(url))).close();
      final bytes = await response.fold<List<int>>([], (all, chunk) => all..addAll(chunk));
      return (response.statusCode, response.headers.contentType?.mimeType, bytes);
    }

    try {
      final (status, type, bytes) = await get(photo);
      expect([status, type, bytes], [200, 'image/png', pixels]);
      final (oldStatus, oldType, oldBytes) = await get(old);
      expect(
        [oldStatus, oldType, oldBytes],
        [
          200,
          null,
          [255, 216],
        ],
      );
      expect((await get('https://images.example/mocked.png')).$3, utf8.encode('mock'));
      await expectLater(get('https://images.example/gone.png'), throwsA(isA<SocketException>()));
      await expectLater(get('https://images.example/never.png'), throwsA(isA<SocketException>()));
    } finally {
      client.close();
    }
    expect(records().where((r) => r['replayed'] == true).map((r) => r['url']), [photo, old]);
    expect(network.onWire, 0);
    expect((await fetch('GET', '/now')).$1, 200, reason: 'what the fence allows still goes out');
    folder.deleteSync(recursive: true);
  });
}

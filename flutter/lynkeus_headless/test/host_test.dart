import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:clock/clock.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lynkeus_agent/lynkeus_agent.dart';
// ignore: implementation_imports
import 'package:lynkeus_agent/src/link.dart' show proofOf;
import 'package:lynkeus_headless/lynkeus_headless.dart';

const token = 'host-test-token';

/// A small app: a button that starts a three second timer, and what the launch facts made of the clock and locale.
class Probe extends StatefulWidget {
  const Probe({super.key});
  @override
  State<Probe> createState() => _ProbeState();
}

class _ProbeState extends State<Probe> {
  var done = false;

  @override
  Widget build(BuildContext context) => Directionality(
    textDirection: TextDirection.ltr,
    child: Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          GestureDetector(
            key: const ValueKey('go'),
            onTap: () => Timer(const Duration(seconds: 3), () => setState(() => done = true)),
            child: const Text('Start'),
          ),
          if (done) const Text('Done'),
          Text('Year ${clock.now().year}'),
          Text('Locale ${WidgetsBinding.instance.platformDispatcher.locale.toLanguageTag()}'),
          const SizedBox(width: 200, height: 100, child: UiKitView(viewType: 'map')),
        ],
      ),
    ),
  );
}

/// The driver's end, run on the real event loop: handshake, then one request at a time.
class Driver {
  final answers = <String, Object?>{};
  final waits = <String, int>{};
  late HttpServer server;
  final _pending = <int, Completer<Map<String, Object?>>>{};
  WebSocket? _socket;
  var _id = 0;

  Future<void> listen() async {
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.transform(WebSocketTransformer()).listen((ws) {
      _socket = ws;
      final nonce = 'ab' * 16;
      ws.listen((data) {
        final message = (jsonDecode(data as String) as Map).cast<String, Object?>();
        if (message['event'] == 'hello') {
          ws.add(
            jsonEncode({
              'event': 'verified',
              'proof': proofOf(token, 'driver', 'd', nonce, message['nonce']! as String),
            }),
          );
          unawaited(_script());
        } else if (message['id'] is int) {
          _pending.remove(message['id'])?.complete(message);
        }
      });
      ws.add(jsonEncode({'event': 'auth', 'session': 'd', 'nonce': nonce}));
    });
  }

  Future<Map<String, Object?>> call(String method, [Object? params]) {
    final id = ++_id;
    final reply = Completer<Map<String, Object?>>();
    _pending[id] = reply;
    _socket!.add(jsonEncode({'id': id, 'method': method, 'params': ?params}));
    return reply.future.timeout(const Duration(seconds: 20));
  }

  Future<void> _script() async {
    try {
      answers['screen'] = (await call('screen'))['result'];
      final view = (((answers['screen']! as Map)['platformViews']! as List).single as Map)['frame']! as Map;
      answers['pressView'] = (await call('press', {
        'x': (view['x']! as num) + (view['w']! as num) / 2,
        'y': (view['y']! as num) + (view['h']! as num) / 2,
      }))['error'];
      await call('press', {'testId': 'go'});
      final watch = Stopwatch()..start();
      answers['waitFor'] = (await call('waitFor', {
        'target': {'text': 'Done'},
        'timeoutMs': 5000,
      }))['result'];
      waits['realMs'] = watch.elapsedMilliseconds;
      answers['clock'] = (await call('clock', {'advanceMs': 1000, 'settle': true}))['result'];
      final shot = '${Directory.systemTemp.createTempSync('lynkeus-host').path}/screen.png';
      answers['screenshot'] = (await call('screenshot', {'path': shot}))['result'];
      answers['hello'] = (await call('ping'))['result'];
    } catch (error) {
      answers['error'] = '$error';
    } finally {
      await call('exit').catchError((_) => <String, Object?>{});
    }
  }
}

void main() {
  final driver = Driver();
  setUpAll(driver.listen);

  hostApp(
    () {
      LynkeusAgent.start();
      runApp(const Probe());
    },
    name: 'probe',
    settings: () => HostSettings.fromEnvironment({
      'LYNKEUS_TOKEN': token,
      'LYNKEUS_PORT': '${driver.server.port}',
      'LYNKEUS_LOCALE': 'es-AR',
      'LYNKEUS_EPOCH': '2030-05-01T12:00:00Z',
    }),
  );

  tearDownAll(() async {
    await driver.server.close(force: true);
    expect(driver.answers['error'], isNull);
    final texts = ((driver.answers['screen']! as Map)['elements']! as List).map((e) => (e as Map)['text']).toList();
    expect(texts, containsAll(['Start', 'Year 2030', 'Locale es-AR']));
    // Headless has no native views: the rectangle is still reported, and a press inside it fails with the type.
    expect((driver.answers['screen']! as Map)['platformViews'], [
      {
        'viewType': 'map',
        'frame': {'x': 101.0, 'y': 408.0, 'w': 200.0, 'h': 100.0},
      },
    ]);
    expect(
      (driver.answers['pressView']! as Map)['message'],
      contains('this point is inside native view map, which only exists on a device'),
    );
    // Three seconds of the app's time, in far less of the wall's.
    expect((driver.answers['waitFor']! as Map)['waitedMs'], greaterThanOrEqualTo(2900));
    expect(driver.waits['realMs'], lessThan(2000));
    expect((driver.answers['clock']! as Map)['settled'], isTrue);
    expect((driver.answers['clock']! as Map)['now'], startsWith('2030-05-01T12:00'));
    final shot = driver.answers['screenshot']! as Map;
    expect([shot['w'], shot['h']], [1206, 2622]);
    expect(File(shot['path']! as String).lengthSync(), greaterThan(1000));
    expect(
      (driver.answers['hello']! as Map)['commands'],
      containsAll(['clock', 'screenshot', 'appstate', 'deeplink', 'memory']),
    );
  });
}

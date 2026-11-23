import 'dart:io';

import 'package:device_info_plus/device_info_plus.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lynkeus_agent/hosts.dart';

void main() {
  late List<String> logged;
  late StandIns standIns;
  late PluginState state;
  late Map<String, Object? Function(Object?)> commands;

  setUp(() {
    logged = [];
    commands = {};
    standIns = StandIns(log: logged.add);
    // The app's channels go through the messenger the FastSim binding gives the app.
    final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    final app = StandInMessenger(messenger.delegate, standIns);
    messenger.allMessagesHandler = (channel, mock, message) => mock?.call(message) ?? app.send(channel, message);
    state = PluginState(Directory.systemTemp.createTempSync('standins-test'));
    installPlugins(standIns, state, (name, handler) => commands[name] = handler, (_, _) async {}, 'ios');
  });

  tearDown(() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.allMessagesHandler = null);

  testWidgets('an unknown channel answers empty and says so once', (tester) async {
    const channel = MethodChannel('com.example/unknown');
    expect(await channel.invokeMethod<Object?>('anything'), isNull);
    expect(await channel.invokeMethod<Object?>('again'), isNull);
    expect(logged, ['[stub] com.example/unknown anything']);
  });

  testWidgets('a Pigeon channel gets its answer as a list, and an error as code, message and details', (tester) async {
    standIns.add('dev.flutter.pigeon.example.Api', (method, args) {
      if (method == 'fail') throw PlatformException(code: 'nope', message: 'no');
      return (args.first! as int) + 1;
    });
    const codec = StandardMessageCodec();
    expect(await const BasicMessageChannel<Object?>('dev.flutter.pigeon.example.Api.add', codec).send([41]), [42]);
    expect(await const BasicMessageChannel<Object?>('dev.flutter.pigeon.example.Api.fail', codec).send([]), [
      'nope',
      'no',
      null,
    ]);
    expect(await const BasicMessageChannel<Object?>('dev.flutter.pigeon.other.Api.x', codec).send([]), [null]);
  });

  testWidgets('shared_preferences keeps what is set, by its prefixed keys', (tester) async {
    const prefs = MethodChannel('plugins.flutter.io/shared_preferences');
    await prefs.invokeMethod<bool>('setBool', {'key': 'flutter.remember', 'value': true});
    await prefs.invokeMethod<bool>('setString', {'key': 'other.x', 'value': 'y'});
    expect(await prefs.invokeMethod<Object?>('getAll'), {'flutter.remember': true});
    await prefs.invokeMethod<bool>('clear');
    expect(state.preferences, {'other.x': 'y'});
  });

  testWidgets('url_launcher writes down what it opens; local_auth answers as the biometrics command says', (
    tester,
  ) async {
    const launcher = MethodChannel('plugins.flutter.io/url_launcher');
    expect(await launcher.invokeMethod<bool>('canLaunch', {'url': 'https://a.example'}), isTrue);
    expect(await launcher.invokeMethod<bool>('launch', {'url': 'https://a.example'}), isTrue);
    expect(commands['launched']!(null), {
      'urls': ['https://a.example'],
    });

    const auth = MethodChannel('plugins.flutter.io/local_auth');
    expect(await auth.invokeMethod<bool>('authenticate', {}), isTrue);
    commands['biometrics']!({
      'next': ['cancel', 'LockedOut'],
    });
    expect(await auth.invokeMethod<bool>('authenticate', {}), isFalse);
    await expectLater(auth.invokeMethod<bool>('authenticate', {}), throwsA(isA<PlatformException>()));
    commands['biometrics']!({'available': 'none'});
    expect(await auth.invokeMethod<bool>('isDeviceSupported'), isFalse);
  });

  testWidgets('permissions are granted unless set, and path_provider hands out folders of the run', (tester) async {
    const permissions = MethodChannel('flutter.baseflow.com/permissions/methods');
    expect(await permissions.invokeMethod<int>('checkPermissionStatus', 7), 1);
    commands['permissions']!({'7': 4});
    expect(await permissions.invokeMethod<int>('checkPermissionStatus', 7), 4);
    expect(await permissions.invokeMethod<Object?>('requestPermissions', [7, 8]), {7: 4, 8: 1});

    final docs = await const MethodChannel(
      'plugins.flutter.io/path_provider',
    ).invokeMethod<String>('getApplicationDocumentsDirectory');
    expect(docs, startsWith(state.folder.path));
    expect(Directory(docs!).existsSync(), isTrue);
    final info = await const MethodChannel(
      'dev.fluttercommunity.plus/device_info',
    ).invokeMethod<Map<Object?, Object?>>('getDeviceInfo');
    expect(info?['systemName'], 'iOS');
  });

  testWidgets('device_info answers the macOS parse too, which an app on the host machine\'s path makes', (
    tester,
  ) async {
    final info = await const MethodChannel(
      'dev.fluttercommunity.plus/device_info',
    ).invokeMethod<Map<Object?, Object?>>('getDeviceInfo');
    final mac = MacOsDeviceInfo.fromMap(info!.cast<String, dynamic>());
    expect(mac.majorVersion, 26);
    expect(mac.computerName, isNotEmpty);
    expect(IosDeviceInfo.fromMap(info.cast<String, dynamic>()).model, 'iPhone');

    final android = StandIns(log: logged.add);
    installPlugins(android, state, (_, _) {}, (_, _) async {}, 'android');
    final answer = await android.answer(
      'dev.fluttercommunity.plus/device_info',
      const StandardMethodCodec().encodeMethodCall(const MethodCall('getDeviceInfo')),
    );
    final map = (const StandardMethodCodec().decodeEnvelope(answer!)! as Map).cast<String, dynamic>();
    expect(MacOsDeviceInfo.fromMap(map).majorVersion, 26);
    expect(AndroidDeviceInfo.fromMap(map).model, 'sdk_gphone64_arm64');
  });

  testWidgets('notifications are granted and written down, scheduled until cancelled', (tester) async {
    const channel = MethodChannel('dexterous.com/flutter/local_notifications');
    expect(await channel.invokeMethod<bool>('initialize', {}), isTrue);
    expect(await channel.invokeMethod<bool>('requestPermissions', {'alert': true}), isTrue);
    await channel.invokeMethod<void>('zonedSchedule', {
      'id': 7,
      'title': 'Read',
      'body': 'Did you read today?',
      'payload': '',
      'timeZoneName': 'UTC',
      'scheduledDateTime': '2026-11-24T08:00:00',
      'matchDateTimeComponents': 0,
    });
    await channel.invokeMethod<void>('show', {'id': 1, 'title': 'Now', 'body': null, 'payload': ''});
    expect(await channel.invokeListMethod<Object?>('pendingNotificationRequests'), [
      {'id': 7, 'title': 'Read', 'body': 'Did you read today?', 'payload': ''},
    ]);
    final listed = commands['notifications']!(null)! as Map<String, Object?>;
    expect(
      (listed['scheduled']! as List).single,
      allOf(containsPair('at', '2026-11-24T08:00:00'), containsPair('time', '08:00')),
    );
    expect((listed['shown']! as List).single, containsPair('title', 'Now'));
    await channel.invokeMethod<void>('cancel', 7);
    expect(await channel.invokeListMethod<Object?>('pendingNotificationRequests'), isEmpty);
  });

  testWidgets('the time zone is TZ\'s when it names one, else the machine\'s', (tester) async {
    expect(hostTimeZone({'TZ': 'America/Argentina/Buenos_Aires'}), 'America/Argentina/Buenos_Aires');
    expect(hostTimeZone({'TZ': 'UTC'}), 'UTC');
    expect(hostTimeZone(const {}), contains(RegExp(r'^(UTC|\w+/[\w/+-]+)$')));
    expect(await const MethodChannel('flutter_timezone').invokeMethod<String>('getLocalTimezone'), hostTimeZone());
  });

  testWidgets('share, file pickers, open_file and app_settings answer as a user who goes along would', (tester) async {
    expect(
      await const MethodChannel('dev.fluttercommunity.plus/share').invokeMethod<String>('share', {
        'paths': ['/tmp/backup.json'],
        'subject': 'Backup',
      }),
      'dev.fluttercommunity.plus/share/success',
    );
    expect(commands['shared']!(null), {
      'shared': [
        {
          'subject': 'Backup',
          'paths': ['/tmp/backup.json'],
        },
      ],
    });

    const picker = MethodChannel('plugins.flutter.io/file_selector');
    expect(await picker.invokeListMethod<String>('openFile', {'multiple': false}), isNull);
    commands['files']!({'open': '/tmp/backup.json'});
    expect(await picker.invokeListMethod<String>('openFile', {'multiple': false}), ['/tmp/backup.json']);
    final saveTo = await picker.invokeMethod<String>('getSavePath', {'suggestedName': 'habits.csv'});
    expect(saveTo, endsWith('/downloads/habits.csv'));
    expect((commands['files']!(null)! as Map)['saved'], [saveTo]);

    final file = File('${state.folder.path}/report.csv')..writeAsStringSync('a,b');
    const open = MethodChannel('open_file');
    expect(await open.invokeMethod<String>('open_file', {'file_path': file.path}), contains('"type":0'));
    expect(await open.invokeMethod<String>('open_file', {'file_path': '/nope'}), contains('"type":-2'));
    await const MethodChannel(
      'com.spencerccf.app_settings/methods',
    ).invokeMethod<void>('openSettings', {'type': 'notification'});
    expect((commands['launched']!(null)! as Map)['urls'], [
      Uri.file(file.path).toString(),
      'app-settings:notification',
    ]);
  });

  test('the engine\'s and the host\'s channels are not a plugin\'s', () {
    expect(StandIns.handles('flutter/platform'), isFalse);
    expect(StandIns.handles('lynkeus/fastsim'), isFalse);
    expect(StandIns.handles('plugins.flutter.io/shared_preferences'), isTrue);
    expect(StandIns.handles('dev.flutter.pigeon.shared_preferences_foundation.UserDefaultsApi.getAll'), isTrue);
    // Native views are answered here unless the host draws them (FastSim's placeholder).
    expect(StandIns.handles('flutter/platform_views'), isTrue);
    expect(StandIns.handles('flutter/platform_views_2'), isTrue);
    expect(StandIns.handles('flutter/platform_views', hostViews: true), isFalse);
    expect(StandIns.handles('flutter/platform_views_2', hostViews: true), isFalse);
    expect(StandIns.handles('plugins.flutter.io/shared_preferences', hostViews: true), isTrue);
  });

  for (final placeholder in [true, false]) {
    testWidgets(
      placeholder
          ? 'a host that draws native views gets their calls, once its hello has said so'
          : 'a host that says nothing of native views leaves them to the stand-ins',
      (tester) async {
        final host = <MethodCall>[];
        final inner = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
        for (final channel in const [
          MethodChannel('flutter/platform_views'),
          MethodChannel('flutter/platform_views_2'),
        ]) {
          inner.setMockMethodCallHandler(channel, (call) async {
            host.add(call);
            return null;
          });
          addTearDown(() => inner.setMockMethodCallHandler(channel, null));
        }
        // Made in the test's zone, so its hello completes on the test's clock.
        final said = <String>[];
        final standIns = StandIns(log: said.add, hostSaysViews: true);
        final app = StandInMessenger(inner, standIns);
        final create = const StandardMethodCodec().encodeMethodCall(
          const MethodCall('create', {'id': 0, 'viewType': 'map'}),
        );
        // Made before the hello reply is in: it waits for it.
        var answered = false;
        final reply = app.send('flutter/platform_views', create)!..then((_) => answered = true);
        await tester.pump();
        expect(answered, isFalse);
        standIns.hostAnswersPlatformViews(placeholder);
        standIns.hostAnswersPlatformViews(!placeholder);
        final envelope = await reply;
        if (placeholder) {
          expect(const StandardMethodCodec().decodeEnvelope(envelope!), isNull);
          expect(host.map((c) => c.method), ['create']);
          expect(said, isEmpty);
        } else {
          expect(() => const StandardMethodCodec().decodeEnvelope(envelope!), throwsA(isA<PlatformException>()));
          expect(host, isEmpty);
          expect(said.single, contains('map is a native view'));
        }
        // Once the host has said, a call goes straight where it said.
        expect(await app.send('flutter/platform_views_2', create), isNotNull);
        expect(host.length, placeholder ? 2 : 0);
      },
    );
  }

  testWidgets('the app\'s messenger shows what it sends before routing it', (tester) async {
    final seen = <String>[];
    final messenger = StandInMessenger(
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.delegate,
      standIns,
      sent: (channel, _) => seen.add(channel),
    );
    await messenger.send('com.example/unknown', null);
    expect(seen, ['com.example/unknown']);
  });

  testWidgets('a native view gets a clear error, said once per view type, and its other calls succeed', (tester) async {
    const views = MethodChannel('flutter/platform_views');
    Future<Object?> create(int id) => views.invokeMethod<Object?>('create', {'id': id, 'viewType': 'TabBar'});
    await expectLater(
      create(1),
      throwsA(isA<PlatformException>().having((e) => e.message, 'message', contains('TabBar is a native view'))),
    );
    await expectLater(create(2), throwsA(isA<PlatformException>()));
    expect(await views.invokeMethod<Object?>('dispose', 1), isNull);
    expect(logged.where((l) => l.contains('TabBar')), hasLength(1));
  });

  test('says why a plugin with no channel default fails under a host, and nothing for other errors', () {
    final webview = AssertionError(
      'A platform implementation for `webview_flutter` has not been set. Please ensure that an implementation of '
      '`WebViewPlatform` has been registered',
    );
    expect(explainHostError(webview), allOf(contains('`webview_flutter`'), contains('native view')));
    expect(explainHostError(StateError('databaseFactory not initialized\n...')), contains('`sqflite`'));
    expect(
      explainHostError(StateError('The SharedPreferencesAsyncPlatform instance must be set.')),
      contains('SharedPreferencesAsync'),
    );
    expect(explainHostError(StateError('something else')), isNull);
  });

  testWidgets('sqflite\'s channel is a real SQLite in a folder of the run', (tester) async {
    await tester.runAsync(() async {
      const sql = MethodChannel('com.tekartik.sqflite');
      final dir = await sql.invokeMethod<String>('getDatabasesPath');
      expect(dir, startsWith(state.folder.path));
      final path = '$dir/app.db';
      final opened = await sql.invokeMapMethod<String, Object?>('openDatabase', {'path': path, 'singleInstance': true});
      final id = opened!['id'];
      await sql.invokeMethod<void>('execute', {
        'id': id,
        'sql':
            'CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT UNIQUE, score REAL, data BLOB); PRAGMA user_version = 2',
      });
      expect(
        await sql.invokeMethod<int>('insert', {
          'id': id,
          'sql': 'INSERT INTO t (name, score, data) VALUES (?, ?, ?)',
          'arguments': [
            'Ana',
            1.5,
            Uint8List.fromList([1, 2]),
          ],
        }),
        1,
      );
      final begin = await sql.invokeMethod<Object?>('execute', {
        'id': id,
        'sql': 'BEGIN IMMEDIATE',
        'inTransaction': true,
      });
      expect(begin, {'transactionId': isA<int>()});
      final batch = await sql.invokeMethod<List<Object?>>('batch', {
        'id': id,
        'continueOnError': true,
        'operations': [
          {
            'method': 'insert',
            'sql': 'INSERT INTO t (name) VALUES (?)',
            'arguments': ['Bo'],
          },
          {
            'method': 'insert',
            'sql': 'INSERT INTO t (name) VALUES (?)',
            'arguments': ['Ana'],
          },
          {
            'method': 'update',
            'sql': 'UPDATE t SET score = score + 1 WHERE name = ?',
            'arguments': ['Ana'],
          },
        ],
      });
      expect(batch![0], {'result': 2});
      expect(((batch[1]! as Map)['error'] as Map)['message'], contains('UNIQUE'));
      expect(batch[2], {'result': 1});
      await sql.invokeMethod<void>('execute', {'id': id, 'sql': 'COMMIT', 'inTransaction': false});
      expect(
        await sql.invokeMethod<Object?>('query', {'id': id, 'sql': 'SELECT name, score, data FROM t ORDER BY id'}),
        {
          'columns': ['name', 'score', 'data'],
          'rows': [
            [
              'Ana',
              2.5,
              Uint8List.fromList([1, 2]),
            ],
            ['Bo', null, null],
          ],
        },
      );
      expect(await sql.invokeMethod<Object?>('query', {'id': id, 'sql': 'PRAGMA user_version'}), {
        'columns': ['user_version'],
        'rows': [
          [2],
        ],
      });
      await expectLater(
        sql.invokeMethod<int>('insert', {
          'id': id,
          'sql': 'INSERT INTO t (name) VALUES (?)',
          'arguments': ['Bo'],
        }),
        throwsA(isA<PlatformException>().having((e) => e.code, 'code', 'sqlite_error')),
      );
      expect(await sql.invokeMapMethod<String, Object?>('openDatabase', {'path': path, 'singleInstance': true}), {
        'id': id,
        'recovered': true,
        'recoveredInTransaction': false,
      });
      await sql.invokeMethod<void>('closeDatabase', {'id': id});
      expect(await sql.invokeMethod<bool>('databaseExists', {'path': path}), isTrue);
      await sql.invokeMethod<void>('deleteDatabase', {'path': path});
      expect(await sql.invokeMethod<bool>('databaseExists', {'path': path}), isFalse);
    });
  });

  testWidgets('a database is gone after a reset of the run', (tester) async {
    await tester.runAsync(() async {
      const sql = MethodChannel('com.tekartik.sqflite');
      final path = '${await sql.invokeMethod<String>('getDatabasesPath')}/x.db';
      await sql.invokeMapMethod<String, Object?>('openDatabase', {'path': path});
      state.reset();
      expect(File(path).existsSync(), isFalse);
    });
  });

  testWidgets('device_info answers what the plugin parses, as a Pixel on Android and an iPhone on iOS', (tester) async {
    const channel = MethodChannel('dev.fluttercommunity.plus/device_info');
    final ios = (await channel.invokeMapMethod<String, Object?>('getDeviceInfo'))!;
    expect(IosDeviceInfo.fromMap(ios).modelName, 'iPhone 17');
    installPlugins(standIns, state, (name, handler) => commands[name] = handler, (_, _) async {}, 'android');
    final android = AndroidDeviceInfo.fromMap((await channel.invokeMapMethod<String, Object?>('getDeviceInfo'))!);
    expect([android.version.sdkInt, android.version.release, android.isPhysicalDevice], [35, '15', false]);
    expect(await const MethodChannel('plugins.flutter.io/local_auth').invokeMethod<Object?>('getAvailableBiometrics'), [
      'fingerprint',
    ]);
  });
}

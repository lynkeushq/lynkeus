import 'dart:io';

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

  test('the engine\'s and the host\'s channels are not a plugin\'s', () {
    expect(StandIns.handles('flutter/platform'), isFalse);
    expect(StandIns.handles('lynkeus/fastsim'), isFalse);
    expect(StandIns.handles('plugins.flutter.io/shared_preferences'), isTrue);
    expect(StandIns.handles('dev.flutter.pigeon.shared_preferences_foundation.UserDefaultsApi.getAll'), isTrue);
  });
}

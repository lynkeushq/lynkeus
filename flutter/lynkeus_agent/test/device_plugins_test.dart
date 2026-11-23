import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lynkeus_agent/hosts.dart';

/// What the app's code reads from a channel, through the messenger the host gives it.
void main() {
  late StandIns standIns;
  late PluginState state;
  late Map<String, Object? Function(Object?)> commands;
  late List<(String, Object?)> emitted;

  void install(String platform) {
    commands = {};
    emitted = [];
    standIns = StandIns(log: (_) {});
    final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    final app = StandInMessenger(messenger.delegate, standIns);
    messenger.allMessagesHandler = (channel, mock, message) => mock?.call(message) ?? app.send(channel, message);
    state = PluginState(Directory.systemTemp.createTempSync('device-test'));
    installPlugins(
      standIns,
      state,
      (name, handler) => commands[name] = handler,
      (channel, message) async => emitted.add((channel, const StandardMethodCodec().decodeEnvelope(message!))),
      platform,
    );
  }

  tearDown(() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.allMessagesHandler = null);

  const geolocator = MethodChannel('flutter.baseflow.com/geolocator');

  testWidgets('geolocator: the simulator\'s or the emulator\'s default position, granted, services on', (tester) async {
    install('ios');
    expect(await geolocator.invokeMethod<int>('checkPermission'), 2);
    expect(await geolocator.invokeMethod<bool>('isLocationServiceEnabled'), isTrue);
    final at = (await geolocator.invokeMethod<Map<Object?, Object?>>('getCurrentPosition'))!;
    expect([at['latitude'], at['longitude']], [37.33233141, -122.0312186]);
    install('android');
    final pixel = (await geolocator.invokeMethod<Map<Object?, Object?>>('getCurrentPosition'))!;
    expect([pixel['latitude'], pixel['longitude']], [37.4219983, -122.084]);
  });

  testWidgets('geolocator: a case denies the permission, or lets the person allow it when asked', (tester) async {
    install('ios');
    commands['location']!({'permission': 'denied'});
    expect(await geolocator.invokeMethod<int>('checkPermission'), 0);
    expect(await geolocator.invokeMethod<int>('requestPermission'), 0);
    await expectLater(
      geolocator.invokeMethod<Object?>('getCurrentPosition'),
      throwsA(isA<PlatformException>().having((e) => e.code, 'code', 'PERMISSION_DENIED')),
    );

    commands['location']!({'permission': 'denied', 'request': 'whileInUse', 'latitude': 52.52, 'longitude': 13.41});
    expect(await geolocator.invokeMethod<int>('checkPermission'), 0);
    expect(await geolocator.invokeMethod<int>('requestPermission'), 2);
    expect(await geolocator.invokeMethod<int>('checkPermission'), 2);
    expect((await geolocator.invokeMethod<Map<Object?, Object?>>('getCurrentPosition'))!['latitude'], 52.52);

    commands['location']!({'service': false});
    expect(await geolocator.invokeMethod<bool>('isLocationServiceEnabled'), isFalse);
    expect(emitted.last, ('flutter.baseflow.com/geolocator_service_updates', 0));
    await expectLater(
      geolocator.invokeMethod<Object?>('getCurrentPosition'),
      throwsA(isA<PlatformException>().having((e) => e.code, 'code', 'LOCATION_SERVICES_DISABLED')),
    );
    expect(await geolocator.invokeMethod<bool>('openLocationSettings'), isTrue);
    expect(state.launched, ['app-settings:location']);
    expect(() => commands['location']!({'permission': 'sometimes'}), throwsArgumentError);
  });

  testWidgets('geolocator: the position stream hears where the phone is, and where it is moved', (tester) async {
    install('ios');
    await const MethodChannel('flutter.baseflow.com/geolocator_updates').invokeMethod<void>('listen');
    await tester.pump();
    expect(emitted.single.$1, 'flutter.baseflow.com/geolocator_updates');
    commands['location']!({'latitude': -34.6, 'longitude': -58.38});
    expect((emitted.last.$2! as Map)['latitude'], -34.6);
  });

  testWidgets('geocoding (to 4.x): the nearest known place, a case\'s own first, and nothing far from any', (
    tester,
  ) async {
    install('ios');
    const geocoding = MethodChannel('flutter.baseflow.com/geocoding');
    final near = await geocoding.invokeMethod<List<Object?>>('placemarkFromCoordinates', {
      'latitude': 37.334,
      'longitude': -122.009,
    });
    expect((near!.single! as Map)['locality'], 'Cupertino');
    commands['location']!({
      'place': {'latitude': 52.52, 'longitude': 13.405, 'locality': 'Berlin', 'country': 'Germany'},
    });
    final berlin = await geocoding.invokeMethod<List<Object?>>('placemarkFromCoordinates', {
      'latitude': 52.5,
      'longitude': 13.4,
    });
    expect((berlin!.single! as Map)['locality'], 'Berlin');
    await expectLater(
      geocoding.invokeMethod<Object?>('placemarkFromCoordinates', {'latitude': 0.0, 'longitude': 0.0}),
      throwsA(isA<PlatformException>()),
    );
    final found = await geocoding.invokeMethod<List<Object?>>('locationFromAddress', {'address': 'berlin'});
    expect((found!.single! as Map)['latitude'], 52.52);
  });

  testWidgets('workmanager\'s Pigeon requests are read whatever their classes, and the tasks stay scheduled', (
    tester,
  ) async {
    install('android');
    final reply = await TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.send(
      'dev.flutter.pigeon.workmanager_platform_interface.WorkmanagerHostApi.registerOneOffTask',
      const _WorkmanagerCodec().encodeMessage([const _OneOff()]),
    );
    expect(const StandardMessageCodec().decodeMessage(reply), [null]);
    const api = 'dev.flutter.pigeon.workmanager_platform_interface.WorkmanagerHostApi';
    const codec = StandardMessageCodec();
    expect(await const BasicMessageChannel<Object?>('$api.isScheduledByUniqueName', codec).send(['refresh-widget']), [
      true,
    ]);
    expect(commands['tasks']!(null), {
      'scheduled': [
        {'uniqueName': 'refresh-widget', 'taskName': 'refresh', 'kind': 'oneoff'},
      ],
      'restarts': 0,
    });
    await const BasicMessageChannel<Object?>('$api.cancelByUniqueName', codec).send(['refresh-widget']);
    expect(await const BasicMessageChannel<Object?>('$api.isScheduledByUniqueName', codec).send(['refresh-widget']), [
      false,
    ]);
  });

  testWidgets('home_widget keeps its data and updates; display modes and a restart answer as done', (tester) async {
    install('android');
    const widgets = MethodChannel('home_widget');
    expect(await widgets.invokeMethod<bool>('saveWidgetData', {'id': 'temp', 'data': '21°'}), isTrue);
    expect(await widgets.invokeMethod<String>('getWidgetData', {'id': 'temp'}), '21°');
    expect(await widgets.invokeMethod<String>('getWidgetData', {'id': 'none', 'defaultValue': '-'}), '-');
    await widgets.invokeMethod<bool>('updateWidget', {'name': null, 'android': 'WeatherWidget'});
    expect(commands['widgets']!({'clear': true}), {
      'data': {'temp': '21°'},
      'updates': [
        {'android': 'WeatherWidget'},
      ],
    });
    const display = MethodChannel('flutter_display_mode');
    expect((await display.invokeMethod<List<Object?>>('getSupportedModes'))!.single, isA<Map<Object?, Object?>>());
    expect((await display.invokeMethod<Map<Object?, Object?>>('getActiveMode'))!['refreshRate'], 120.0);
    expect(
      (await const MethodChannel('restart').invokeMethod<Map<Object?, Object?>>('restartApp'))!['success'],
      isTrue,
    );
    expect((commands['tasks']!(null)! as Map)['restarts'], 1);
  });
}

class _OneOff {
  const _OneOff();
}

/// As workmanager's own Pigeon codec writes a OneOffTaskRequest: its type code, then the list of its fields.
class _WorkmanagerCodec extends StandardMessageCodec {
  const _WorkmanagerCodec();

  @override
  void writeValue(WriteBuffer buffer, Object? value) {
    if (value is _OneOff) {
      buffer.putUint8(142);
      writeValue(buffer, ['refresh-widget', 'refresh', null, 900]);
    } else {
      super.writeValue(buffer, value);
    }
  }
}

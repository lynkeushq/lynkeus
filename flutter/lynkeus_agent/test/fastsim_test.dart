import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lynkeus_agent/src/fastsim.dart';
import 'package:lynkeus_agent/src/standins.dart';

void main() {
  test('sleeps on a simulator or a phone: only FASTSIM_HOST wakes it', () {
    expect(FastSimHost.detect({}), isNull);
    expect(FastSimHost.detect({'FASTSIM_OS': 'ios', 'FASTSIM_SAFE_AREA': '62,0,34,0'}), isNull);
    final host = FastSimHost.detect({
      'FASTSIM_HOST': 'flutter',
      'FASTSIM_OS': 'android',
      'FASTSIM_SAFE_AREA': '54.1, 0, 24, 0',
      'LYNKEUS_PORT': '8150',
      'LYNKEUS_TOKEN': 'tok',
    })!;
    expect(host.platform, TargetPlatform.android);
    expect(host.safeArea, [54.1, 0, 24, 0]);
    expect(host.port, 8150);
    expect(host.token, 'tok');
    expect(FastSimHost.detect({'FASTSIM_HOST': 'flutter', 'FASTSIM_SAFE_AREA': '62,0'})!.safeArea, isNull);
    expect(FastSimHost.detect({'FASTSIM_HOST': '1', 'LYNKEUS_HOST': '192.168.1.5'})!.networkHosts, {
      '127.0.0.1',
      'localhost',
      '::1',
      '10.0.2.2',
      '192.168.1.5',
    });
  });

  test('a plugin message the host forwards, for an app with its own binding, is answered by the stand-ins', () async {
    final standIns = StandIns(log: (_) {})
      ..add('fastsim.test/prefs', (method, args) => method == 'get' ? 'kept' : null);
    ByteData forwarded(String channel, ByteData message) {
      final name = utf8.encode(channel);
      final bytes = BytesBuilder()
        ..add((ByteData(4)..setUint32(0, name.length, Endian.little)).buffer.asUint8List())
        ..add(name)
        ..add(message.buffer.asUint8List(message.offsetInBytes, message.lengthInBytes));
      return ByteData.sublistView(bytes.toBytes());
    }

    const codec = StandardMethodCodec();
    final answer = await answerForwarded(
      standIns,
      forwarded('fastsim.test/prefs', codec.encodeMethodCall(const MethodCall('get'))),
    );
    expect(codec.decodeEnvelope(answer!), 'kept');
    // The host's own channels never reach the agent this way, and a short message is not one.
    expect(
      await answerForwarded(standIns, forwarded('flutter/platform', codec.encodeMethodCall(const MethodCall('x')))),
      isNull,
    );
    expect(await answerForwarded(standIns, ByteData(2)), isNull);
  });

  testWidgets('the safe area is the padding, less what the keyboard covers', (tester) async {
    tester.view.devicePixelRatio = 3;
    final view = SafeAreaView(tester.view, [62, 0, 34, 0]);
    expect([view.padding.top, view.padding.bottom], [186, 102]);
    expect([view.viewPadding.top, view.viewPadding.bottom], [186, 102]);
    tester.view.viewInsets = const FakeViewPadding(bottom: 336 * 3);
    expect([view.padding.top, view.padding.bottom], [186, 0]);
    expect(view.viewPadding.bottom, 102);
    expect(view.physicalSize, tester.view.physicalSize);
    tester.view.reset();
  });

  testWidgets('asks the host what it serves, forwards commands and reports what holds the clock', (tester) async {
    final calls = <MethodCall>[];
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel(channelName, JSONMethodCodec()),
      (call) async {
        calls.add(call);
        return switch (call.method) {
          'hello' => {
            'commands': ['clock', 'screenshot'],
          },
          'call' => {'echo': call.arguments},
          _ => null,
        };
      },
    );
    final host = FastSimHost.detect({'FASTSIM_HOST': 'flutter'})!;
    expect(await host.hello('0.7.5'), ['clock', 'screenshot']);
    expect((calls.single.arguments as Map)['binding'], 'app');
    expect(await host.call('clock', {'advanceMs': 1000}), {
      'echo': {
        'name': 'clock',
        'params': {'advanceMs': 1000},
      },
    });
    host.activity(serving: 1, inFlight: 0);
    host.activity(serving: 1, inFlight: 0);
    host.activity(serving: 0, inFlight: 0);
    await tester.pump();
    expect(calls.where((c) => c.method == 'activity').map((c) => c.arguments), [
      {'serving': 1, 'inFlight': 0},
      {'serving': 0, 'inFlight': 0},
    ]);
  });

  for (final (name, reply, placeholder) in [
    ('a host that draws native views says so in its hello', {'platformViews': 'placeholder'}, true),
    ('a host from before native views says nothing of them', <String, Object?>{}, false),
    ('a value the agent does not know is no placeholder', {'platformViews': 'webkit'}, false),
  ]) {
    testWidgets(name, (tester) async {
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        const MethodChannel(channelName, JSONMethodCodec()),
        (call) async => {
          'commands': ['clock', 7, null],
          'somethingNew': {'a': 1},
          ...reply,
        },
      );
      final host = FastSimHost.detect({'FASTSIM_HOST': 'flutter'})!
        ..standIns = StandIns(log: (_) {}, hostSaysViews: true);
      expect(await host.hello('0.7.5'), ['clock'], reason: 'unknown fields and entries are skipped');
      expect(await host.standIns!.hostViews, placeholder);
    });
  }

  testWidgets('a hello reply that is not a map serves nothing and keeps the stand-ins on native views', (tester) async {
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel(channelName, JSONMethodCodec()),
      (call) async => ['clock'],
    );
    final host = FastSimHost.detect({'FASTSIM_HOST': 'flutter'})!
      ..standIns = StandIns(log: (_) {}, hostSaysViews: true);
    expect(await host.hello('0.7.5'), isEmpty);
    expect(await host.standIns!.hostViews, isFalse);
  });

  testWidgets('a host that does not answer hello serves nothing, and the agent still starts', (tester) async {
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel(channelName, JSONMethodCodec()),
      null,
    );
    final host = FastSimHost.detect({'FASTSIM_HOST': 'flutter'})!
      ..standIns = StandIns(log: (_) {}, hostSaysViews: true);
    final served = host.hello('0.7.5');
    await tester.pump(const Duration(seconds: 6));
    expect(await served, isEmpty);
    expect(await host.standIns!.hostViews, isFalse);
  });

  test('the system bars the app hides move the safe area as on the phone, edge by edge', () {
    const pixel = [54.095238, 0.0, 24.0, 0.0];
    const pixelHidden = [54.095238, 0.0, 0.0, 0.0];
    final bars = SystemBars();
    MethodCall overlays(List<String> shown) => MethodCall('SystemChrome.setEnabledSystemUIOverlays', shown);
    MethodCall mode(String m) => MethodCall('SystemChrome.setEnabledSystemUIMode', 'SystemUiMode.$m');

    expect(bars.sides(pixel, pixelHidden), pixel);
    // flutter_deer's main: manual, with no overlays.
    expect(bars.follow(overlays([])), isTrue);
    expect(bars.sides(pixel, pixelHidden), [54.095238, 0.0, 0.0, 0.0]);
    expect(bars.follow(overlays(['SystemUiOverlay.top', 'SystemUiOverlay.bottom'])), isTrue);
    expect(bars.sides(pixel, pixelHidden), pixel);
    expect(bars.follow(overlays(['SystemUiOverlay.top'])), isTrue);
    expect([bars.top, bars.bottom], [true, false]);
    expect(bars.follow(mode('edgeToEdge')), isTrue);
    expect(bars.follow(mode('immersiveSticky')), isTrue);
    expect([bars.top, bars.bottom], [false, false]);
    expect(bars.follow(mode('leanBack')), isFalse, reason: 'nothing changed');
    // Measured on the Pixel 9 emulator: a restore puts back the mode last set, so nothing moves.
    expect(bars.follow(const MethodCall('SystemChrome.restoreSystemUIOverlays')), isFalse);
    expect(bars.follow(const MethodCall('SystemChrome.setSystemUIOverlayStyle', {})), isFalse);
    expect(FastSimHost.detect({'FASTSIM_HOST': '1', 'FASTSIM_SAFE_AREA_HIDDEN': '62,0,34,0'})!.safeAreaHidden, [
      62,
      0,
      34,
      0,
    ]);
  });

  testWidgets('a safe area view takes new sides', (tester) async {
    tester.view.devicePixelRatio = 2.625;
    final view = SafeAreaView(tester.view, [54.095238, 0, 24, 0]);
    expect(view.padding.bottom, closeTo(63, 0.01));
    view.sides = [54.095238, 0, 0, 0];
    expect(view.padding.bottom, 0);
    expect(view.padding.top, closeTo(142, 0.01));
    tester.view.reset();
  });
}

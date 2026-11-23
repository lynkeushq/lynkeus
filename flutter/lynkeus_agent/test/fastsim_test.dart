import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lynkeus_agent/src/fastsim.dart';

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

  testWidgets('a host that does not answer hello serves nothing, and the agent still starts', (tester) async {
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      const MethodChannel(channelName, JSONMethodCodec()),
      null,
    );
    final host = FastSimHost.detect({'FASTSIM_HOST': 'flutter'})!;
    final served = host.hello('0.7.5');
    await tester.pump(const Duration(seconds: 6));
    expect(await served, isEmpty);
  });
}

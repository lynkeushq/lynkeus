// ignore_for_file: deprecated_member_use

import 'dart:async';

import 'package:flutter/cupertino.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lynkeus_agent/src/capture.dart';
import 'package:lynkeus_agent/src/methods.dart';

/// The test binding with the agent's capture frames, as LynkeusBinding gives an app.
class _Binding extends AutomatedTestWidgetsFlutterBinding with FrameCapture {}

const _frame = ValueKey('frame');

/// Spinners of both kinds, and a controller of the test's own that loops.
class _Spinners extends StatefulWidget {
  const _Spinners({this.fade});
  final AnimationController? fade;
  @override
  State<_Spinners> createState() => _SpinnersState();
}

class _SpinnersState extends State<_Spinners> with SingleTickerProviderStateMixin {
  late final loop = AnimationController(vsync: this, duration: const Duration(milliseconds: 900))..repeat();

  @override
  void dispose() {
    loop.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => RepaintBoundary(
    key: _frame,
    child: ColoredBox(
      color: Colors.white,
      child: Column(
        children: [
          const CircularProgressIndicator(),
          const CupertinoActivityIndicator(radius: 20),
          const LinearProgressIndicator(),
          RotationTransition(
            turns: loop,
            child: const SizedBox(width: 40, height: 10, child: ColoredBox(color: Colors.red)),
          ),
          if (widget.fade != null)
            FadeTransition(
              opacity: widget.fade!,
              child: const SizedBox(width: 40, height: 40, child: ColoredBox(color: Colors.blue)),
            ),
        ],
      ),
    ),
  );
}

void main() {
  final binding = _Binding();

  Future<Uint8List> pixels(WidgetTester tester) async {
    final boundary = tester.renderObject<RenderRepaintBoundary>(find.byKey(_frame));
    return (await tester.runAsync(() async {
      final image = await boundary.toImage();
      final bytes = await image.toByteData();
      image.dispose();
      return bytes!.buffer.asUint8List();
    }))!;
  }

  // Runs a capture the way idle does: asks for the frame, which the test then pumps.
  Future<bool> capture(WidgetTester tester) async {
    final drawn = binding.capture();
    await tester.pump();
    return drawn;
  }

  _SpinnersState spinners(WidgetTester tester) => tester.state<_SpinnersState>(find.byType(_Spinners));

  setUp(binding.debugRelaunch);

  testWidgets('spinners are captured at the same angle however much time has passed', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: _Spinners())));
    await tester.pump(const Duration(milliseconds: 1370));
    expect(await capture(tester), isTrue);
    final first = await pixels(tester);
    expect(spinners(tester).loop.value, 0);
    binding.release();
    await tester.pump(const Duration(milliseconds: 16));
    final between = await pixels(tester);
    expect(between, isNot(first), reason: 'between captures the spinners turn at real time');
    expect(spinners(tester).loop.value, closeTo((1370 + 16) / 900 % 1, 0.02));
    // Another moment, another phase: the same frame.
    await tester.pump(const Duration(milliseconds: 2913));
    expect(await capture(tester), isTrue);
    expect(await pixels(tester), first);
    binding.release();
  });

  testWidgets('frames are held until released, then drawn at real time', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: _Spinners())));
    await tester.pump(const Duration(milliseconds: 500));
    await capture(tester);
    expect(binding.holding, isTrue);
    final held = await pixels(tester);
    await tester.pump(const Duration(milliseconds: 300));
    expect(await pixels(tester), held);
    expect(spinners(tester).loop.value, 0);
    binding.release();
    await tester.pump(const Duration(milliseconds: 16));
    expect(spinners(tester).loop.value, closeTo((500 + 300 + 16) / 900 % 1, 0.02));
  });

  testWidgets('the hold lets go by itself after its limit, unless a capture is being served', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: _Spinners())));
    var serving = true;
    final drawn = binding.capture(limit: const Duration(seconds: 1), stillServing: () => serving);
    await tester.pump();
    expect(await drawn, isTrue);
    await tester.pump(const Duration(milliseconds: 1500));
    expect(binding.holding, isTrue);
    serving = false;
    await tester.pump(const Duration(milliseconds: 1000));
    expect(binding.holding, isFalse);
  });

  testWidgets('an animation that runs to an end is drawn where it is', (tester) async {
    final vsync = _Vsync();
    final fade = AnimationController(vsync: vsync, duration: const Duration(seconds: 2));
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(body: _Spinners(fade: fade)),
      ),
    );
    unawaited(fade.forward());
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
    final before = fade.value;
    await capture(tester);
    expect(fade.value, before);
    expect(fade.value, closeTo(500 / 2000, 0.01));
    binding.release();
    fade.dispose();
  });

  testWidgets('a spinner under a page that covered it keeps the time it started at', (tester) async {
    final navigator = GlobalKey<NavigatorState>();
    await tester.pumpWidget(
      MaterialApp(
        navigatorKey: navigator,
        home: const Scaffold(body: _Spinners()),
      ),
    );
    await tester.pump(const Duration(milliseconds: 250));
    unawaited(
      navigator.currentState!.push(MaterialPageRoute<void>(builder: (_) => const Scaffold(body: Text('Over')))),
    );
    for (var t = 0; t < 60; t++) {
      await tester.pump(const Duration(milliseconds: 16));
    }
    await tester.pump(const Duration(milliseconds: 777));
    navigator.currentState!.pop();
    for (var t = 0; t < 60; t++) {
      await tester.pump(const Duration(milliseconds: 16));
    }
    await tester.pump(const Duration(milliseconds: 333));
    expect(await capture(tester), isTrue);
    expect(spinners(tester).loop.value, 0);
    binding.release();
  });

  testWidgets('nothing that loops, no capture frame and no hold', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: Text('Still'))));
    expect(await capture(tester), isFalse);
    expect(binding.holding, isFalse);
  });

  for (final platform in [TargetPlatform.android, TargetPlatform.iOS]) {
    testWidgets('a blinking caret is drawn on in a capture frame (${platform.name})', (tester) async {
      debugDefaultTargetPlatformOverride = platform;
      await tester.pumpWidget(const MaterialApp(home: Scaffold(body: TextField(autofocus: true))));
      await tester.pump();
      final caret = tester.allRenderObjects.whereType<RenderEditable>().single;
      var hidden = false;
      for (var t = 0; t < 100 && !hidden; t++) {
        await tester.pump(const Duration(milliseconds: 37));
        hidden = !caret.showCursor.value || caret.cursorColor!.a == 0;
      }
      expect(hidden, isTrue, reason: 'the caret blinks');
      expect(await capture(tester), isTrue);
      expect(caret.showCursor.value, isTrue);
      expect(caret.cursorColor!.a, greaterThan(0));
      binding.release();
      debugDefaultTargetPlatformOverride = null;
    });
  }

  group('idle', () {
    late Methods methods;

    Future<Map<String, Object?>> idle(WidgetTester tester, Map<String, Object?> params) =>
        idleOf(tester, methods, params);

    testWidgets('answers with the capture frame held; a capture keeps it, an action lets it go', (tester) async {
      await tester.pumpWidget(const MaterialApp(home: Scaffold(body: _Spinners())));
      methods = Methods()
        ..capture = binding
        ..commands['screenshot'] = (_) => 'taken';
      final answer = await idle(tester, {'quietMs': 100, 'timeoutMs': 1000});
      expect(answer['idle'], isTrue);
      expect(binding.holding, isTrue);
      expect(spinners(tester).loop.value, 0);
      expect(await methods.call('screenshot', {}), 'taken');
      await methods.call('screen', null);
      expect(binding.holding, isTrue);
      await methods.call('dismissKeyboard', null);
      expect(binding.holding, isFalse);
      await tester.pump();
    });
  });
}

Future<Map<String, Object?>> idleOf(WidgetTester tester, Methods methods, Map<String, Object?> params) async {
  Map<String, Object?>? answer;
  unawaited(methods.call('idle', params).then((r) => answer = (r! as Map).cast<String, Object?>()));
  for (var t = 0; t < 2000 && answer == null; t++) {
    await tester.pump(const Duration(milliseconds: 16));
  }
  return answer!;
}

class _Vsync implements TickerProvider {
  @override
  Ticker createTicker(TickerCallback onTick) => Ticker(onTick);
}

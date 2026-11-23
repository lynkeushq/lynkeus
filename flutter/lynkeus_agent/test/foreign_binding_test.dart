// ignore_for_file: deprecated_member_use

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lynkeus_agent/src/capture.dart';
import 'package:lynkeus_agent/src/methods.dart';

// An app's own binding the agent cannot mix into (mhabit's FixedIos26FlutterBinding, made before the agent started):
// here the test binding, with nothing of the agent's in it.
void main() {
  final binding = TestWidgetsFlutterBinding.ensureInitialized();
  final frames = ForeignFrames.install(binding);
  appFrames = frames;
  final methods = Methods()..capture = frames;

  Future<void> drive(WidgetTester tester, String method, [Object? params]) async {
    var done = false;
    unawaited(methods.call(method, params).then((_) => done = true));
    for (var t = 0; t < 3000 && !done; t++) {
      await tester.pump(const Duration(milliseconds: 16));
    }
    expect(done, isTrue, reason: '$method did not finish');
  }

  testWidgets("on a binding of the app's own, idle still waits out a timer a touch set", (tester) async {
    expect(binding, isNot(isA<FrameCapture>()));
    await tester.pumpWidget(const MaterialApp(home: _Toaster()));
    await drive(tester, 'press', {'text': 'Toast'});
    expect(find.text('Saved'), findsOneWidget);
    await drive(tester, 'idle', {'quietMs': 700, 'timeoutMs': 2800});
    expect(find.text('Saved'), findsNothing);
  });

  testWidgets("on a binding of the app's own, a blinking caret is still drawn on and held", (tester) async {
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: TextField(autofocus: true))));
    await tester.pump();
    expect(frames.wouldPin, isTrue);
    unawaited(frames.capture());
    // The test binding draws its frames itself, not through the engine's callbacks the agent wraps: draw one the way
    // those wrappers do.
    for (var draw = 0; draw < 2; draw++) {
      frames.beginFrame(
        () => binding.handleBeginFrame(binding.currentSystemFrameTimeStamp + const Duration(milliseconds: 16)),
      );
      frames.drawFrame(binding.handleDrawFrame);
      await tester.idle();
    }
    expect(frames.holding, isTrue);
    expect(tester.allRenderObjects.whereType<RenderEditable>().single.showCursor.value, isTrue);
    frames.release();
    FocusManager.instance.primaryFocus?.unfocus();
    await tester.pumpWidget(const SizedBox());
  });
}

class _Toaster extends StatefulWidget {
  const _Toaster();
  @override
  State<_Toaster> createState() => _ToasterState();
}

class _ToasterState extends State<_Toaster> {
  var shown = false;

  @override
  Widget build(BuildContext context) => Scaffold(
    body: Column(
      children: [
        TextButton(
          onPressed: () {
            setState(() => shown = true);
            Timer(const Duration(seconds: 2), () => setState(() => shown = false));
          },
          child: const Text('Toast'),
        ),
        if (shown) const Text('Saved'),
      ],
    ),
  );
}

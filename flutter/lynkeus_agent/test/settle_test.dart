// ignore_for_file: deprecated_member_use

import 'dart:async';

import 'package:clock/clock.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lynkeus_agent/src/capture.dart';
import 'package:lynkeus_agent/src/methods.dart';

/// The test binding with the agent's capture frames, as LynkeusBinding gives an app.
class _Binding extends AutomatedTestWidgetsFlutterBinding with FrameCapture {}

int _ms() => clock.now().millisecondsSinceEpoch;

/// Runs a method to its end, letting frames and timers move on as they would on a device.
Future<Map<String, Object?>> _drive(WidgetTester tester, Methods methods, String method, [Object? params]) async {
  Object? result;
  var done = false;
  Object? failure;
  unawaited(
    methods
        .call(method, params)
        .then(
          (value) {
            result = value;
            done = true;
          },
          onError: (Object error) {
            failure = error;
            done = true;
          },
        ),
  );
  for (var frames = 0; frames < 3000 && !done; frames++) {
    await tester.pump(const Duration(milliseconds: 16));
  }
  expect(done, isTrue, reason: '$method did not finish');
  if (failure != null) fail('$method failed: $failure');
  return result is Map ? (result! as Map).cast<String, Object?>() : const {};
}

// The CLI's idle after a step whose frame is compared (--settle 700), and after a press.
const _frameIdle = {'quietMs': 700, 'timeoutMs': 2800};
const _pressIdle = {'quietMs': 50, 'timeoutMs': 400};

void main() {
  final binding = _Binding();
  late Methods methods;

  setUp(() {
    binding.debugRelaunch();
    appFrames = binding;
    methods = Methods()..capture = binding;
  });

  // flutter_deer's goods page loads its list 2 s after it opens. A host's driver idles once before a case's first
  // step and a device's does not: the page's timer must be waited for either way.
  for (final idledFirst in [false, true]) {
    testWidgets('a page that loads 2 s after it opens is caught loaded (driver idled first: $idledFirst)', (
      tester,
    ) async {
      await tester.pumpWidget(const MaterialApp(home: _Opener()));
      if (idledFirst) {
        expect((await _drive(tester, methods, 'idle', {'quietMs': 300, 'timeoutMs': 5000}))['idle'], isTrue);
      }
      await _drive(tester, methods, 'press', {'text': 'Open'});
      final pressed = _ms();
      await _drive(tester, methods, 'idle', _frameIdle);
      expect(find.text('Loaded'), findsOneWidget);
      expect(_ms() - pressed, greaterThanOrEqualTo(2000));
    });
  }

  testWidgets('a toast is waited out by the frame\'s idle, and still there for a press\'s shorter one', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: _Toaster()));
    await _drive(tester, methods, 'press', {'text': 'Toast'});
    final pressed = _ms();
    await _drive(tester, methods, 'idle', _pressIdle);
    expect(_ms() - pressed, lessThan(1000));
    expect(find.text('Saved'), findsOneWidget, reason: 'a 2 s toast outlasts 400 ms');
    await _drive(tester, methods, 'idle', _frameIdle);
    expect(find.text('Saved'), findsNothing, reason: 'its timer and its fade are over');
  });

  testWidgets('what a waited-out timer sets off is waited for past the timeout', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: _Toaster(fadeOut: Duration(milliseconds: 1500))));
    await _drive(tester, methods, 'press', {'text': 'Toast'});
    await _drive(tester, methods, 'idle', _frameIdle);
    expect(find.text('Saved'), findsNothing);
  });

  testWidgets('a fade the step itself started is left to the quiet: idle does not wait it out', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: _Fader()));
    await _drive(tester, methods, 'press', {'text': 'Fade'});
    final answer = await _drive(tester, methods, 'idle', {'quietMs': 100, 'timeoutMs': 3000});
    expect(answer['idle'], isTrue);
    expect(tester.state<_FaderState>(find.byType(_Fader)).fade.value, lessThan(1));
    await tester.pump(const Duration(seconds: 1));
  });

  testWidgets('a touch\'s ink is not waited for: a press\'s idle answers before its ripple ends', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Center(
            child: TextButton(onPressed: () {}, child: const Text('Tap')),
          ),
        ),
      ),
    );
    await _drive(tester, methods, 'press', {'text': 'Tap'});
    final started = _ms();
    final answer = await _drive(tester, methods, 'idle', _pressIdle);
    expect(answer['idle'], isTrue);
    expect(_ms() - started, lessThan(300));
  });

  testWidgets('pull to refresh is caught refreshed, its indicator gone', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: _Refreshing()));
    await _drive(tester, methods, 'swipe', {'direction': 'down'});
    await _drive(tester, methods, 'idle', _frameIdle);
    expect(find.text('Fresh 1 row 0'), findsOneWidget);
    expect(find.byType(RefreshProgressIndicator), findsNothing);
  });

  testWidgets('a timer set again from where one fired (a polling loop) is not waited for', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: _Poller()));
    await _drive(tester, methods, 'press', {'text': 'Poll'});
    final started = _ms();
    await _drive(tester, methods, 'idle', {'quietMs': 100, 'timeoutMs': 2800});
    expect(_ms() - started, lessThan(1500));
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 1));
  });

  testWidgets('a timer set for longer than the idle waits is not waited for', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: _Opener(loadAfter: Duration(seconds: 5))));
    await _drive(tester, methods, 'press', {'text': 'Open'});
    final started = _ms();
    await _drive(tester, methods, 'idle', _frameIdle);
    expect(_ms() - started, lessThan(2000));
    expect(find.text('Loading'), findsOneWidget);
    await tester.pump(const Duration(seconds: 5));
  });

  testWidgets('typed text runs where its debounce is waited for', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: _Search()));
    await _drive(tester, methods, 'type', {
      'target': {'testId': 'query'},
      'text': 'deer',
    });
    await _drive(tester, methods, 'idle', {'quietMs': 100, 'timeoutMs': 800});
    expect(find.text('Results for deer'), findsOneWidget);
    await _drive(tester, methods, 'dismissKeyboard');
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('a controller its status listener starts again is a loop: drawn at its start, not waited for', (
    tester,
  ) async {
    await tester.pumpWidget(const MaterialApp(home: _Pulse()));
    await tester.pump(const Duration(milliseconds: 1234));
    final started = _ms();
    final answer = await _drive(tester, methods, 'idle', {'quietMs': 100, 'timeoutMs': 1000});
    expect(answer['idle'], isTrue);
    expect(_ms() - started, lessThan(500));
    expect(binding.holding, isTrue);
    expect(tester.state<_PulseState>(find.byType(_Pulse)).pulse.value, 0);
    binding.release();
  });

  testWidgets('an image still loading keeps idle from answering', (tester) async {
    final image = _Pending();
    await tester.pumpWidget(MaterialApp(home: Image(image: image)));
    Map<String, Object?>? answer;
    unawaited(methods.call('idle', {'quietMs': 100, 'timeoutMs': 2000}).then((r) => answer = (r! as Map).cast()));
    for (var t = 0; t < 40; t++) {
      await tester.pump(const Duration(milliseconds: 16));
    }
    expect(answer, isNull, reason: 'the image is still loading');
    image.done.completeError(StateError('no picture'));
    for (var t = 0; t < 40 && answer == null; t++) {
      await tester.pump(const Duration(milliseconds: 16));
    }
    expect(answer?['idle'], isTrue);
    tester.takeException();
  });

  // mhabit's undo: the snackbar's close needs frames, and a step that waits for it to go polls only `screen`.
  testWidgets('a held capture frame lets go at the next read: a closing snackbar is seen gone', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: _Closing()));
    await _drive(tester, methods, 'press', {'text': 'Undo'});
    await _drive(tester, methods, 'idle', _pressIdle);
    expect(binding.holding, isTrue, reason: 'a spinner turns while the banner closes');
    var gone = false;
    for (var look = 0; look < 40 && !gone; look++) {
      final screen = await _drive(tester, methods, 'screen');
      gone = !(screen['elements']! as List).any((e) => (e as Map)['text'] == 'Deleted habit');
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(gone, isTrue);
    binding.release();
    await tester.pumpWidget(const SizedBox());
  });

  // mhabit's archive: `back`, then a press 158 ms later. The pop sets the navigator absorbing pointers until its next
  // frame; with frames held since the last idle, a press sent before that frame reached nothing. A request that lets
  // the hold go runs once a frame has been drawn.
  testWidgets('a request after a hold acts only once a frame has been drawn', (tester) async {
    var frames = 0;
    int? framesWhenActing;
    binding.addPersistentFrameCallback((_) => frames++);
    methods.commands['act'] = (_) => framesWhenActing = frames;
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: CircularProgressIndicator())));
    await _drive(tester, methods, 'idle', {'quietMs': 100, 'timeoutMs': 2000});
    expect(binding.holding, isTrue, reason: 'the spinner is held at its start');
    final held = frames;
    await tester.pump(const Duration(milliseconds: 100));
    expect(frames, held, reason: 'no frame while held');
    await _drive(tester, methods, 'act');
    expect(framesWhenActing, greaterThan(held));
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('a hold reports how long the screen stood still', (tester) async {
    final holds = <int>[];
    binding.onHoldEnded = (ms, {required expired}) => holds.add(ms);
    await tester.pumpWidget(const MaterialApp(home: Center(child: CircularProgressIndicator())));
    await _drive(tester, methods, 'idle', {'quietMs': 100, 'timeoutMs': 1000});
    expect(binding.holding, isTrue);
    await tester.pump(const Duration(milliseconds: 500));
    await _drive(tester, methods, 'dismissKeyboard');
    expect(holds.single, inInclusiveRange(500, 600));
    binding.onHoldEnded = null;
  });
}

/// A page that opens another, which loads its content after a delay, as flutter_deer's goods list does.
class _Opener extends StatelessWidget {
  const _Opener({this.loadAfter = const Duration(seconds: 2)});
  final Duration loadAfter;

  @override
  Widget build(BuildContext context) => Scaffold(
    body: Center(
      child: TextButton(
        onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => _Loading(loadAfter))),
        child: const Text('Open'),
      ),
    ),
  );
}

class _Loading extends StatefulWidget {
  const _Loading(this.after);
  final Duration after;
  @override
  State<_Loading> createState() => _LoadingState();
}

class _LoadingState extends State<_Loading> {
  var loaded = false;

  @override
  void initState() {
    super.initState();
    Future<void>.delayed(widget.after, () {
      if (mounted) setState(() => loaded = true);
    });
  }

  @override
  Widget build(BuildContext context) => Scaffold(body: Center(child: Text(loaded ? 'Loaded' : 'Loading')));
}

/// A toast shown for 2 s, then faded out, as oktoast does.
class _Toaster extends StatefulWidget {
  const _Toaster({this.fadeOut = const Duration(milliseconds: 250)});
  final Duration fadeOut;
  @override
  State<_Toaster> createState() => _ToasterState();
}

class _ToasterState extends State<_Toaster> with SingleTickerProviderStateMixin {
  late final fade = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 250),
    reverseDuration: widget.fadeOut,
  );
  var shown = false;

  @override
  void dispose() {
    fade.dispose();
    super.dispose();
  }

  void _toast() {
    setState(() => shown = true);
    fade.forward(from: 0);
    Timer(const Duration(seconds: 2), () async {
      await fade.reverse();
      if (mounted) setState(() => shown = false);
    });
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    body: Column(
      children: [
        TextButton(onPressed: _toast, child: const Text('Toast')),
        if (shown) FadeTransition(opacity: fade, child: const Text('Saved')),
      ],
    ),
  );
}

class _Fader extends StatefulWidget {
  const _Fader();
  @override
  State<_Fader> createState() => _FaderState();
}

class _FaderState extends State<_Fader> with SingleTickerProviderStateMixin {
  late final fade = AnimationController(vsync: this, duration: const Duration(milliseconds: 900));

  @override
  void dispose() {
    fade.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    body: Column(
      children: [
        TextButton(onPressed: () => fade.forward(), child: const Text('Fade')),
        FadeTransition(opacity: fade, child: const Text('Faded in')),
      ],
    ),
  );
}

/// A list whose pull to refresh takes 2 s, as flutter_deer's orders do.
class _Refreshing extends StatefulWidget {
  const _Refreshing();
  @override
  State<_Refreshing> createState() => _RefreshingState();
}

class _RefreshingState extends State<_Refreshing> {
  var refreshed = 0;

  @override
  Widget build(BuildContext context) => Scaffold(
    body: RefreshIndicator(
      onRefresh: () => Future<void>.delayed(const Duration(seconds: 2), () => setState(() => refreshed++)),
      child: ListView(children: [for (var i = 0; i < 30; i++) ListTile(title: Text('Fresh $refreshed row $i'))]),
    ),
  );
}

class _Poller extends StatefulWidget {
  const _Poller();
  @override
  State<_Poller> createState() => _PollerState();
}

class _PollerState extends State<_Poller> {
  var polls = 0;
  var on = false;

  Future<void> _poll() async {
    while (on && mounted) {
      await Future<void>.delayed(const Duration(milliseconds: 500));
      if (mounted) setState(() => polls++);
    }
  }

  @override
  void dispose() {
    on = false;
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    body: TextButton(
      onPressed: () {
        on = true;
        _poll();
      },
      child: const Text('Poll'),
    ),
  );
}

class _Search extends StatefulWidget {
  const _Search();
  @override
  State<_Search> createState() => _SearchState();
}

class _SearchState extends State<_Search> {
  Timer? _debounce;
  var query = '';

  @override
  void dispose() {
    _debounce?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    body: Column(
      children: [
        TextField(
          key: const ValueKey('query'),
          onChanged: (text) {
            _debounce?.cancel();
            _debounce = Timer(const Duration(milliseconds: 500), () => setState(() => query = text));
          },
        ),
        Text('Results for $query'),
      ],
    ),
  );
}

/// A pulse that starts itself over when it ends, from its own status listener.
class _Pulse extends StatefulWidget {
  const _Pulse();
  @override
  State<_Pulse> createState() => _PulseState();
}

class _PulseState extends State<_Pulse> with SingleTickerProviderStateMixin {
  late final AnimationController pulse = AnimationController(vsync: this, duration: const Duration(milliseconds: 700))
    ..addStatusListener((status) {
      if (status == AnimationStatus.completed) pulse.forward(from: 0);
    })
    ..forward();

  @override
  void dispose() {
    pulse.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    body: Center(
      child: ScaleTransition(
        scale: pulse,
        child: const SizedBox(width: 40, height: 40, child: ColoredBox(color: Colors.red)),
      ),
    ),
  );
}

/// An image whose load ends when the test says.
class _Pending extends ImageProvider<_Pending> {
  final done = Completer<ImageInfo>();

  @override
  Future<_Pending> obtainKey(ImageConfiguration configuration) => SynchronousFuture(this);

  @override
  ImageStreamCompleter loadImage(_Pending key, ImageDecoderCallback decode) =>
      OneFrameImageStreamCompleter(done.future);
}

/// A banner that closes over 1 s once its action is pressed, beside a spinner.
class _Closing extends StatefulWidget {
  const _Closing();
  @override
  State<_Closing> createState() => _ClosingState();
}

class _ClosingState extends State<_Closing> with SingleTickerProviderStateMixin {
  late final close = AnimationController(vsync: this, duration: const Duration(seconds: 1), value: 1);
  var shown = true;

  @override
  void dispose() {
    close.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    body: Column(
      children: [
        const CircularProgressIndicator(),
        if (shown)
          FadeTransition(
            opacity: close,
            child: TextButton(
              onPressed: () async {
                await close.reverse();
                setState(() => shown = false);
              },
              child: const Text('Undo'),
            ),
          ),
        if (shown) const Text('Deleted habit'),
      ],
    ),
  );
}

// ignore_for_file: deprecated_member_use

import 'dart:async';

import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lynkeus_agent/src/methods.dart';
import 'package:lynkeus_agent/src/network.dart';
import 'package:lynkeus_agent/src/touch.dart' as touch;

/// Runs a method to its end, letting frames and timers move on as they would on a device.
Future<Object?> drive(WidgetTester tester, Methods methods, String method, [Object? params]) async {
  var done = false;
  Object? result;
  Object? failure;
  methods
      .call(method, params)
      .then(
        (value) {
          done = true;
          result = value;
        },
        onError: (Object error) {
          done = true;
          failure = error;
        },
      );
  for (var frames = 0; frames < 3000 && !done; frames++) {
    await tester.pump(const Duration(milliseconds: 16));
  }
  if (failure != null) throw failure!;
  expect(done, isTrue, reason: '$method did not finish');
  return result;
}

/// The error a method ends with; called outside expectLater, whose guard would refuse the pumps inside.
Future<String> failureOf(WidgetTester tester, Methods methods, String method, [Object? params]) async {
  try {
    await drive(tester, methods, method, params);
  } catch (error) {
    return '$error';
  }
  fail('$method did not fail');
}

Map<String, Object?> asMap(Object? value) => (value! as Map).cast<String, Object?>();

class Sample extends StatefulWidget {
  const Sample({super.key});
  @override
  State<Sample> createState() => _SampleState();
}

class _SampleState extends State<Sample> {
  var count = 0;
  var typed = '';
  var submitted = '';
  var loading = false;

  @override
  Widget build(BuildContext context) => Scaffold(
    body: ListView(
      key: const ValueKey('list'),
      children: [
        Text('Count: $count', key: const ValueKey('count')),
        ElevatedButton(
          key: const ValueKey('increment'),
          onPressed: () => setState(() => count++),
          child: const Text('Add one'),
        ),
        TextField(
          key: const ValueKey('name'),
          inputFormatters: [TextInputFormatter.withFunction((_, next) => next.copyWith(text: next.text.toUpperCase()))],
          onChanged: (value) => setState(() => typed = value),
          onSubmitted: (value) => setState(() => submitted = value),
        ),
        Text('Typed: $typed'),
        Text('Submitted: $submitted'),
        ElevatedButton(onPressed: () => setState(() => loading = !loading), child: const Text('Toggle spinner')),
        if (loading) const Center(child: CircularProgressIndicator()),
        ElevatedButton(
          onPressed: () => Navigator.of(
            context,
          ).push(MaterialPageRoute<void>(builder: (_) => const Scaffold(body: Text('Second page')))),
          child: const Text('Open'),
        ),
        for (var i = 0; i < 40; i++) SizedBox(height: 60, child: Text('Row $i')),
      ],
    ),
  );
}

void main() {
  late Methods methods;

  Future<void> start(WidgetTester tester) async {
    await tester.pumpWidget(const MaterialApp(home: Sample()));
    methods = Methods();
  }

  testWidgets('press puts a finger on the button: its onPressed runs once', (tester) async {
    await start(tester);
    final result = asMap(await drive(tester, methods, 'press', {'testId': 'increment'}));
    expect(result['mode'], 'native');
    expect(asMap(result['element'])['testId'], 'increment');
    expect(find.text('Count: 1'), findsOneWidget);
    await drive(tester, methods, 'press', {'text': 'Add one'});
    expect(find.text('Count: 2'), findsOneWidget);
  });

  testWidgets('press on something that is not there fails with the target', (tester) async {
    await start(tester);
    expect(
      await failureOf(tester, methods, 'press', {'testId': 'nope'}),
      contains('No element matches {"testId":"nope"}'),
    );
  });

  testWidgets('press waits out a loading dialog that covers its target for a moment', (tester) async {
    await start(tester);
    final context = tester.element(find.byType(Sample));
    // What a page below does: it opens a loading dialog and closes it when its request is back.
    unawaited(
      showDialog<void>(
        context: context,
        builder: (_) => const Center(child: Text('Loading')),
      ),
    );
    await tester.pump();
    Future<void>.delayed(const Duration(milliseconds: 600), () => Navigator.of(context).pop());
    final result = asMap(await drive(tester, methods, 'press', {'testId': 'increment'}));
    expect(asMap(result['element'])['testId'], 'increment');
    expect(find.text('Count: 1'), findsOneWidget);
  });

  testWidgets('press says the target is behind a dialog that stays', (tester) async {
    await start(tester);
    unawaited(
      showDialog<void>(
        context: tester.element(find.byType(Sample)),
        builder: (_) => const Center(child: Text('Stays')),
      ),
    );
    await tester.pump();
    expect(
      await failureOf(tester, methods, 'press', {'testId': 'increment'}),
      contains('{"testId":"increment"} is not presented (behind-modal)'),
    );
    expect(find.text('Count: 0'), findsOneWidget);
  });

  testWidgets('type goes through the keyboard path: formatters and onChanged run, submit ends it', (tester) async {
    await start(tester);
    await drive(tester, methods, 'type', {
      'target': {'testId': 'name'},
      'text': 'ana',
      'submit': true,
    });
    expect(find.text('ANA'), findsOneWidget);
    expect(find.text('Typed: ANA'), findsOneWidget);
    expect(find.text('Submitted: ANA'), findsOneWidget);
    final screen = asMap(await drive(tester, methods, 'screen'));
    final field = (screen['elements']! as List).cast<Map<String, Object?>>().firstWhere((e) => e['testId'] == 'name');
    expect(field['value'], 'ANA');

    await drive(tester, methods, 'type', {
      'target': {'testId': 'name'},
      'text': 'beto',
      'clear': true,
    });
    expect(find.text('Typed: BETO'), findsOneWidget);
    expect(await drive(tester, methods, 'dismissKeyboard'), isTrue);
    expect(FocusManager.instance.primaryFocus?.context?.widget, isNot(isA<EditableText>()));
  });

  testWidgets('waitFor with scroll swipes the list until the row is in the window', (tester) async {
    await start(tester);
    expect(find.text('Row 30'), findsNothing);
    final result = asMap(
      await drive(tester, methods, 'waitFor', {
        'target': {'text': 'Row 30'},
        'scroll': true,
        'timeoutMs': 15000,
      }),
    );
    expect(result['waitedMs'], isA<int>());
    expect(tester.getCenter(find.text('Row 30')).dy, inInclusiveRange(0, 600));
    final list = tester.state<ScrollableState>(find.byType(Scrollable).first).position;
    expect(list.isScrollingNotifier.value, isFalse, reason: 'it answered while the list still coasted');
  });

  testWidgets('a swipe drags the list; a press brings a row in first', (tester) async {
    await start(tester);
    final swiped = asMap(await drive(tester, methods, 'swipe', {'direction': 'up'}));
    expect(asMap(swiped['from'])['y'], greaterThan(asMap(swiped['to'])['y']! as num));
    await tester.pumpAndSettle();
    expect(find.text('Count: 0'), findsNothing, reason: 'the top of the list moved out');
  });

  testWidgets('a fast swipe answers once the fling it started has stopped', (tester) async {
    await start(tester);
    final position = tester
        .state<ScrollableState>(
          find.descendant(of: find.byKey(const ValueKey('list')), matching: find.byType(Scrollable)).first,
        )
        .position;
    final swiped = asMap(await drive(tester, methods, 'swipe', {'direction': 'up', 'durationMs': 60}));
    expect(swiped['settledMs'], isA<int>());
    final landed = position.pixels;
    expect(position.isScrollingNotifier.value, isFalse);
    await tester.pump(const Duration(seconds: 1));
    expect(position.pixels, landed, reason: 'the list had stopped when swipe answered');
  });

  // A busy device fires the gesture's timers late: here, every other move 40 ms after it was due.
  Future<double> flungTo(WidgetTester tester, Duration Function(int k)? late) async {
    touch.debugLate = late;
    addTearDown(() => touch.debugLate = null);
    await tester.pumpWidget(const SizedBox());
    await tester.pumpWidget(const MaterialApp(home: Sample()));
    final position = tester
        .state<ScrollableState>(
          find.descendant(of: find.byKey(const ValueKey('list')), matching: find.byType(Scrollable)).first,
        )
        .position;
    var done = false;
    Methods().call('swipe', {'direction': 'up', 'durationMs': 200}).then((_) => done = true);
    for (var frames = 0; frames < 2000 && !done; frames++) {
      await tester.pump(const Duration(milliseconds: 16));
    }
    await tester.pumpAndSettle();
    return position.pixels;
  }

  testWidgets('a swipe flings to the same offset however late its moves are dispatched', (tester) async {
    final onTime = await flungTo(tester, null);
    final late = await flungTo(tester, (k) => Duration(milliseconds: k.isEven ? 40 : 0));
    expect(onTime, greaterThan(400), reason: 'a fast swipe flings past what the finger moved');
    expect(late, closeTo(onTime, 1));
  });

  testWidgets('waitFor gone and a timeout that says what it waited for', (tester) async {
    await start(tester);
    await drive(tester, methods, 'press', {'text': 'Open'});
    final gone = asMap(
      await drive(tester, methods, 'waitFor', {
        'target': {'testId': 'increment'},
        'gone': true,
      }),
    );
    expect(gone['waitedMs'], isA<int>());
    final timedOut = await failureOf(tester, methods, 'waitFor', {
      'target': {'text': 'Never'},
      'timeoutMs': 300,
    });
    expect(timedOut, allOf(contains('Timed out waiting for'), contains('Never')));
  });

  testWidgets('idle returns once the screen is quiet, and an endless spinner does not keep it busy', (tester) async {
    await start(tester);
    final quiet = asMap(await drive(tester, methods, 'idle', {'quietMs': 100, 'timeoutMs': 2000}));
    expect(quiet['idle'], isTrue);
    await drive(tester, methods, 'press', {'text': 'Toggle spinner'});
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    final spinning = asMap(await drive(tester, methods, 'idle', {'quietMs': 100, 'timeoutMs': 2000}));
    expect(spinning['idle'], isTrue);
    final before = (spinning['commit']! as num).toInt();
    await drive(tester, methods, 'press', {'testId': 'increment'});
    final after = asMap(await drive(tester, methods, 'idle', {'quietMs': 100, 'timeoutMs': 2000, 'after': before}));
    expect(after['idle'], isTrue);
    expect((after['commit']! as num).toInt(), greaterThan(before));
  });

  testWidgets('idle waits out a request the step made past its timeout, up to a bound', (tester) async {
    await start(tester);
    final network = _Network();
    methods.network = network;
    final started = clock.now().millisecondsSinceEpoch;
    network.startedAt = started;
    Map<String, Object?>? result;
    unawaited(methods.call('idle', {'quietMs': 100, 'timeoutMs': 300}).then((r) => result = asMap(r)));
    for (var t = 0; t < 2000 ~/ 16; t++) {
      await tester.pump(const Duration(milliseconds: 16));
    }
    expect(result, isNull, reason: 'idle answered with a request still out');
    network.out = 0;
    for (var t = 0; t < 1000 ~/ 16 && result == null; t++) {
      await tester.pump(const Duration(milliseconds: 16));
    }
    expect(result?['idle'], isTrue);
    expect(clock.now().millisecondsSinceEpoch - started, greaterThanOrEqualTo(2100));
    // One that never ends holds it only so long: the timeout and 10 s more.
    network
      ..out = 1
      ..startedAt = clock.now().millisecondsSinceEpoch;
    final stuck = clock.now().millisecondsSinceEpoch;
    final gaveUp = asMap(await drive(tester, methods, 'idle', {'quietMs': 100, 'timeoutMs': 300}));
    expect(gaveUp['idle'], isFalse);
    expect(clock.now().millisecondsSinceEpoch - stuck, inInclusiveRange(10300, 10500));
    // Still out at the last answer, it is a long poll, not the step's: busy, but only until the timeout.
    final polling = clock.now().millisecondsSinceEpoch;
    final again = asMap(await drive(tester, methods, 'idle', {'quietMs': 100, 'timeoutMs': 300}));
    expect(again['idle'], isFalse);
    expect(clock.now().millisecondsSinceEpoch - polling, inInclusiveRange(300, 400));
  });

  // The platform's messages are handled in the zone the binding started in, outside a widget test's fake time: these
  // run on real time.
  testWidgets('back pops the top route, and says so when there is nothing to pop', (tester) async {
    await start(tester);
    expect(await failureOf(tester, methods, 'back'), contains('Nothing to go back to'));
    await drive(tester, methods, 'press', {'text': 'Open'});
    await tester.pumpAndSettle();
    expect(find.text('Second page'), findsOneWidget);
    await tester.runAsync(() => methods.call('back', null));
    await tester.pumpAndSettle();
    expect(find.text('Second page'), findsNothing);
  });

  testWidgets('deepLink pushes the route the platform would', (tester) async {
    await tester.pumpWidget(
      MaterialApp(routes: {'/': (_) => const Text('Home'), '/settings': (_) => const Text('Settings')}),
    );
    methods = Methods();
    late Future<Object?> pending;
    var answered = false;
    await tester.runAsync(() async {
      pending = methods.call('deepLink', {'url': 'sample://app/settings'})..then((_) => answered = true);
      await Future<void>.delayed(const Duration(milliseconds: 20));
    });
    // The route is pushed, but no frame has built it yet: the answer waits for one.
    expect(answered, isFalse);
    await tester.pump();
    final opened = await tester.runAsync(() => pending);
    expect(asMap(opened)['opened'], 'sample://app/settings');
    expect(find.text('Settings', skipOffstage: false), findsOneWidget);
    await tester.pumpAndSettle();
    expect(find.text('Settings'), findsOneWidget);
  });

  testWidgets('batch runs calls in order and stops at the first error', (tester) async {
    await start(tester);
    final result = asMap(
      await drive(tester, methods, 'batch', {
        'calls': [
          {
            'method': 'press',
            'params': {'testId': 'increment'},
          },
          {
            'method': 'find',
            'params': {'testId': 'increment'},
          },
        ],
      }),
    );
    final results = result['results']! as List;
    expect(asMap(results[1])['testId'], 'increment');
    await tester.pump();
    expect(find.text('Count: 1'), findsOneWidget);
    final failure = await failureOf(tester, methods, 'batch', {
      'calls': [
        {
          'method': 'press',
          'params': {'testId': 'nope'},
        },
        {
          'method': 'press',
          'params': {'testId': 'increment'},
        },
      ],
    });
    expect(failure, contains('No element matches'));
    await tester.pump();
    expect(find.text('Count: 1'), findsOneWidget);
  });

  testWidgets('app commands answer by name and show in ping', (tester) async {
    await start(tester);
    methods.commands['reset'] = (_) => {'done': true};
    expect(asMap(await drive(tester, methods, 'ping'))['commands'], ['reset']);
    expect(await drive(tester, methods, 'reset'), {'done': true});
    expect(await failureOf(tester, methods, 'nope'), 'Unknown method nope');
  });

  testWidgets('waitFor with scroll brings a row cut by the window\'s edge all the way in', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ListView(
            children: [
              const SizedBox(height: 560),
              const SizedBox(height: 60, child: Text('Language')),
              for (var i = 0; i < 20; i++) SizedBox(height: 60, child: Text('Row $i')),
            ],
          ),
        ),
      ),
    );
    final window = tester.view.physicalSize / tester.view.devicePixelRatio;
    expect(tester.getRect(find.text('Language')).bottom, greaterThan(window.height));
    expect(tester.getCenter(find.text('Language')).dy, lessThan(window.height));
    methods = Methods();
    await drive(tester, methods, 'waitFor', {
      'target': {'text': 'Language'},
      'scroll': true,
      'timeoutMs': 10000,
    });
    expect(tester.getRect(find.text('Language')).bottom, lessThanOrEqualTo(window.height));
  });

  testWidgets('a drag held still before the finger lifts leaves the list where the finger left it', (tester) async {
    final controller = ScrollController();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ListView(
            controller: controller,
            children: [for (var i = 0; i < 80; i++) SizedBox(height: 60, child: Text('Row $i'))],
          ),
        ),
      ),
    );
    Future<double> dragged(int holdMs) async {
      controller.jumpTo(0);
      var done = false;
      touch.drag(const Offset(200, 500), const Offset(200, 200), 100, holdMs: holdMs).then((_) => done = true);
      while (!done) {
        await tester.pump(const Duration(milliseconds: 16));
      }
      final lifted = controller.offset;
      await tester.pumpAndSettle();
      return controller.offset - lifted;
    }

    expect(await dragged(0), greaterThan(100), reason: 'a quick drag flings on');
    expect(await dragged(120), 0);
  });

  testWidgets('waitFor with scroll turns back at the end of a list that something keeps animating', (tester) async {
    final controller = ScrollController();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ListView(
            controller: controller,
            children: [
              for (var i = 0; i < 40; i++) SizedBox(height: 60, child: Text('Row $i')),
              const Bouncing(),
            ],
          ),
        ),
      ),
    );
    controller.jumpTo(controller.position.maxScrollExtent);
    await tester.pump();
    methods = Methods();
    final result = asMap(
      await drive(tester, methods, 'waitFor', {
        'target': {'text': 'Row 0'},
        'scroll': true,
        'timeoutMs': 30000,
      }),
    );
    expect(result['waitedMs'], isA<int>());
    expect(find.text('Row 0'), findsOneWidget);
  });

  testWidgets('waitFor with scroll waits for a list that loads more at its end', (tester) async {
    var backward = false;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          // A finger moving down drags the list back up: the scroll gave up on the end and turned around.
          body: Listener(onPointerMove: (e) => backward |= e.delta.dy > 0, child: const Pages()),
        ),
      ),
    );
    methods = Methods();
    final result = asMap(
      await drive(tester, methods, 'waitFor', {
        'target': {'text': 'Row 55'},
        'scroll': true,
        'timeoutMs': 30000,
      }),
    );
    expect(result['waitedMs'], isA<int>());
    expect(find.text('Row 55'), findsOneWidget);
    expect(backward, isFalse, reason: 'the list was loading its next page, not at its end');
  });
}

/// Twenty rows a page; reaching the very end shows a footer and adds the next page two seconds later, three pages in
/// all; a pull to refresh at the top starts over with one page.
class Pages extends StatefulWidget {
  const Pages({super.key});
  @override
  State<Pages> createState() => _PagesState();
}

class _PagesState extends State<Pages> {
  var rows = 20;
  var loading = false;

  @override
  Widget build(BuildContext context) => NotificationListener<ScrollNotification>(
    onNotification: (n) {
      if (!loading && rows < 60 && n.metrics.extentAfter < 50) {
        loading = true;
        Future<void>.delayed(
          const Duration(seconds: 1),
          () => setState(() {
            rows += 20;
            loading = false;
          }),
        );
      }
      return false;
    },
    // A pull at the top starts the list over, as flutter_deer's order list does.
    child: RefreshIndicator(
      onRefresh: () => Future<void>.delayed(const Duration(seconds: 2), () => setState(() => rows = 20)),
      child: ListView.builder(
        itemCount: rows + 1,
        itemBuilder: (_, i) => SizedBox(height: 60, child: Text(i == rows ? 'Loading more' : 'Row $i')),
      ),
    ),
  );
}

/// A label that never stops moving up and down, as an app's animated hero does.
class Bouncing extends StatefulWidget {
  const Bouncing({super.key});
  @override
  State<Bouncing> createState() => _BouncingState();
}

class _BouncingState extends State<Bouncing> with SingleTickerProviderStateMixin {
  late final _controller = AnimationController(vsync: this, duration: const Duration(milliseconds: 500))
    ..repeat(reverse: true);

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => SizedBox(
    height: 80,
    child: AnimatedBuilder(
      animation: _controller,
      builder: (context, _) => Padding(
        padding: EdgeInsets.only(top: 40 * _controller.value),
        child: const Text('Support us'),
      ),
    ),
  );
}

class _Network extends Network {
  _Network() : super(trace: (_) {});
  var out = 1;
  var startedAt = 0;
  @override
  int get inFlight => out;
  @override
  int inFlightSince(int ms) => startedAt >= ms ? out : 0;
}

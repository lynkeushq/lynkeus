// ignore_for_file: deprecated_member_use

import 'dart:async';

import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lynkeus_agent/src/capture.dart';
import 'package:lynkeus_agent/src/methods.dart';

/// The test binding with the agent's capture frames, as LynkeusBinding gives an app.
class _Binding extends AutomatedTestWidgetsFlutterBinding with FrameCapture {}

int _ms() => clock.now().millisecondsSinceEpoch;

Future<void> _drive(WidgetTester tester, Methods methods, String method, [Object? params]) async {
  var done = false;
  unawaited(methods.call(method, params).then((_) => done = true));
  for (var frames = 0; frames < 3000 && !done; frames++) {
    await tester.pump(const Duration(milliseconds: 16));
  }
  expect(done, isTrue, reason: '$method did not finish');
}

// In a file of its own: the agent's finger keeps the time of the first test that moved it (touch.dart's stopwatch runs
// on that test's fake clock), and the time this file measures is a swipe's.
void main() {
  final binding = _Binding();
  late Methods methods;

  setUp(() {
    binding.debugRelaunch();
    methods = Methods()..capture = binding;
  });

  // flutter_deer's orders: scrolled to the end of a list, a row above that is no longer built is looked for by going on
  // down first. The end is known at once when nothing could bring more, and the search turns back.
  for (final loading in [false, true]) {
    testWidgets('scroll-to-find turns back at a list\'s end at once unless more is coming (loading: $loading)', (
      tester,
    ) async {
      await tester.pumpWidget(MaterialApp(home: _Pages(loadsMore: loading)));
      final list = tester.state<ScrollableState>(find.byType(Scrollable)).position;
      list.jumpTo(list.maxScrollExtent);
      await tester.pump();
      final started = _ms();
      await _drive(tester, methods, 'waitFor', {
        'target': {'testId': 'row_1'},
        'scroll': true,
        'timeoutMs': 30000,
      });
      expect(find.byKey(const ValueKey('row_1')), findsOneWidget);
      if (loading) {
        expect(
          tester.state<_PagesState>(find.byType(_Pages)).rows,
          40,
          reason: 'the second page came before turning back',
        );
      } else {
        expect(_ms() - started, lessThan(3000), reason: 'no 3 s wait at the end');
      }
    });
  }
}

/// A list of 20 rows that loads 20 more, 2 s after its end is reached, once.
class _Pages extends StatefulWidget {
  const _Pages({required this.loadsMore});
  final bool loadsMore;
  @override
  State<_Pages> createState() => _PagesState();
}

class _PagesState extends State<_Pages> {
  var rows = 20;
  var loading = false;

  bool _atEnd(ScrollNotification n) {
    if (widget.loadsMore && !loading && rows == 20 && n.metrics.extentAfter < 50) {
      loading = true;
      Future<void>.delayed(const Duration(seconds: 2), () => setState(() => rows = 40));
    }
    return false;
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    body: NotificationListener<ScrollNotification>(
      onNotification: _atEnd,
      child: ListView.builder(
        itemCount: rows,
        itemBuilder: (_, i) => SizedBox(height: 60, key: ValueKey('row_$i'), child: Text('Row $i')),
      ),
    ),
  );
}

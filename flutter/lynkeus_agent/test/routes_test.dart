// ignore_for_file: deprecated_member_use

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lynkeus_agent/lynkeus_agent.dart';
import 'package:lynkeus_agent/src/methods.dart';

Future<Map<String, Object?>> drive(WidgetTester tester, Methods methods, String method, [Object? params]) async {
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
  for (var frames = 0; frames < 1000 && !done; frames++) {
    await tester.pump(const Duration(milliseconds: 16));
  }
  if (failure != null) throw failure!;
  expect(done, isTrue, reason: '$method did not finish');
  return (result! as Map).cast<String, Object?>();
}

void main() {
  late LynkeusNavigatorObserver observer;
  late Methods methods;
  late List<String?> told;

  Future<void> start(WidgetTester tester) async {
    observer = LynkeusNavigatorObserver();
    methods = Methods()..routes = observer.routes;
    told = [];
    methods.onNavigation = told.add;
    await tester.pumpWidget(
      MaterialApp(
        navigatorObservers: [observer],
        routes: {
          '/': (context) => Scaffold(
            body: TextButton(
              onPressed: () => showDialog<void>(
                context: context,
                builder: (_) => const AlertDialog(title: Text('Sure?')),
              ),
              child: const Text('Ask'),
            ),
          ),
          '/settings': (_) => const Scaffold(body: Text('Settings')),
        },
      ),
    );
  }

  testWidgets('reports the focused named route and the path to it', (tester) async {
    await start(tester);
    var screen = await drive(tester, methods, 'screen');
    expect(screen['route'], '/');
    expect(screen['path'], ['/']);

    expect((await drive(tester, methods, 'navigate', {'name': '/settings'}))['route'], '/settings');
    await tester.pumpAndSettle();
    expect(find.text('Settings'), findsOneWidget);
    screen = await drive(tester, methods, 'screen');
    expect(screen['route'], '/settings');
    expect(screen['path'], ['/', '/settings']);
    expect(told.last, '/settings');

    final trace = await drive(tester, methods, 'trace');
    final routes = (trace['events']! as List).cast<Map<String, Object?>>().where((e) => e['kind'] == 'route');
    expect(routes.last['route'], '/settings');
    expect(routes.last['path'], ['/', '/settings']);
  });

  testWidgets('a dialog has no name: the route stays the page under it', (tester) async {
    await start(tester);
    await tester.tap(find.text('Ask'));
    await tester.pumpAndSettle();
    expect(find.text('Sure?'), findsOneWidget);
    expect((await drive(tester, methods, 'screen'))['route'], '/');
  });

  testWidgets('waitFor a route, and one that came and went after a mark', (tester) async {
    await start(tester);
    final mark = (await drive(tester, methods, 'trace'))['last']! as int;
    await drive(tester, methods, 'navigate', {'name': '/settings'});
    expect((await drive(tester, methods, 'waitFor', {'route': '/settings'}))['route'], '/settings');
    tester.state<NavigatorState>(find.byType(Navigator)).pop();
    await tester.pumpAndSettle();
    final passed = await drive(tester, methods, 'waitFor', {'route': '/settings', 'since': mark, 'timeoutMs': 200});
    expect(passed['passed'], isTrue);
    expect(passed['route'], '/');
  });

  testWidgets("an app's own routes (a router's) stand in for the observer", (tester) async {
    final location = ValueNotifier<String>('home');
    methods = Methods()
      ..routes = LynkeusRoutes(
        current: () => location.value,
        changes: location,
        navigate: (name, params) => location.value = name,
      );
    await tester.pumpWidget(const MaterialApp(home: Text('Home')));
    await drive(tester, methods, 'navigate', {'name': 'profile'});
    final screen = await drive(tester, methods, 'screen');
    expect(screen['route'], 'profile');
    expect(screen['path'], ['profile']);
  });

  testWidgets('navigate without routes says how to give them', (tester) async {
    methods = Methods();
    await tester.pumpWidget(const MaterialApp(home: Text('Home')));
    Object? failure;
    try {
      await drive(tester, methods, 'navigate', {'name': 'x'});
    } catch (error) {
      failure = error;
    }
    expect('$failure', contains('navigatorObserver'));
  });
}

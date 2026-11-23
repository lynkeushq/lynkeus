// ignore_for_file: deprecated_member_use

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lynkeus_agent/src/methods.dart';
import 'package:lynkeus_agent/src/routes.dart';

import 'routes_test.dart' show drive;

/// What go_router's delegate answers as `state`: the matched route's name and its path pattern.
class _State {
  const _State(this.name, this.fullPath);
  final String? name;
  final String? fullPath;
}

/// A router of the app's own: one page per location, `/items/<id>` matched as `/items/:id` when [patterns] is on.
class _Delegate extends RouterDelegate<RouteInformation> with ChangeNotifier, PopNavigatorRouterDelegateMixin {
  _Delegate({this.patterns = false});
  final bool patterns;
  var location = '/';

  @override
  final navigatorKey = GlobalKey<NavigatorState>();

  _State get state {
    if (!patterns) throw NoSuchMethodError.withInvocation(this, Invocation.getter(#state));
    return location.startsWith('/items/') ? const _State(null, '/items/:id') : _State('home', location);
  }

  @override
  RouteInformation get currentConfiguration => RouteInformation(uri: Uri.parse(location));

  @override
  Future<void> setNewRoutePath(RouteInformation configuration) {
    location = configuration.uri.path;
    notifyListeners();
    return SynchronousFuture(null);
  }

  @override
  Widget build(BuildContext context) => Navigator(
    key: navigatorKey,
    pages: [
      const MaterialPage<void>(name: '/', child: _Home()),
      if (location != '/')
        MaterialPage<void>(
          name: location,
          child: Scaffold(body: Text('Page $location')),
        ),
    ],
    onDidRemovePage: (page) {
      location = '/';
      notifyListeners();
    },
  );
}

class _Parser extends RouteInformationParser<RouteInformation> {
  @override
  Future<RouteInformation> parseRouteInformation(RouteInformation routeInformation) =>
      SynchronousFuture(routeInformation);

  @override
  RouteInformation restoreRouteInformation(RouteInformation configuration) => configuration;
}

class _Home extends StatelessWidget {
  const _Home();
  @override
  Widget build(BuildContext context) => Scaffold(
    body: Column(
      children: [
        TextButton(
          onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const Details())),
          child: const Text('Details'),
        ),
        TextButton(
          onPressed: () => showDialog<void>(
            context: context,
            builder: (_) => const AlertDialog(title: Text('Sure?')),
          ),
          child: const Text('Ask'),
        ),
      ],
    ),
  );
}

class Details extends StatelessWidget {
  const Details({super.key});
  @override
  Widget build(BuildContext context) => const Scaffold(body: Text('The details'));
}

/// `navigate` delivers a path as the engine does, through the channel buffers, which move on the real event loop.
Future<void> navigateTo(WidgetTester tester, Methods methods, String name) async {
  late Future<Object?> pending;
  await tester.runAsync(() async {
    pending = methods.call('navigate', {'name': name});
    await Future<void>.delayed(const Duration(milliseconds: 20));
  });
  await tester.pump();
  await tester.runAsync(() => pending);
  await tester.pumpAndSettle();
}

void main() {
  late Methods methods;
  late List<String?> told;

  Future<void> start(WidgetTester tester, {bool patterns = false}) async {
    methods = Methods()..routes = defaultRoutes(LynkeusNavigatorObserver(), RouterRoutes());
    told = [];
    methods.onNavigation = told.add;
    await tester.pumpWidget(
      MaterialApp.router(
        routerDelegate: _Delegate(patterns: patterns),
        routeInformationParser: _Parser(),
        routeInformationProvider: PlatformRouteInformationProvider(
          initialRouteInformation: RouteInformation(uri: Uri.parse('/')),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('an app on a Router reports its location and goes to a path, with nothing wired', (tester) async {
    await start(tester);
    expect((await drive(tester, methods, 'screen'))['route'], '/');

    await navigateTo(tester, methods, '/settings');
    expect(find.text('Page /settings'), findsOneWidget);
    final screen = await drive(tester, methods, 'screen');
    expect(screen['route'], '/settings');
    expect(screen['path'], ['/settings']);
    expect(told.last, '/settings');
  });

  testWidgets(
    'a page pushed over the router with no name goes by its widget, and navigate pops back to the router\'s',
    (tester) async {
      await start(tester);
      await tester.tap(find.text('Details'));
      await tester.pumpAndSettle();
      var screen = await drive(tester, methods, 'screen');
      expect(screen['route'], 'Details');
      expect(screen['path'], ['/', 'Details']);
      expect(told.last, 'Details');

      await drive(tester, methods, 'navigate', {'name': '/'});
      await tester.pumpAndSettle();
      expect(find.text('The details'), findsNothing);
      screen = await drive(tester, methods, 'screen');
      expect(screen['route'], '/');
    },
  );

  testWidgets('a dialog is not a route, and a name that is not a path is refused with the reason', (tester) async {
    await start(tester);
    await tester.tap(find.text('Ask'));
    await tester.pumpAndSettle();
    expect((await drive(tester, methods, 'screen'))['route'], '/');
    await expectLater(
      () => methods.call('navigate', {'name': 'settings'}),
      throwsA(predicate((e) => '$e'.contains('not a path'))),
    );
  });

  testWidgets('a delegate with go_router\'s state reports the route by name, else by its path pattern', (tester) async {
    await start(tester, patterns: true);
    expect((await drive(tester, methods, 'screen'))['route'], 'home');
    await navigateTo(tester, methods, '/items/42');
    expect(find.text('Page /items/42'), findsOneWidget);
    expect((await drive(tester, methods, 'screen'))['route'], '/items/:id');
  });

  testWidgets('an app with no Router keeps the Navigator observer\'s routes', (tester) async {
    final observer = LynkeusNavigatorObserver();
    methods = Methods()..routes = defaultRoutes(observer, RouterRoutes());
    await tester.pumpWidget(
      MaterialApp(
        navigatorObservers: [observer],
        routes: {
          '/': (_) => const Scaffold(body: Text('Home')),
          '/settings': (_) => const Scaffold(body: Text('Settings')),
        },
      ),
    );
    expect((await drive(tester, methods, 'screen'))['route'], '/');
    await drive(tester, methods, 'navigate', {'name': '/settings'});
    await tester.pumpAndSettle();
    expect((await drive(tester, methods, 'screen'))['route'], '/settings');
  });
}

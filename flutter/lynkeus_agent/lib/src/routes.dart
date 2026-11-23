import 'dart:async';

import 'package:flutter/widgets.dart';

/// Where the app's routes come from: what the agent reports as `route` and `path`, and how `navigate` gets somewhere.
/// [LynkeusAgent.navigatorObserver] gives one for a Navigator with named routes; an app on a router (go_router,
/// auto_route, its own) builds one from that router's state, so the agent never depends on it.
class LynkeusRoutes {
  const LynkeusRoutes({required this.current, required this.changes, this.path, this.navigate});

  /// The focused route's name, or null when it has none.
  final String? Function() current;

  /// Fires whenever [current] may have changed.
  final Listenable changes;

  /// Route names from the root down to the focused one; just [current] when not given.
  final List<String> Function()? path;

  /// Goes to the route called [name]; the agent's `navigate` fails without it.
  final FutureOr<void> Function(String name, Map<String, Object?>? params)? navigate;
}

/// Follows the routes of the Navigator it is given to (`navigatorObservers: [LynkeusAgent.navigatorObserver]`, on the
/// root navigator). A page pushed with no name (`Navigator.push(MaterialPageRoute(builder: (_) => const Items()))`)
/// goes by the class of the widget it shows, `Items`, which is also what `lynkeus map` calls it. A route that is not a
/// page (a dialog, a sheet) is on screen but not reported: the route stays the one under it.
class LynkeusNavigatorObserver extends NavigatorObserver with ChangeNotifier {
  final _stack = <Route<dynamic>>[];

  /// Widget classes seen as pages pushed without a name: they cannot be opened by name.
  final _unnamed = <String>{};

  List<String> get names => [
    for (final route in _stack)
      if (nameOf(route) case final String name) name,
  ];

  /// A route's name, or for a page pushed without one the class of the widget its builder made; null until it is built.
  static String? nameOf(Route<dynamic> route) {
    if (route.settings.name case final String name) return name;
    if (route is! PageRoute) return null;
    var element = route.subtreeContext as Element?;
    // Under the route's own RepaintBoundary: the Builder that calls buildPage, then (Material, Cupertino) a Semantics.
    for (var depth = 0; element != null && depth < 4; depth++) {
      Element? child;
      element.visitChildElements((c) => child ??= c);
      final widget = child?.widget;
      if (widget == null) return null;
      if (widget is! Builder && widget is! Semantics && widget is! RepaintBoundary) {
        return '${widget.runtimeType}'.split('<').first;
      }
      element = child;
    }
    return null;
  }

  String? get current {
    final all = names;
    return all.isEmpty ? null : all.last;
  }

  late final LynkeusRoutes routes = LynkeusRoutes(
    current: () => current,
    path: () => names,
    changes: this,
    navigate: (name, params) async {
      // Right after launch the navigator may not be mounted yet.
      for (var waited = 0; this.navigator == null && waited < 10000; waited += 50) {
        await Future<void>.delayed(const Duration(milliseconds: 50));
      }
      final navigator = this.navigator;
      if (navigator == null) throw StateError('No navigator: add LynkeusAgent.navigatorObserver to navigatorObservers');
      // A route already on the stack is gone back to, as React Navigation's navigate does: pushing it again would
      // build a second copy (and break a page that holds a GlobalKey), and a crawl returning to a screen would grow
      // the stack without end.
      if (names.contains(name)) {
        navigator.popUntil((route) => nameOf(route) == name);
        return;
      }
      try {
        unawaited(navigator.pushNamed(name, arguments: params));
      } on FlutterError {
        throw StateError(
          'The app has no route named $name${_unnamed.contains(name) ? ': it is a page pushed without a name, '
                    'reached by pressing what opens it' : ''}',
        );
      }
    },
  );

  @override
  void didPush(Route<dynamic> route, Route<dynamic>? previousRoute) {
    _stack.add(route);
    notifyListeners();
    // A page with no name is known by its widget only once a frame has built it.
    if (route.settings.name == null && route is PageRoute) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!_stack.contains(route)) return;
        if (nameOf(route) case final String name) _unnamed.add(name);
        notifyListeners();
      });
    }
  }

  @override
  void didPop(Route<dynamic> route, Route<dynamic>? previousRoute) {
    _stack.remove(route);
    notifyListeners();
  }

  @override
  void didRemove(Route<dynamic> route, Route<dynamic>? previousRoute) {
    _stack.remove(route);
    notifyListeners();
  }

  @override
  void didReplace({Route<dynamic>? newRoute, Route<dynamic>? oldRoute}) {
    final at = oldRoute == null ? -1 : _stack.indexOf(oldRoute);
    if (newRoute != null) {
      if (at < 0) {
        _stack.add(newRoute);
      } else {
        _stack[at] = newRoute;
      }
    } else if (at >= 0) {
      _stack.removeAt(at);
    }
    notifyListeners();
  }
}

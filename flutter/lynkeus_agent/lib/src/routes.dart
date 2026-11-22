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
/// root navigator). Routes without a name (a dialog, a page pushed with no settings) are on screen but not reported:
/// the route stays the last named one under them.
class LynkeusNavigatorObserver extends NavigatorObserver with ChangeNotifier {
  final _stack = <Route<dynamic>>[];

  List<String> get names => [
    for (final route in _stack)
      if (route.settings.name case final String name) name,
  ];

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
      unawaited(navigator.pushNamed(name, arguments: params));
    },
  );

  @override
  void didPush(Route<dynamic> route, Route<dynamic>? previousRoute) {
    _stack.add(route);
    notifyListeners();
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

import 'dart:async';

import 'package:flutter/scheduler.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

import 'touch.dart' show fromPlatform;

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

/// The routes of an app on Flutter's [Router] (`MaterialApp.router`: go_router, auto_route, a delegate of its own),
/// read from the Router itself, so the app wires nothing. The route is the router's: go_router's state (its `name`,
/// else its `fullPath`, as `lynkeus map` names it) when the delegate has one, else the location's path. A page pushed
/// over the router's pages with no name (`Navigator.push(MaterialPageRoute(...))`) goes by the class of the widget it
/// shows, as with [LynkeusNavigatorObserver]. `navigate` delivers a path as the engine delivers a deep link.
class RouterRoutes with ChangeNotifier {
  Element? _router;
  String? _last;
  var _watching = false;

  /// The app's root Router, if it has one: the first below the root, never inside a Navigator (a nested router
  /// belongs to a page).
  Router<Object?>? get router {
    final known = _router;
    if (known != null && known.mounted && known.widget is Router) return known.widget as Router<Object?>;
    // A Navigator observer tells of a push while the tree builds, when its children cannot be visited.
    if (_building) return null;
    _router = null;
    final root = WidgetsBinding.instance.rootElement;
    if (root == null) return null;
    void look(Element e) {
      if (_router != null || e.widget is Navigator) return;
      if (e.widget is Router) {
        _router = e;
        return;
      }
      e.visitChildElements(look);
    }

    look(root);
    return _router?.widget as Router<Object?>?;
  }

  /// The router's own route: go_router's `state.name` or `state.fullPath`, else the location's path.
  String? _routed(Router<Object?> router) {
    try {
      // The agent depends on no router package: a delegate with go_router's `state` is read by those names.
      final Object? state = (router.routerDelegate as dynamic).state;
      final Object? name = (state as dynamic).name;
      if (name is String && name.isNotEmpty) return name;
      final Object? fullPath = (state as dynamic).fullPath;
      if (fullPath is String && fullPath.isNotEmpty) return fullPath;
    } on Object {
      // Not go_router, or a go_router with no match yet.
    }
    final uri = router.routeInformationProvider?.value.uri;
    if (uri == null) return null;
    return uri.path.isEmpty ? '/' : uri.path;
  }

  NavigatorState? get _navigator {
    final at = _router;
    if (at == null) return null;
    NavigatorState? found;
    void look(Element e) {
      if (found != null) return;
      if (e is StatefulElement && e.state is NavigatorState) {
        found = e.state as NavigatorState;
        return;
      }
      e.visitChildElements(look);
    }

    look(at);
    return found;
  }

  /// The pages on the router's navigator pushed with no Page behind them, bottom first.
  List<Route<dynamic>> get _pageless {
    final overlay = _navigator?.overlay;
    if (overlay == null || !overlay.mounted) return const [];
    Element? theater;
    (overlay.context as Element).visitChildElements((c) => theater ??= c);
    if (theater == null) return const [];
    final routes = <Route<dynamic>>[];
    theater!.debugVisitOnstageChildren((entry) {
      final route = _routeOf(entry);
      // A page sliding out after a pop is still drawn, and no longer the app's route.
      if (route is PageRoute && route.opaque && route.isActive && !routes.contains(route)) routes.add(route);
    });
    final lastPage = routes.lastIndexWhere((r) => r.settings is Page);
    return routes.sublist(lastPage + 1);
  }

  /// The route an overlay entry belongs to: the framework's private `_ModalScope` holds it, under the entry's ticker
  /// mode, its theater marker and the route's semantics.
  static Route<dynamic>? _routeOf(Element entry) {
    Element? at = entry;
    for (var depth = 0; at != null && depth < 8; depth++) {
      if (at.widget.runtimeType.toString().startsWith('_ModalScope<')) {
        final Object? route = (at.widget as dynamic).route;
        return route is Route ? route : null;
      }
      Element? child;
      at.visitChildElements((c) => child ??= c);
      at = child;
    }
    return null;
  }

  static bool get _building => WidgetsBinding.instance.buildOwner?.debugBuilding ?? false;

  List<String> _names = const [];

  List<String> get names {
    if (_building) return _names;
    final router = this.router;
    if (router == null) return const [];
    return _names = [
      ?_routed(router),
      for (final route in _pageless)
        if (LynkeusNavigatorObserver.nameOf(route) case final String name) name,
    ];
  }

  String? get current {
    final all = names;
    return all.isEmpty ? null : all.last;
  }

  // A pageless push tells the router nothing, so the route is compared after each frame, once someone listens.
  @override
  void addListener(VoidCallback listener) {
    super.addListener(listener);
    if (_watching) return;
    _watching = true;
    SchedulerBinding.instance.addPersistentFrameCallback((_) {
      if (!hasListeners) return;
      final now = current;
      if (now == _last) return;
      _last = now;
      notifyListeners();
    });
  }

  late final LynkeusRoutes routes = LynkeusRoutes(
    current: () => current,
    path: () => names,
    changes: this,
    navigate: (name, params) async {
      final router = this.router;
      if (router == null) throw StateError('No router: the app has no MaterialApp.router or Router');
      final pageless = _pageless;
      final named = [for (final route in pageless) LynkeusNavigatorObserver.nameOf(route)];
      final navigator = _navigator;
      // Back to a page already open, as React Navigation's navigate does, rather than a second copy.
      if (navigator != null && named.contains(name)) {
        navigator.popUntil((route) => LynkeusNavigatorObserver.nameOf(route) == name);
        return;
      }
      if (navigator != null && pageless.isNotEmpty && _routed(router) == name) {
        navigator.popUntil((route) => route.settings is Page);
        return;
      }
      if (!name.startsWith('/')) {
        throw StateError(
          'The router reports $name, which is not a path: a page pushed without a name is reached by pressing what '
          'opens it, and a named route needs LynkeusRoutes with the router\'s own navigate (goNamed)',
        );
      }
      if (router.routeInformationProvider == null) {
        throw StateError('The app\'s Router has no routeInformationProvider, so it cannot be sent to $name');
      }
      await fromPlatform('flutter/navigation', MethodCall('pushRouteInformation', {'location': name, 'state': null}));
    },
  );
}

/// What the agent reports when the app gives no routes of its own: the app's [Router] when it has one, else the
/// Navigator the observer was given to.
LynkeusRoutes defaultRoutes(LynkeusNavigatorObserver observer, RouterRoutes router) {
  LynkeusRoutes pick() => router.router != null ? router.routes : observer.routes;
  return LynkeusRoutes(
    current: () => pick().current(),
    path: () {
      final routes = pick();
      return routes.path?.call() ?? [?routes.current()];
    },
    changes: Listenable.merge([observer, router]),
    navigate: (name, params) => pick().navigate!(name, params),
  );
}

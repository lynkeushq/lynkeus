import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DartProject } from '../dart/project.js';
import { literalOf, tokenize } from '../dart/lexer.js';
import { readFlutterProject } from '../extractFlutter.js';
import { screensAffectedBy } from '../query.js';
import { flutterRouteParams } from '../route-params.js';

const read = (sources: Record<string, string>) =>
  readFlutterProject(
    new DartProject(
      '/app',
      'app',
      Object.entries(sources).map(([rel, text]) => ({ rel, text })),
    ),
  );

const routes = (graph: ReturnType<typeof read>) =>
  Object.fromEntries(
    Object.values(graph.screens).map((s) => [s.route, [s.component, s.file, ...(s.params ? [s.params.join(',')] : []), ...(s.unnamed ? ['unnamed'] : [])]]),
  );

const edges = (graph: ReturnType<typeof read>, file: string) =>
  graph.files[file]!.navigates.map((e) => `${e.to} ${e.confidence}${e.via.kind === 'testId' ? ` #${e.via.testId} ${e.linkage}` : ''}`);

const pages = `
import 'package:flutter/material.dart';
class HomePage extends StatelessWidget { const HomePage({super.key}); @override Widget build(BuildContext context) => const Text('home'); }
class DetailPage extends StatelessWidget { const DetailPage({super.key, required this.id}); final String id; @override Widget build(BuildContext context) => Text(id); }
class SettingsPage extends StatefulWidget { const SettingsPage({super.key}); @override State<SettingsPage> createState() => _S(); }
class _S extends State<SettingsPage> { @override Widget build(BuildContext context) => const Text('s'); }
class AboutPage extends StatelessWidget { const AboutPage({super.key}); @override Widget build(BuildContext context) => const Text('a'); }
class Shell extends StatelessWidget { const Shell({super.key, required this.child}); final Widget child; @override Widget build(BuildContext context) => child; }
`;

test('the lexer reads interpolation, raw strings and nested comments', () => {
  const tokens = tokenize(`/* a /* nested */ comment */ final a = r'\${x}'; final b = 'p/\${id}/q' "x"; final c = '''multi
line''';`);
  const strings = tokens.filter((t) => t.kind === 'string');
  assert.equal(literalOf(strings[0]), `\${x}`);
  assert.deepEqual(strings[1]!.parts, [{ text: 'p/' }, { expr: 'id' }, { text: '/q' }]);
  assert.equal(literalOf(strings[3]), 'multi\nline');
  assert.equal(tokens[0]!.text, 'final');
});

test('go_router: nested routes, names, params, shell routes, redirects and builders', () => {
  const graph = read({
    'lib/pages.dart': pages,
    'lib/router.dart': `
import 'package:go_router/go_router.dart';
import 'pages.dart';
abstract final class Paths { static const home = '/'; static const settings = '/settings'; }
final router = GoRouter(
  redirect: (context, state) => null,
  routes: [
    GoRoute(path: '/old', redirect: (_, __) => '/'),
    ShellRoute(
      builder: (context, state, child) => Shell(child: child),
      routes: [
        GoRoute(
          path: Paths.home,
          builder: (context, state) => const HomePage(),
          routes: [
            GoRoute(name: 'detail', path: 'detail/:id', builder: (context, state) => DetailPage(id: state.pathParameters['id']!)),
          ],
        ),
      ],
    ),
    StatefulShellRoute.indexedStack(
      builder: (context, state, shell) => Shell(child: shell),
      branches: [
        StatefulShellBranch(routes: [
          GoRoute(path: Paths.settings, pageBuilder: (context, state) => const MaterialPage(child: SettingsPage()), routes: [
            GoRoute(path: 'about', builder: (_, __) => const AboutPage()),
          ]),
        ]),
      ],
    ),
    GoRoute(path: '/broken', builder: (context, state) => makePage(state)),
  ],
);`,
  });
  assert.deepEqual(routes(graph), {
    '/': ['HomePage', 'lib/pages.dart'],
    detail: ['DetailPage', 'lib/pages.dart', 'id'],
    '/settings': ['SettingsPage', 'lib/pages.dart'],
    '/settings/about': ['AboutPage', 'lib/pages.dart'],
    '/broken': ['makePage(state)', null],
  });
  assert.ok(graph.warnings.some((w) => w.startsWith('lib/router.dart:8: route "/old" only redirects')));
  assert.ok(graph.warnings.some((w) => /route "\/broken": the builder .* names no widget of the app/.test(w)));
});

test('go_router: a route built in a helper is read once per call, with its enum name and switch path', () => {
  const graph = read({
    'lib/pages.dart': pages,
    'lib/router.dart': `
import 'package:go_router/go_router.dart';
import 'pages.dart';
enum AppRoute { home('home'), detail('detail'); const AppRoute(this.name); final String name; }
String _pathFor(AppRoute route) => switch (route) { AppRoute.home => '/', AppRoute.detail => '/detail/:id' };
class Builder2 {
  final List<RouteBase> routes = [];
  void _add(AppRoute route, GoRouterWidgetBuilder builder) {
    routes.add(GoRoute(path: _pathFor(route), name: route.name, pageBuilder: _page(builder)));
  }
  void addHome({required GoRouterWidgetBuilder builder}) => _add(AppRoute.home, builder);
  void addDetail({required GoRouterWidgetBuilder builder}) => _add(AppRoute.detail, builder);
}
GoRouterPageBuilder _page(GoRouterWidgetBuilder builder) => (context, state) => MaterialPage(child: builder(context, state));
`,
    'lib/main.dart': `
import 'router.dart';
import 'pages.dart';
void main() {
  Builder2()
    ..addHome(builder: (_, __) => const HomePage())
    ..addDetail(builder: (_, state) => DetailPage(id: state.pathParameters['id']!));
}`,
  });
  assert.deepEqual(routes(graph), { home: ['HomePage', 'lib/pages.dart'], detail: ['DetailPage', 'lib/pages.dart', 'id'] });
  assert.deepEqual(graph.warnings, []);
});

test('go_router: a GoRoute whose path is never a constant is a warning with its line, not a missing route', () => {
  const graph = read({ 'lib/r.dart': "GoRoute make(String p) => GoRoute(path: p, builder: (_, __) => const Text(''));\nfinal r = make(compute());" });
  assert.deepEqual(graph.screens, {});
  assert.match(graph.warnings[0]!, /^lib\/r\.dart:1: GoRoute with path p: neither is a constant/);
});

test('go_router: go, push, goNamed and pushNamed call sites are edges, matched to patterns', () => {
  const graph = read({
    'lib/pages.dart': pages,
    'lib/router.dart': `
final router = GoRouter(routes: [
  GoRoute(path: '/', builder: (_, __) => const HomePage(), routes: [
    GoRoute(name: 'detail', path: 'detail/:id', builder: (_, __) => const DetailPage(id: '')),
    GoRoute(path: 'settings', builder: (_, __) => const SettingsPage()),
  ]),
]);`,
    'lib/home.dart': `
class HomeBody extends StatelessWidget {
  void _openSettings(BuildContext context) => context.push('/settings?tab=2');
  @override
  Widget build(BuildContext context) => Column(children: [
    TextButton(key: const ValueKey('open-detail'), onPressed: () => context.go('/detail/\${item.id}'), child: const Text('x')),
    TextButton(key: const Key('settings'), onPressed: () => _openSettings(context), child: const Text('s')),
    TextButton(onPressed: () => context.goNamed('detail', pathParameters: {'id': '1'}), child: const Text('d')),
    TextButton(onPressed: () => GoRouter.of(context).pushNamed(name), child: const Text('d')),
  ]);
}`,
  });
  assert.deepEqual(edges(graph, 'lib/home.dart'), [
    '/settings static #settings handler',
    'detail static #open-detail element',
    'detail static',
    'name dynamic',
  ]);
  assert.deepEqual(
    graph.files['lib/home.dart']!.selectors.map((s) => s.id),
    ['open-detail', 'settings'],
  );
});

test('TypedGoRoute: the route class builds the screen, and `Route().go(context)` is an edge', () => {
  const graph = read({
    'lib/pages.dart': pages,
    'lib/routes.dart': `
@TypedGoRoute<HomeRoute>(path: '/', routes: [TypedGoRoute<DetailRoute>(path: 'detail/:id')])
class HomeRoute extends GoRouteData { const HomeRoute(); @override Widget build(BuildContext context, GoRouterState state) => const HomePage(); }
class DetailRoute extends GoRouteData { const DetailRoute({required this.id}); final String id; @override Widget build(BuildContext context, GoRouterState state) => DetailPage(id: id); }
void open(BuildContext context) => DetailRoute(id: '1').push(context);`,
  });
  assert.deepEqual(routes(graph), { '/': ['HomePage', 'lib/pages.dart'], '/detail/:id': ['DetailPage', 'lib/pages.dart', 'id'] });
  assert.deepEqual(edges(graph, 'lib/routes.dart'), ['/detail/:id static']);
});

test('Navigator: routes map, home, onGenerateRoute (switch and if) and named pushes', () => {
  const graph = read({
    'lib/pages.dart': pages,
    'lib/main.dart': `
import 'pages.dart';
class Routes { static const settings = '/settings'; static const about = '/about'; }
final table = <String, WidgetBuilder>{ Routes.settings: (context) => const SettingsPage() };
class App extends StatelessWidget {
  @override
  Widget build(BuildContext context) => MaterialApp(
    home: const HomePage(),
    routes: {...table, '/detail': (_) => DetailPage(id: ModalRoute.of(context)!.settings.arguments as String)},
    onGenerateRoute: generate,
  );
}
Route<dynamic>? generate(RouteSettings settings) {
  switch (settings.name) {
    case Routes.about:
    case '/info':
      return MaterialPageRoute(builder: (_) => const AboutPage(), settings: settings);
  }
  if (settings.name == '/shell') return MaterialPageRoute(builder: (_) => Shell(child: const HomePage()));
  return null;
}
void go(BuildContext context) {
  Navigator.pushNamed(context, Routes.settings);
  Navigator.of(context).pushReplacementNamed('/about');
  Navigator.of(context).push(MaterialPageRoute(builder: (_) => const AboutPage(), settings: const RouteSettings(name: '/about-named')));
}`,
  });
  assert.deepEqual(routes(graph), {
    '/settings': ['SettingsPage', 'lib/pages.dart'],
    '/detail': ['DetailPage', 'lib/pages.dart', 'arguments'],
    '/': ['HomePage', 'lib/pages.dart'],
    '/about': ['AboutPage', 'lib/pages.dart'],
    '/info': ['AboutPage', 'lib/pages.dart'],
    '/shell': ['HomePage', 'lib/pages.dart'],
    '/about-named': ['AboutPage', 'lib/pages.dart'],
  });
  assert.deepEqual(edges(graph, 'lib/main.dart'), ['/settings static', '/about static', '/about-named static']);
});

test('Navigator.push of a widget is an edge to a screen named after its class, with the key that opens it', () => {
  const graph = read({
    'lib/pages.dart': pages,
    'lib/main.dart': `
import 'pages.dart';
class Home extends StatelessWidget {
  Future<void> _openAbout(BuildContext context) async {
    await Navigator.of(context).push<void>(MaterialPageRoute(builder: (_) => const AboutPage()));
  }
  @override
  Widget build(BuildContext context) => Column(children: [
    OutlinedButton(key: const ValueKey('about'), onPressed: () => _openAbout(context), child: const Text('About')),
    ListTile(key: ValueKey('row-$i'), onTap: () => Navigator.push(context, CupertinoPageRoute(builder: (_) => SettingsPage()))),
    TextButton(onPressed: () => Navigator.push(context, route), child: const Text('?')),
  ]);
}`,
  });
  assert.deepEqual(routes(graph), { AboutPage: ['AboutPage', 'lib/pages.dart', 'unnamed'], SettingsPage: ['SettingsPage', 'lib/pages.dart', 'unnamed'] });
  const navigates = graph.files['lib/main.dart']!.navigates;
  assert.deepEqual(edges(graph, 'lib/main.dart'), ['AboutPage static #about handler', 'SettingsPage static', 'route dynamic']);
  assert.deepEqual(navigates[1]!.via, { kind: 'dynamicTestId', expression: "'row-$i'" });
});

test("a router of the app's own: calls that register a path with a builder are routes, and pushes of those paths edges", () => {
  const graph = read({
    'lib/pages.dart': pages,
    'lib/routers.dart': `
class Routes {
  static String home = '/home';
  static final FluroRouter router = FluroRouter();
  static void init() {
    router.define(home, handler: Handler(handlerFunc: (BuildContext? context, Map<String, List<String>> params) => const HomePage()));
  }
}
class SettingRouter implements IRouterProvider {
  static String settingPage = '/setting';
  @override
  void initRouter(FluroRouter router) {
    router.define(settingPage, handler: Handler(handlerFunc: (_, __) => const SettingsPage()));
  }
}`,
    'lib/main.dart': `
class App extends StatelessWidget {
  @override
  Widget build(BuildContext context) => MaterialApp(onGenerateRoute: Routes.router.generator);
  void open(BuildContext context) {
    NavigatorUtils.push(context, '\${SettingRouter.settingPage}?from=\${source}');
    NavigatorUtils.goBackWithParams(context, 'x');
  }
}`,
  });
  assert.deepEqual(routes(graph), { '/home': ['HomePage', 'lib/pages.dart'], '/setting': ['SettingsPage', 'lib/pages.dart'] });
  assert.deepEqual(edges(graph, 'lib/main.dart'), ['/setting static']);
  assert.ok(graph.warnings.some((w) => w.startsWith('lib/main.dart:4: onGenerateRoute: Routes.router.generator is not a function of the app')));
  assert.ok(graph.warnings.includes("2 route(s) read from calls that register a path with a builder (a router of the app's own)"));
});

test('imports: package and relative URIs, a barrel resolved to the files whose names are used, parts', () => {
  const graph = read({
    'lib/widgets/button.dart': 'class AppButton extends StatelessWidget {}',
    'lib/widgets/card.dart': 'class AppCard extends StatelessWidget {}',
    'lib/widgets/widgets.dart': "export 'button.dart';\nexport 'card.dart';",
    'lib/screen.dart':
      "import 'package:app/widgets/widgets.dart';\nimport 'package:flutter/material.dart';\nimport 'util.dart';\npart 'screen.g.dart';\nfinal b = AppButton();",
    'lib/screen.g.dart': "part of 'screen.dart';",
    'lib/util.dart': '',
  });
  assert.deepEqual(graph.files['lib/screen.dart'], {
    selectors: [],
    navigates: [],
    imports: ['lib/widgets/button.dart', 'lib/util.dart', 'lib/screen.g.dart'],
    barrels: ['lib/widgets/widgets.dart'],
  });
  assert.deepEqual(graph.files['lib/screen.g.dart']!.imports, ['lib/screen.dart']);
});

test('case impact on a Flutter graph: a changed widget reaches the screens that import it, nearest first', () => {
  const graph = read({
    'lib/widgets/row.dart': 'class Row2 extends StatelessWidget {}',
    'lib/settings.dart': "import 'widgets/row.dart';\nclass SettingsPage extends StatelessWidget {}",
    'lib/home.dart': "import 'settings.dart';\nclass HomePage extends StatelessWidget {}",
    'lib/main.dart':
      "import 'home.dart';\nimport 'settings.dart';\nfinal app = MaterialApp(home: const HomePage(), routes: {'/settings': (_) => const SettingsPage()});",
  });
  const affected = screensAffectedBy({ app: 'app', root: '/app', extractedAt: '', ...graph }, ['lib/widgets/row.dart']);
  assert.deepEqual(
    affected.map((a) => [a.route, a.distance]),
    [
      ['/settings', 1],
      ['/', 2],
    ],
  );
});

test("smoke opens a Flutter app's routes that need nothing: not go_router params, not a required extra, not an unnamed page", () => {
  const graph = read({
    'lib/pages.dart': pages,
    'lib/router.dart': `
final router = GoRouter(routes: [
  GoRoute(path: '/', builder: (_, __) => const HomePage()),
  GoRoute(path: '/detail/:id', builder: (_, __) => const DetailPage(id: '')),
  GoRoute(path: '/settings', builder: (_, state) => SettingsPage(user: state.extra! as User)),
  GoRoute(path: '/about', builder: (_, state) => AboutPage(user: state.extra as User?)),
]);
void open(BuildContext context) => Navigator.push(context, MaterialPageRoute(builder: (_) => const Shell(child: null)));`,
  });
  assert.deepEqual(
    flutterRouteParams({ app: 'app', root: '/app', extractedAt: '', ...graph }).map((p) => [p.route, p.free]),
    [
      ['/', true],
      ['/detail/:id', false],
      ['/settings', false],
      ['/about', true],
      ['Shell', false],
    ],
  );
});

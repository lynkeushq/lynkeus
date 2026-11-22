# lynkeus_agent

The Lynkeus agent for Flutter apps. Started from `main()` in a debug build, it dials the Lynkeus driver (the CLI, the MCP
server, the case runner), proves the project's token with HMAC-SHA256 without sending it, and answers the
[protocol](../../docs/PROTOCOL.md) from the live widget tree. Release builds leave it out.

```dart
void main() {
  LynkeusAgent.start(); // token from --dart-define=LYNKEUS_TOKEN=...
  runApp(const MyApp());
}
```

What it reads, and from where:

- Elements come from the onstage element tree: routes under an opaque one, `Offstage` subtrees and the rows a lazy
  list keeps built past its viewport are left out. Frames are the render objects' bounds in logical points.
- A test id is a `ValueKey<String>` (`Key('...')`) or a `Semantics(identifier: ...)`, given to the element it names.
- Kinds come from the widgets layer and from what controls tell assistive technology (`Semantics(button: true)`, a
  toggle, a text field's value length, a `GestureDetector` with a tap handler), so the SDK's Material and Cupertino and
  the `material_ui` and `cupertino_ui` packages read the same.
- `covered` is Flutter's own hit test at the element's center; `hidden: behind-modal` is everything under the topmost
  modal route's barrier; `inert` is under an `IgnorePointer` or `AbsorbPointer`.

## Routes

`route`, `path`, `navigation` events and `navigate` need to know the app's routes. With a `Navigator` and named
routes, give it the agent's observer (on the root navigator):

```dart
MaterialApp(navigatorObservers: [LynkeusAgent.navigatorObserver], routes: {...});
```

An app on a router describes its routes from the router's own state; the agent depends on no router package. With
go_router:

```dart
final router = GoRouter(routes: [...]);

void main() {
  LynkeusAgent.start(
    routes: LynkeusRoutes(
      current: () => router.state.name ?? router.state.matchedLocation,
      changes: router.routerDelegate,
      navigate: (name, params) => router.goNamed(
        name,
        pathParameters: {for (final e in (params ?? const {}).entries) e.key: '${e.value}'},
      ),
    ),
  );
  runApp(MaterialApp.router(routerConfig: router));
}
```

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
- Requests made through dart:io's `HttpClient` (package:http's `IOClient`, dio's default adapter) are wrapped through
  `HttpOverrides.global`: recorded for `requests` and `trace` with secrets redacted by the same rules as the React
  Native agent, counted in flight for `idle`, and answered, held or lost by the driver's `netmock` rules.

## Captured frames

Start the agent before anything calls `WidgetsFlutterBinding.ensureInitialized()`: it then makes the app's binding, a
`WidgetsFlutterBinding` that also makes a step's frame a function of the app's code, the case's steps and the data,
not of the wall clock, so two runs on a device and a run on Lynkeus FastSim give the same picture.

- `idle` is not quiet while work that ends on its own is under way, and the frame is of the state it ends in: a
  one-shot timer the app set for no longer than the idle's `timeoutMs` (a page that loads after 2 s, a toast that
  hides after 2 s, a search's debounce), or one its launch set before the driver's first action (a splash screen's);
  an animation such work sets off when it ends (a toast fading out, a pull-to-refresh indicator leaving; one the
  step itself starts, a page sliding in, ends within the settle's quiet); an image still loading or
  decoding (an asset's icon); a request the app made since the last answer. Which timers count is decided by how long the app set them for, the same on every side, not
  by how much is left of them. A periodic timer, a timer set again from where one just fired (a polling loop) and a
  timer set for longer than the wait never count.
- When `idle` answers with something on screen that animates forever (an `AnimationController.repeat`, such as a
  progress indicator, a controller its own status listener starts again, or a text field's blinking caret), the agent
  draws one more frame with each of those at the moment it started and the caret on, and draws nothing else until
  the driver's next request other than a screenshot (a `screen` read included, so a wait that polls it sees the app
  move on, and a frame is drawn before the request acts), at most 3 s, so a screenshot the OS takes a moment later is the same on every run.

A case run with frames takes a Flutter step's `app.see` steps before its frame's settle: a toast the step shows is
still there to be seen, and the frame after it is of the screen once the toast is gone.

An app with a binding class of its own (one that overrides `handlePointerEvent`, say) extends `LynkeusBinding`
instead of `WidgetsFlutterBinding` and makes it before calling `LynkeusAgent.start()`, which then uses it:

```dart
class MyBinding extends LynkeusBinding {
  // the app's own overrides
}

void main() {
  MyBinding();
  LynkeusAgent.start();
  runApp(const MyApp());
}
```

Made after `LynkeusAgent.start()`, a second binding fails Flutter's own check (`Binding is already initialized to
LynkeusBinding`). An app whose binding is a plain one of its own is still driven, without the frames above, the safe
area and plugin stand-ins on FastSim, and the console says so and how to fix it.

## Routes

`route`, `path`, `navigation` events and `navigate` need to know the app's routes. With a `Navigator` and named
routes, give it the agent's observer (on the root navigator):

```dart
MaterialApp(navigatorObservers: [LynkeusAgent.navigatorObserver], routes: {...});
```

A page pushed without a name is reported by the class of the widget it shows (what `lynkeus map` calls it); a dialog
or sheet is not reported. `navigate` to a route already on the stack pops back to it.

An app on a router describes its routes from the router's own state; the agent depends on no router package. With
go_router:

```dart
final router = GoRouter(routes: [...]);

void main() {
  LynkeusAgent.start(
    routes: LynkeusRoutes(
      current: () => router.state.name ?? router.state.fullPath,
      changes: router.routerDelegate,
      navigate: (route, params) => route.startsWith('/')
          ? router.go(route)
          : router.goNamed(
              route,
              pathParameters: {for (final e in (params ?? const {}).entries) e.key: '${e.value}'},
            ),
    ),
  );
  runApp(MaterialApp.router(routerConfig: router));
}
```

## Lynkeus FastSim

Inside the FastSim host (the app's own debug kernel run by Flutter's embedder, on a clock the host moves) the agent
wakes on `FASTSIM_HOST`, which only the host sets; on a simulator or a phone none of it runs. There it makes the
app's binding, whose root view carries the device's safe area (the embedder cannot set one), asks the host on
`lynkeus/fastsim` which commands it serves (`clock`, `screenshot`, …) and forwards them, and tells the host when a
driver request is being served and how many of the app's requests are out to a real server, which is what moves
its clock: it runs ahead while the driver waits and nothing is on the wire, and at the wall's pace otherwise. A
request `netmock` answers is not on the wire, so its `delayMs` passes on the host's clock. Images come through
the same `HttpClient`, so `Image.network` fetches count too; the host keeps no cache of its own.

For that, `LynkeusAgent.start()` has to come before the app's first `WidgetsFlutterBinding.ensureInitialized()`,
or the app's own binding has to extend `LynkeusBinding` (see Captured frames). An app that makes a plain binding first
still runs and is driven; it gets no safe area, and says `binding: app` in its hello.

The app has no native side there either, so the agent's binding answers its plugins' channels with the same
stand-ins the headless host uses (`package:lynkeus_agent/hosts.dart`; the table is in lynkeus_headless's README),
and the same `launched`, `biometrics`, `permissions` and `network` commands drive them. A plugin whose platform
implementation calls native code through FFI instead of a channel (shared_preferences_foundation 2.6 on iOS) is
out of their reach.

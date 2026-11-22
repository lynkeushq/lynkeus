---
title: Flutter
description: Test a Flutter app with Lynkeus. Setup, running on a Simulator or emulator, how elements are identified, routes, the network log, the headless host, and what does not work yet.
---

Lynkeus drives a Flutter app the way it drives a React Native one: a small agent runs inside a debug build, the CLI connects to it, and every command, case step and report works the same. This page covers what is particular to Flutter. Everything about the case format, `lynkeus screen`, `lynkeus press` and the rest is in [Writing cases](/guides/writing-cases/) and [Driving the app](/guides/driving-the-app/).

There are two Dart packages, in the `flutter/` folder of the Lynkeus repository:

- **`lynkeus_agent`** goes in the app. It dials the driver from a debug build, proves the project's token, and answers from the live widget tree: what the screen shows, real touches through Flutter's gesture system, typing through its text input.
- **`lynkeus_headless`** goes in `dev_dependencies` and hosts the app inside `flutter test`, with no simulator. See [Headless](#headless).

Neither is on pub.dev yet; until they are, declare them with a git or path dependency.

## Set up the app

From the app's folder:

```bash
npx lynkeus init
```

In a folder with a `pubspec.yaml` that depends on `flutter` (`sdk: flutter`), `init` adds `lynkeus_agent` to `dependencies`, imports it in `lib/main.dart`, starts it before `runApp(`, and writes the project's token to `.lynkeus/token`, kept out of git. It changes only what is missing, so it is safe to run again. A folder that is also a React Native app keeps the React Native behavior; pass `--runtime flutter` to choose. `--no-install` leaves `pubspec.yaml` alone. When `main.dart` has no `runApp(` that `init` can recognize, it prints the lines to add instead of guessing.

To do it by hand, add the dependency:

```yaml title="pubspec.yaml"
dependencies:
  lynkeus_agent:
    git:
      url: https://github.com/lynkeushq/lynkeus.git
      path: flutter/lynkeus_agent
```

Start the agent before `runApp`:

```dart title="lib/main.dart"
import 'package:lynkeus_agent/lynkeus_agent.dart';

void main() {
  LynkeusAgent.start();
  runApp(const MyApp());
}
```

The agent reads the token from `--dart-define=LYNKEUS_TOKEN=…`. Without a token it stays off and says so in the console. Make one with `openssl rand -hex 24 > .lynkeus/token` if the project has none, and run the app with it:

```bash
flutter run --dart-define=LYNKEUS_TOKEN=$(cat .lynkeus/token)
```

`LYNKEUS_HOST` and `LYNKEUS_PORT` are also `--dart-define`s. By default the app dials `127.0.0.1:8123`, and on Android it tries `10.0.2.2` and then `127.0.0.1`. Change the port for the CLI too, with `LYNKEUS_PORT` or `port` in `lynkeus.config.json`.

## Run on a Simulator or emulator

`flutter run` with the `--dart-define` above works. To install a build yourself:

```bash
# iOS Simulator
flutter build ios --simulator --debug --dart-define=LYNKEUS_TOKEN=$(cat .lynkeus/token)
xcrun simctl install <device> build/ios/iphonesimulator/Runner.app
xcrun simctl launch <device> <bundle id>

# Android emulator
flutter build apk --debug --dart-define=LYNKEUS_TOKEN=$(cat .lynkeus/token)
adb -s <serial> install -r build/app/outputs/flutter-apk/app-debug.apk
adb -s <serial> shell am start -n <application id>/.MainActivity
```

Then `npx lynkeus screen` should print the app's screen, and `npx lynkeus case run --device <device>` runs cases. The `flutter/sample/` folder has a small app and three cases to try this on.

## How elements are identified

- **A test id** is a `ValueKey<String>` (`Key('increment')`) on a widget, or a `Semantics(identifier: 'increment')`. Target it as `#increment`. The id belongs to the element the widget draws; when the key sits on a wrapper, it is given to the first listed element below it.
- **Text** is what a `Text` widget or a field shows. An exact match on a control wins over the same text in a paragraph, and a fragment of a paragraph is never a target.
- **A label** is a `Semantics(label: …)`, a tooltip, or an icon's `semanticLabel`. It is matched like text and read as the element's `accessibilityLabel`. An icon-only button is named by its icon's label.
- **Kinds** come from the widgets layer and from what controls tell assistive technology: buttons, switches, text fields, images, a `GestureDetector` with a tap handler. The SDK's Material and Cupertino widgets and the `material_ui` and `cupertino_ui` packages read the same.

What is on screen is the onstage element tree: routes under an opaque one, `Offstage` subtrees and the rows a lazy list keeps built past its viewport are left out. Frames are in logical points. `~covered` is Flutter's own hit test at the element's center, `hidden: behind-modal` is everything under the topmost modal route's barrier, and `inert` is under an `IgnorePointer` or `AbsorbPointer`.

A command the case can call is registered in the app:

```dart
LynkeusAgent.register('reset', (_) {
  navigatorKey.currentState?.popUntil((route) => route.isFirst);
  return true;
});
```

and used as `app.call: { command: reset }`, or `lynkeus call reset`.

## Write cases

Cases are the same files as for React Native. This one is `flutter/sample/cases/resend-code.md`:

```markdown
---
id: flutter-resend-code
title: "Counter and resend countdown in a Flutter app"
---
steps:
  - app.call: { command: reset }
  - app.press: "#increment"
  - app.see: { text: "Count: 1" }
  - app.type: { target: "#name", text: "Ana" }
  - app.press: "#send"
  - app.see: { text: "Code sent to Ana" }
  - app.wait: { target: "Resend now", timeoutMs: 6000 }
```

Route names often start with a slash in Flutter (`/settings`), and a lowercase word alone is read as a text, so name a route with the `route:` prefix: `app.wait: "route:/settings"`. See [Writing cases](/guides/writing-cases/) for how a target is read.

## Routes

`route`, `path`, `navigation` events and `navigate` need to know the app's routes. With a `Navigator` and named routes, give the agent's observer to the root navigator:

```dart
MaterialApp(navigatorObservers: [LynkeusAgent.navigatorObserver], routes: {...});
```

Routes with no name (a dialog, a page pushed with no settings) are on screen but not reported: the route stays the last named one under them.

An app on a router describes its routes from the router's own state; the agent depends on no router package. With go_router:

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

`current` says which route is focused, `changes` fires when it may have changed, and `navigate` is what `lynkeus nav` calls. Another router is wired the same way from its own state.

## The network log and mocks

Requests made through dart:io's `HttpClient` are recorded: `package:http`'s `IOClient` and dio's default adapter both go through it. `lynkeus requests` and `lynkeus trace` list them with the same redaction rules as the React Native agent, `idle` waits for the ones in flight, and `lynkeus mock` answers, holds or drops requests by rule, so [fixtures](/guides/fixtures/) and `app.mock` steps work as they do in React Native. A client that does not use `HttpClient` (a platform channel's own networking, a webview) is not seen.

## Headless

The headless host runs the app's own `main()` inside `flutter test`: real layout and software paint, with no simulator and no native build. The app's agent dials the driver as it does on a device, so every command works unchanged.

Add the package:

```yaml title="pubspec.yaml"
dev_dependencies:
  lynkeus_headless:
    git:
      url: https://github.com/lynkeushq/lynkeus.git
      path: flutter/lynkeus_headless
```

Then, with the token from `lynkeus init`:

```bash
npx lynkeus case run --host        # starts the host for the run and stops it after
npx lynkeus headless start         # or keep one running for lynkeus screen, press, …
```

The CLI finds Flutter through `FLUTTER_ROOT`, then `flutter` on `PATH`, then `mise which flutter`; with none of them it stops and says so. It writes the host file to `.lynkeus/host/`, not to `test/`, because a host never ends and the app's own `flutter test` would pick it up and hang. `--entry` names a `main` other than `lib/main.dart`.

**Time is virtual.** The app runs in flutter_test's fake time. While the driver waits on the app and no request of the app is out, the clock moves a whole frame per turn, so a three second countdown passes in a few hundred milliseconds. Otherwise it keeps the wall's pace, so a real backend's latency stays real. `lynkeus os clock` drives it by hand: `--advance <ms>` runs every frame and timer inside those milliseconds, `--settle` pumps frames without moving time, `--now` and `--reset` move what the app's clock answers. The app's clock is `package:clock`, which flutter_test fakes.

**The screen** is an iPhone-sized iOS device (402x874 points at 3x). Change it in `lynkeus.config.json`:

```json title="lynkeus.config.json"
{ "flutterHost": { "platform": "android", "window": "412x915@2.625", "networkHosts": ["127.0.0.1", "api.local"] } }
```

`networkHosts` fences the real network: the host replaces flutter_test's blanket 400 with the real `HttpClient`, but only loopback and `10.0.2.2` are reachable by default, and a request to any other host fails as a socket error. `lynkeus screenshot` writes the screen as a PNG at the device's pixel size, with the app's fonts, Roboto and the Material icons loaded so text is legible.

`case run --host` passes `--locale`, `--time-zone` and `--epoch` on to the host. The host also adds `appstate`, `deeplink`, `memory` and `exit` commands (`lynkeus os appstate`, `lynkeus os deeplink`).

### Plugins

flutter_test leaves platform channels unanswered, so a plugin's method channel throws. The host answers every channel. These plugins have in-memory stand-ins:

| Plugin | Stand-in | Driven by |
|---|---|---|
| `shared_preferences`, `flutter_secure_storage` | a key-value map | the app |
| `path_provider` | folders under a temporary folder per run | |
| `device_info_plus`, `package_info_plus` | an iPhone on iOS, or an Android emulator, as the host plays | |
| `url_launcher` | says it can open a URL, opens nothing, writes it down | `lynkeus call launched` (`{ "clear": true }` empties it) |
| `local_auth` | a sensor with Face ID enrolled; prompts succeed | `lynkeus os biometrics --available none\|face --next success\|fail\|cancel` |
| `permission_handler` | every permission granted | `lynkeus call permissions '{"7": 4}'` |
| `connectivity_plus` | Wi-Fi | `lynkeus call network '{"state": "off"}'` |

Any other channel gets an empty success, so the app's `await` never hangs, and one `[stub] <channel>` line in the host's log. Set `LYNKEUS_CHANNELS=trace` in the host's environment to print every call and its answer.

A project adds its own in `test/lynkeus_host.dart`, which is not a `_test.dart` file so its unit tests leave it alone; `lynkeus headless start` passes it on when it exists:

```dart title="test/lynkeus_host.dart"
import 'package:lynkeus_headless/lynkeus_headless.dart';

void configureHost(HostConfig host) {
  host.standIns.add('com.example/wallet', (method, args) => method == 'balance' ? 1250 : null);
  host.plugins.preferences['flutter.onboarded'] = true;
}
```

A case can branch on where it runs with `on: headless`, as `flutter/sample/cases/settings.md` does for the help link.

## Limits today

- **Debug builds only.** A release build carries no agent. See [Security](/security/).
- **Headless sees the machine.** `Platform` answers for the machine running the host, and `DateTime.now()` reads the real wall clock; only `package:clock` is virtual. A screen that computes a countdown from `DateTime.now()` sees real seconds.
- **`--seed` has no effect** on the headless host: Dart's `Random()` cannot be seeded from outside. `--locale`, `--time-zone` and `--epoch` are applied.
- **`--host-heap` restarts are skipped.** The Dart VM gives a running program no heap figures.
- **`lynkeus map`, `case impact`, `smoke` and `crawl` do not work for Flutter yet.** They read React Navigation sources.
- **`lynkeus status` checks React Native setup** and asks for a `package.json`, so its answer is not meaningful in a Flutter project.
- **Lynkeus FastSim is not available for Flutter yet.** Use the headless host or a Simulator or emulator.
- **Only dart:io's `HttpClient` is observed** for the network log and mocks.
- **Two apps cannot dial the same port.** If another app (or a host from another project) is already paired with the driver, close it, or give one of them its own port with `LYNKEUS_PORT`.

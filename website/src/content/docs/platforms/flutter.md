---
title: Flutter
description: What is specific to running Lynkeus in a Flutter app. The Dart agent, the token, how elements are identified, routes, the headless host on flutter test, and known limits.
---

This page collects what is particular to Flutter. Cases, the CLI, reports and the MCP server are the same as for React Native: read [Writing cases](/guides/writing-cases/) and [Driving the app](/guides/driving-the-app/) for those, and [Android](/platforms/android/) and [iOS](/platforms/ios/) for what a Simulator or emulator needs.

Two Dart packages in the `flutter/` folder of the Lynkeus repository make the difference. **`lynkeus_agent`** goes in the app: it dials the driver from a debug build and answers from the live widget tree. **`lynkeus_headless`** goes in `dev_dependencies` and hosts the app inside `flutter test`. Neither is on pub.dev yet, so they are declared as git or path dependencies.

## Summary

| Topic | In a Flutter app |
|---|---|
| Setup | `npx lynkeus init`, or by hand (below). |
| Token in the app | `--dart-define=LYNKEUS_TOKEN=$(cat .lynkeus/token)`. No Babel plugin. |
| Test id | A `ValueKey<String>` or `Semantics(identifier:)`, targeted as `#id`. |
| Routes | A `Navigator` observer, or `LynkeusRoutes` for go_router and other routers. In `wait`, written `route:/settings`. |
| Network log and mocks | Requests through dart:io's `HttpClient` only. |
| Headless host | `lynkeus case run --host`, on `flutter test`. Needs Flutter on the machine. |
| Release builds | No agent. |

## Set up the app

```bash
npx lynkeus init
```

In a folder whose `pubspec.yaml` depends on `flutter`, `init` adds `lynkeus_agent` to `dependencies`, starts it before `runApp(` in `lib/main.dart`, and writes the token to `.lynkeus/token`, kept out of git. It changes only what is missing. In a folder that is also a React Native app, pass `--runtime flutter`; `--no-install` leaves `pubspec.yaml` alone; when `main.dart` has no `runApp(` it can recognize, it prints the lines to add.

By hand:

```yaml title="pubspec.yaml"
dependencies:
  lynkeus_agent:
    git:
      url: https://github.com/lynkeushq/lynkeus.git
      path: flutter/lynkeus_agent
```

```dart title="lib/main.dart"
import 'package:lynkeus_agent/lynkeus_agent.dart';

void main() {
  LynkeusAgent.start();
  runApp(const MyApp());
}
```

Start the agent first in `main()`, before `WidgetsFlutterBinding.ensureInitialized()`: under Lynkeus FastSim it installs its own binding, and a binding cannot be replaced once one exists (`lynkeus init` places it there). The agent reads the token from a `--dart-define`; without one it stays off and says so in the console. Run the app with it on a Simulator or emulator, then check with `npx lynkeus screen`:

```bash
flutter run --dart-define=LYNKEUS_TOKEN=$(cat .lynkeus/token)
```

`LYNKEUS_HOST` and `LYNKEUS_PORT` are also `--dart-define`s. By default the app dials `127.0.0.1:8123`, and on Android `10.0.2.2` and then `127.0.0.1`. The `flutter/sample/` app and its cases show a working project.

## How elements are identified

A **test id** is a `ValueKey<String>` (`Key('increment')`) or a `Semantics(identifier: 'increment')`; target it as `#increment`. When the key sits on a wrapper, it names the first listed element below it. **Text** and **labels** (`Semantics(label:)`, a tooltip, an icon's `semanticLabel`) match as in any case, and a fragment of a paragraph is never a target. Kinds come from what controls tell assistive technology, so Material, Cupertino and the `material_ui` and `cupertino_ui` packages read alike.

The screen is the onstage element tree: routes under an opaque one, `Offstage` subtrees and lazy-list rows built past the viewport are left out. `~covered` is Flutter's own hit test at the element's center, and `inert` is under an `IgnorePointer` or `AbsorbPointer`.

An app command for `app.call` is registered with `LynkeusAgent.register('reset', (_) { … })`.

## Routes

Route names usually start with a slash, and a lowercase word alone is read as text, so say that it is a route: `app.wait: "route:/settings"`.

With a `Navigator` and named routes, give the observer to the root navigator: `MaterialApp(navigatorObservers: [LynkeusAgent.navigatorObserver], …)`. Routes with no name (a dialog, a page pushed with no settings) are not reported; the route stays the last named one under them. An app on a router describes its routes from the router's own state, since the agent depends on no router package. With go_router:

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

`current` is the focused route, `changes` fires when it may have changed, and `navigate` is what `lynkeus nav` calls.

## The network log

Requests through dart:io's `HttpClient` are recorded, mocked and held by the same commands as in React Native ([Fixtures](/guides/fixtures/), `lynkeus requests`, `lynkeus mock`). `package:http`'s `IOClient` and dio's default adapter use it; a client with its own networking (a platform channel, a webview) is not seen.

## Headless

The headless host runs the app's own `main()` inside `flutter test`, with real layout and software paint and no simulator. Every command works unchanged. See [Headless](/platforms/headless/) for what a host is; this is what differs.

```yaml title="pubspec.yaml"
dev_dependencies:
  lynkeus_headless:
    git:
      url: https://github.com/lynkeushq/lynkeus.git
      path: flutter/lynkeus_headless
```

```bash
npx lynkeus case run --host        # starts the host for the run and stops it after
npx lynkeus headless start         # or keep one running
```

- **Flutter is found** through `FLUTTER_ROOT`, then `flutter` on `PATH`, then `mise which flutter`. The host file is written to `.lynkeus/host/`, not `test/`, so the app's own `flutter test` never runs it. `--entry` names a `main` other than `lib/main.dart`.
- **Time is virtual**, on flutter_test's fake clock. While the driver waits and no request of the app is out, a three second countdown passes in a few hundred milliseconds. `lynkeus os clock` drives it (`--advance`, `--settle`, `--now`, `--reset`). The app's clock is `package:clock`.
- **The screen** is an iPhone-sized iOS device unless `lynkeus.config.json` says otherwise; `networkHosts` fences the real network (loopback and `10.0.2.2` by default):

  ```json title="lynkeus.config.json"
  { "flutterHost": { "platform": "android", "window": "412x915@2.625", "networkHosts": ["127.0.0.1", "api.local"] } }
  ```

- **`--locale`, `--time-zone` and `--epoch`** are passed on by `case run --host`. `lynkeus screenshot` writes a PNG with the app's fonts, Roboto and the Material icons.
- **Plugins.** flutter_test leaves platform channels unanswered, so the host answers every one. These have in-memory stand-ins:

| Plugin | Stand-in | Driven by |
|---|---|---|
| `shared_preferences`, `flutter_secure_storage` | a key-value map | the app |
| `path_provider` | folders under a temporary folder per run | |
| `device_info_plus`, `package_info_plus` | an iPhone, or an Android emulator, as the host plays | |
| `url_launcher` | says it can open a URL, opens nothing, writes it down | `lynkeus call launched` |
| `local_auth` | Face ID enrolled; prompts succeed | `lynkeus os biometrics` |
| `permission_handler` | every permission granted | `lynkeus call permissions '{"7": 4}'` |
| `connectivity_plus` | Wi-Fi | `lynkeus call network '{"state": "off"}'` |

Any other channel answers null, so an `await` never hangs, and logs one `[stub] <channel>` line; `LYNKEUS_CHANNELS=trace` logs every call. A project adds its own stand-ins in `test/lynkeus_host.dart`, which `lynkeus headless start` passes on:

```dart title="test/lynkeus_host.dart"
import 'package:lynkeus_headless/lynkeus_headless.dart';

void configureHost(HostConfig host) {
  host.standIns.add('com.example/wallet', (method, args) => method == 'balance' ? 1250 : null);
  host.plugins.preferences['flutter.onboarded'] = true;
}
```

A case can branch on where it runs with `on: headless`.

## Lynkeus FastSim

[Lynkeus FastSim](/guides/fastsim/) runs a Flutter app without Xcode's simulator or an Android emulator. It loads the app's own debug kernel into Flutter's own engine, on an Apple Silicon Mac or on Linux, and moves the app's clock itself, so a three second countdown or a two second page load takes milliseconds. Lynkeus drives it as it drives a simulator, so the same cases run on both. It is part of the Team plan; the [FastSim guide](/guides/fastsim/) covers keys, sign-in and grants, which work as for React Native.

### Install, bundle, run

```bash
npx lynkeus fastsim install
```

In a folder whose `pubspec.yaml` takes `flutter` from the SDK, this installs the Flutter build; elsewhere, add `--runtime flutter`. One build draws both platforms, because Flutter's engine draws iOS and Android with the same code: `darwin-arm64-flutter` on an Apple Silicon Mac, `linux-arm64-flutter` or `linux-x64-flutter` on Linux. The first run of each Flutter version downloads that version's engine from Flutter's own storage (about 30 MB on a Mac, 15 MB on Linux) into `~/.cache/lynkeus/fastsim/flutter-engine/`.

Bundle the app, again after each change to its Dart code:

```bash
FLUTTER=flutter <install folder>/bin/fastsim-bundle . <bundle folder> ios -- --dart-define=LYNKEUS_TOKEN=$(cat .lynkeus/token)
```

The bundle is the app's debug kernel, built with `flutter build bundle --debug --no-track-widget-creation`; flags after `--` (`--dart-define`, `--flavor`, `-t lib/main_dev.dart`) go to that command. `android` in place of `ios` makes the app see an Android phone. `FLUTTER` names the Flutter command when it is not `flutter` on the `PATH` (`fvm flutter`, `mise exec flutter@3.50.1 -- flutter`).

Then run the cases, one host per case:

```bash
npx lynkeus case run <cases> --ports 8232 --host-command "<install folder>/bin/fastsim-run <bundle folder> {port}"
```

`--ports` names the port each host's app dials; with `--jobs <n>`, give `n` of them (`--ports 8232,8233`). A host's output goes to `<bundle folder>/hosts/<port>.out` and `.err`; the app's `print` and `debugPrint` lines, and the stand-ins' `[stub]` lines, are in the `.err` file. `FASTSIM_HOST_FLAGS` passes more to the host, such as `--appearance dark` or `--locale es-AR`.

To compare FastSim's screens with a simulator's or an emulator's, build the reference app from the same code with the same flags: `flutter build ios --simulator --debug` or `flutter build apk --debug --no-track-widget-creation`, with the same `--dart-define` values. Without `--no-track-widget-creation` on both, the two kernels differ, and so can the pixels.

### What the host gives the app

- **A device.** `ios` is an iPhone 17 (402×874 points at 3×, its safe area and its keyboard heights); `android` is a Pixel 9 (411×923 points at 2.625×). `Platform.isIOS` or `Platform.isAndroid` answers for that phone, and the app's platform code takes that path.
- **A clock of its own.** `DateTime.now()`, `Timer`, `Future.delayed` and `Stopwatch` follow it. It runs ahead while the driver waits on the app and no request is out to a real server, and keeps the wall's pace while one is, so a backend answers in its own time. A request `netmock` answers does not hold it: its `delayMs` passes at the clock's speed. `lynkeus os clock` moves it by hand.
- **The rest of the host commands**, as on React Native: screenshots, video recording, waiting for a still screen, `lynkeus os appstate` (the app goes through each lifecycle state on the way, as a phone sends them) and a relaunch.
- **Stand-ins for the plugins.** The app's native side is not there, and the generated plugin registrant does not run, so plugins use their method channels and the same stand-ins as on the [headless host](#headless) answer them. The `lynkeus call` commands that drive them work the same.

### What the app needs

- **The agent starts first.** `LynkeusAgent.start()` has to come before anything calls `WidgetsFlutterBinding.ensureInitialized()`, on the line before it in the same block: inside FastSim the agent makes the app's binding, which gives the screen its safe area and the plugins their stand-ins. An app that made its binding first still runs and is driven, with no safe area, and a plugin awaited before `runApp` can wait forever.
- **`lynkeus_plugins` when a plugin has no channel to fall back to.** sqflite 2.4 or newer (and with it `cached_network_image`, whose cache is a sqflite database) and shared_preferences' `SharedPreferencesAsync` and `SharedPreferencesWithCache` throw on a host without it, and the images show their error widgets. It is needed when `pubspec.lock` lists `sqflite_platform_interface`, or `shared_preferences_platform_interface` 2.4.0 or newer. Add it next to the agent, as a regular dependency, and call it on the line after the agent starts; on a phone it does nothing:

  ```yaml title="pubspec.yaml"
  dependencies:
    lynkeus_plugins:
      git:
        url: https://github.com/lynkeushq/lynkeus.git
        path: flutter/lynkeus_plugins
  ```

  ```dart title="lib/main.dart"
  LynkeusAgent.start();
  LynkeusPlugins.ensureInitialized();
  ```

  It covers the headless host too.

### Limits

- **Native views are not drawn.** A `UiKitView` or an `AndroidView` (a web view, a map, a native tab bar) keeps its place and size and shows nothing; the app gets an error that names the view, and the log says why.
- **The Android look is for Linux.** There the engine draws with OpenGL ES on ANGLE and SwiftShader, as the emulator does. A Mac's engine has only Metal, which some of Flutter's Android drawing (the stretch overscroll) lacks, so compare Android screens on Linux. The iOS look matches the simulator on a Mac, with the simulator's own system font when Xcode's iOS runtime is installed; Linux has no stand-in for it yet.
- **Text in other scripts on Linux.** The Linux engine finds no font for a character missing from the app's fonts, so Chinese, Japanese, emoji and the like draw as boxes there. Cases still pass, since they read the widget tree; the pixels do not match.
- **Flutter's prebuilt debug engine only.** No profile or release builds, and no custom engine. Flutter 3.50.1 is the version run so far; on Linux arm64 Flutter publishes engines from 3.38 on.
- **A plugin with only native code or FFI behind it**, and no channel to fall back to, that `lynkeus_plugins` does not cover, has nothing to answer it.

## Limits today

- **Debug builds only.** A release build carries no agent. See [Security](/security/).
- **Headless sees the machine.** `Platform` answers for it and `DateTime.now()` reads the real clock; only `package:clock` is virtual.
- **`--seed` has no effect** on the headless host: Dart's `Random()` cannot be seeded from outside.
- **`--host-heap` restarts are skipped.** The Dart VM gives a running program no heap figures.
- **`lynkeus map`, `case impact`, `smoke` and `crawl` do not work for Flutter yet.** They read React Navigation sources.
- **`lynkeus status` checks React Native setup** and asks for a `package.json`, so its answer is not meaningful in a Flutter project.
- **Lynkeus FastSim** has limits of its own; see [its section](#lynkeus-fastsim).
- **Two apps cannot dial the same port.** Close the other one, or give one its own with `LYNKEUS_PORT`.

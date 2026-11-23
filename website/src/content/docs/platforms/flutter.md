---
title: Flutter
description: What is specific to running Lynkeus in a Flutter app. Setup, the three places it runs (a Simulator or emulator, headless on flutter test, Lynkeus FastSim), what differs when writing cases, plugin stand-ins and known limits.
---

This page collects what is particular to Flutter. Cases, the CLI, reports and the MCP server are the same as for React Native: read [Writing cases](/guides/writing-cases/) and [Driving the app](/guides/driving-the-app/) for those, and [Android](/platforms/android/) and [iOS](/platforms/ios/) for what a Simulator or emulator needs.

Two Dart packages in the `flutter/` folder of the Lynkeus repository make the difference. **`lynkeus_agent`** goes in the app: it dials the driver from a debug build and answers from the live widget tree. **`lynkeus_headless`** goes in `dev_dependencies` and hosts the app inside `flutter test`. A third one, `lynkeus_plugins`, is optional ([Plugin stand-ins](#plugin-stand-ins)). None of them is on pub.dev yet, so they are declared as git or path dependencies. [Lynkeus FastSim](#lynkeus-fastsim) runs the app on a host of its own, installed apart from these packages. Flutter 3.47.9 or later.

## Summary

| Topic | In a Flutter app |
|---|---|
| Setup | `npx lynkeus init` (`--headless` adds the host package; `--runtime flutter` in a folder that is also React Native), or by hand. |
| Token in the app | `--dart-define=LYNKEUS_TOKEN=$(cat .lynkeus/token)`, and `LYNKEUS_HOST` and `LYNKEUS_PORT` the same way. No Babel plugin. |
| Where it runs | A Simulator or emulator (debug build); [headless](#headless) on `flutter test` with `case run --host`, either look through `flutterHost.platform`; [Lynkeus FastSim](#lynkeus-fastsim), a separate host. Release builds have no agent. |
| Test id | A `ValueKey<String>` or `Semantics(identifier:)`, targeted as `#id`. |
| In a case | `app.wait: { text: X }` is always a text; commands are registered with `LynkeusAgent.register`; a field with no label is targeted by its hint. |
| Routes | Read from the app's `Router` (go_router and the like) with nothing to wire, or a `Navigator` observer. In `wait`, written `route:/settings`. |
| Network | Requests through dart:io's `HttpClient` only. Hosts keep the app off the internet (`networkHosts`) and replay what a device run recorded. |
| Plugins | On a host, in-memory stand-ins, listed [below](#plugin-stand-ins). |

## Set up the app

```bash
npx lynkeus init
```

In a folder whose `pubspec.yaml` depends on `flutter`, `init` adds `lynkeus_agent` to `dependencies`, starts it in `lib/main.dart`, and writes the token to `.lynkeus/token`, kept out of git. It changes only what is missing. In a folder that is also a React Native app, pass `--runtime flutter`; `--headless` also adds `lynkeus_headless` to `dev_dependencies`; `--no-install` leaves `pubspec.yaml` alone; when `main.dart` has no `runApp(` it can recognize, it prints the lines to add. When the lockfile shows a plugin that needs `lynkeus_plugins` on a host, `init` adds that too, with its call ([Plugin stand-ins](#plugin-stand-ins)).

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

Start the agent first in `main()`, before `WidgetsFlutterBinding.ensureInitialized()`. It installs its own binding, which is the app's usual one plus what makes a captured frame repeatable ([below](#what-a-steps-frame-shows)) and, on FastSim, gives the app its safe area; a binding cannot be replaced once one exists, and `lynkeus init` places the line there. The agent reads the token from a `--dart-define`; without one it stays off and says so in the console. Run the app with it on a Simulator or emulator, then check with `npx lynkeus screen`:

```bash
flutter run --dart-define=LYNKEUS_TOKEN=$(cat .lynkeus/token)
```

`LYNKEUS_HOST` and `LYNKEUS_PORT` are also `--dart-define`s. By default the app dials `127.0.0.1:8123`, and on Android `10.0.2.2` and then `127.0.0.1`. The `flutter/sample/` app and its cases show a working project.

### An app with a binding of its own

An app whose binding is its own class (one that overrides `handlePointerEvent`, say) makes it extend `LynkeusBinding` instead of `WidgetsFlutterBinding`, and creates it before `LynkeusAgent.start()`, which then uses it; the app gets everything above:

```dart title="lib/main.dart"
class MyBinding extends LynkeusBinding {
  // the app's own overrides
}

void main() {
  MyBinding();
  LynkeusAgent.start();
  runApp(const MyApp());
}
```

`lynkeus init` does not rewrite the class: when `main()` makes a binding of its own it puts `start()` after it and says what that costs. Without the change the app still runs and is driven, and on FastSim its plugins are still answered, but looping animations are not pinned and fades are not waited out, and on FastSim the screen has no safe area; the console says so. A binding created after `start()` fails Flutter's own check, `Binding is already initialized to LynkeusBinding`.

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

`npx lynkeus init --headless` adds the dependency for you.

- **Flutter is found** through `FLUTTER_ROOT`, then `flutter` on `PATH`, then `mise which flutter`. The host file is written to `.lynkeus/host/`, not `test/`, so the app's own `flutter test` never runs it. `--entry` (or `entry` in `lynkeus.config.json`, a `.dart` file) names a `main` other than `lib/main.dart`.
- **Time is virtual**, on flutter_test's fake clock. While the driver waits and no request of the app is out, a three second countdown passes in a few hundred milliseconds. `lynkeus os clock` drives it (`--advance`, `--settle`, `--now`, `--reset`). The app's clock is `package:clock`.
- **The screen** is an iPhone-sized iOS device unless `lynkeus.config.json` says otherwise, so one host plays either look: `"platform": "android"` makes it an Android phone for `defaultTargetPlatform`, the screen, `device_info_plus` and the default position (`Platform` itself stays the machine's: see [Limits today](#limits-today)). `networkHosts` is [the fence](#the-fence):

  ```json title="lynkeus.config.json"
  { "flutterHost": { "platform": "android", "window": "412x915@2.625", "networkHosts": ["127.0.0.1", "api.local"] } }
  ```

- **`--locale`, `--time-zone` and `--epoch`** are passed on by `case run --host`. `lynkeus screenshot` writes a PNG with the app's fonts, Roboto and the Material icons.
- **Commands the host adds:** `appstate` (`active`, `inactive` or `background`, through the states between), `deeplink` (a link as the system delivers it), `memory` (the process's resident size) and `exit`.
- **Plugins** are answered by in-memory stand-ins: [Plugin stand-ins](#plugin-stand-ins).

A case can branch on where it runs with `on: headless`. Native views (a WebView, a map, a video) stay blank under headless, because nothing draws them, and a step aimed inside one fails with an error that names it; [FastSim draws a placeholder](#lynkeus-fastsim) there instead.

## Lynkeus FastSim

[Lynkeus FastSim](/guides/fastsim/) runs a Flutter app without Xcode's simulator or an Android emulator. It loads the app's own debug kernel into Flutter's own engine, on an Apple Silicon Mac or on Linux, and moves the app's clock itself, so a three second countdown or a two second page load takes milliseconds. Lynkeus drives it as it drives a simulator, so the same cases run on both. It is part of the Team plan; the [FastSim guide](/guides/fastsim/) covers keys, sign-in and grants, which work as for React Native.

### Install, bundle, run

```bash
npx lynkeus fastsim install
```

In a folder whose `pubspec.yaml` takes `flutter` from the SDK, this installs the Flutter build; elsewhere, add `--runtime flutter`. One build draws both platforms, because Flutter's engine draws iOS and Android with the same code: `darwin-arm64-flutter` on an Apple Silicon Mac, `linux-arm64-flutter` or `linux-x64-flutter` on Linux. The build is about 57 MB on a Mac and 64 MB on Linux; most of that is Android's own fonts, for the Android look. On Linux it also uses the system's zlib and OpenSSL 3 (`libssl3` on Debian and Ubuntu). The first run of each Flutter version downloads that version's engine from Flutter's own storage (about 30 MB on a Mac, 15 MB on Linux) into `~/.cache/lynkeus/fastsim/flutter-engine/`.

Bundle the app, again after each change to its Dart code:

```bash
FLUTTER=flutter <install folder>/bin/fastsim-bundle . <bundle folder> ios -- --dart-define=LYNKEUS_TOKEN=$(cat .lynkeus/token)
```

The bundle is the app's debug kernel, built with `flutter build bundle --debug --no-track-widget-creation`; flags after `--` (`--dart-define`, `--flavor`, `-t lib/main_dev.dart`) go to that command. `android` in place of `ios` makes the app see an Android phone. `FLUTTER` names the Flutter command when it is not `flutter` on the `PATH` (`fvm flutter`, `mise exec flutter@3.50.1 -- flutter`). On a Mac, an `ios` bundle also carries the iOS Simulator engine's shaders, copied from that Flutter, which the host draws the iOS look with. A Flutter that has never fetched its iOS files has none: `fastsim-bundle` then stops with exit code 3 and asks for `flutter precache --ios`, which you run once.

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
- **Stand-ins for the plugins**, the same as on the headless host: [Plugin stand-ins](#plugin-stand-ins).

### What the app needs

- **The agent started first**, and an app's own binding extending `LynkeusBinding`: [Set up the app](#set-up-the-app). Without them the app runs and is driven and its plugins are answered, but it has no safe area.
- **`lynkeus_plugins`** when a plugin has no channel to fall back to ([Plugin stand-ins](#plugin-stand-ins)).

### Limits

- **Native views are placeholders.** A `UiKitView`, an `AndroidView` or a `PlatformViewLink` (a web view, a map, a native tab bar) keeps its place and size, and FastSim draws a gray box there labeled with the view's type and "native view, not drawn". Flutter content drawn over the view, such as a button on a map, shows and takes taps as on a phone. Any other step whose point falls inside the view (`press`, `type`, the start of a `swipe`) fails with `this point is inside native view <type>, which only exists on a device` instead of touching nothing. `screen` reports each view's rectangle under `platformViews` on every side, and the pixel comparison masks those rectangles on both, so the placeholder is never a difference. Cover what the view shows on a simulator, an emulator or a phone, where steps inside it work.
- **Pixels match one host per look.** The iOS look matches the Simulator on a Mac (Impeller on Metal, the Simulator's own system font when Xcode's iOS runtime is installed, and the shaders `flutter precache --ios` fetches); Linux has no stand-in for that font yet. The Android look matches the emulator on Linux, where the engine draws with OpenGL ES on ANGLE and SwiftShader as the emulator does. A Mac's engine has only Metal, which some of Flutter's Android drawing (the stretch overscroll) lacks: there the Android look tells you whether the cases pass, not what the pixels are.
- **Text in other scripts with the iOS look on Linux.** With the Android look, the Linux build carries Android's own fonts and a character missing from the app's fonts falls back as on Android, in `fonts.xml` order (Chinese, Japanese, Arabic, Devanagari, Thai, emoji). The iOS look on Linux has no such fonts, so those characters draw as boxes there. Cases still pass, since they read the widget tree; the pixels do not match.
- **Flutter's prebuilt debug engine only.** No profile or release builds, and no custom engine. Checked on Flutter 3.47.9 and 3.50.1 (and a 3.51 beta); on Linux arm64 Flutter publishes engines from 3.38 on.
- **A plugin with only native code behind it** that `lynkeus_plugins` and the desktop-library loading do not cover has nothing to answer it. `fastsim-bundle` and the host name it when they start. isar ships a Linux library for x86-64 only, so Isar cannot open its database on an arm64 Linux host.

## What differs in a case

Cases, targets and steps are the ones in [Writing cases](/guides/writing-cases/) and the [case format](/reference/case-format/). These are the differences.

### How elements are identified

A **test id** is a `ValueKey<String>` (`Key('increment')`) or a `Semantics(identifier: 'increment')`; target it as `#increment`. When the key sits on a wrapper, it names the first listed element below it. **Text** and **labels** (`Semantics(label:)`, a tooltip, an icon's `semanticLabel`) match as in any case, and a fragment of a paragraph is never a target. A field with no label is found by its whole hint (`app.type: { target: "Search...", text: "Paris" }`), below a label or a text with the same words. Kinds come from what controls tell assistive technology, so Material, Cupertino and the `material_ui` and `cupertino_ui` packages read alike.

The screen is the onstage element tree: routes under an opaque one, `Offstage` subtrees and lazy-list rows built past the viewport are left out. `~covered` is Flutter's own hit test at the element's center, and `inert` is under an `IgnorePointer` or `AbsorbPointer`.

### Waits and commands

`app.wait: { text: Continue }` always waits for that text in a Flutter project, whatever the word looks like; in a React Native project the value of `text` is read as a plain `app.wait` value (a route, milliseconds, `#testId` or a text). A route in Flutter is written `route:/settings` ([below](#routes)).

An app command for `app.call` is registered with `LynkeusAgent.register('reset', (_) { … })`, where React Native has `qa.register`. `reset` and `busy` mean what they mean in the [Agent API](/reference/agent-api/).

### What a step's frame shows

A step's frame depends on the app's code, the case's steps and the data, never on how long a device took: two runs on a Simulator and one on FastSim show the same thing. So `idle` (what `--settle` waits for) is not quiet while work that ends on its own is under way: a timer the app set for no longer than the wait (a page that loads after 2 seconds, a toast that hides after 2 seconds, a search's debounce) or one set at launch before the driver's first action (a splash screen's), an animation such work sets off (a toast fading out), an image still loading, or a request that is out. Periodic timers, a polling loop and longer timers do not count. [The protocol](/reference/protocol/) has the full rule.

Something that animates forever has no end to wait for. When `idle` answers with a spinner, a shimmer or a blinking caret on screen, the agent draws one more frame with each of those at the moment it started, a caret drawn on, and draws nothing else until the driver's next request that is not a screenshot or a still (a `screen` read frees it, so a wait that polls it sees the app move on), at most 3 seconds. This needs the agent's binding ([Set up the app](#set-up-the-app)).

In a run with frames, the `app.see` steps right after a step run before that step's frame is taken, so a toast the step shows is still there to be seen, and then share that step's frame: they have no screenshot of their own, and the frame is of the screen once the toast is gone.

### Routes

Route names usually start with a slash, and a lowercase word alone is read as text, so say that it is a route: `app.wait: "route:/settings"`.

An app on Flutter's router (`MaterialApp.router`, which go_router, auto_route and a delegate of the app's own all use) needs nothing: the agent reads the app's root `Router`. The route is go_router's state, its `name`, or its `fullPath` (`/habits/:id`, not `/habits/42`) when it has none, which are the names the route graph gives it; with another router it is the location's path. `navigate` sends a path as the engine sends a deep link, so the router's redirects run as they would for a link. A route known only by its name needs the router's own `goNamed`: give the agent its routes where the router is made, which also works for a router built in a State or a provider:

```dart
final appRouterProvider = Provider<GoRouter>((ref) {
  final router = GoRouter(routes: [...]);
  LynkeusAgent.routes = LynkeusRoutes(
    current: () => router.state.name ?? router.state.fullPath,
    changes: router.routerDelegate,
    navigate: (route, params) => route.startsWith('/')
        ? router.go(route)
        : router.goNamed(route, pathParameters: {for (final e in (params ?? const {}).entries) e.key: '${e.value}'}),
  );
  return router;
});
```

`current` is the focused route, `changes` fires when it may have changed, and `navigate` is what `lynkeus nav` calls. `LynkeusAgent.start(routes: ...)` takes the same, for a router that exists before `runApp`.

With a `Navigator` and named routes, give the observer to the root navigator: `MaterialApp(navigatorObservers: [LynkeusAgent.navigatorObserver], …)`.

Either way, a page pushed with no name (`Navigator.push(MaterialPageRoute(builder: (_) => const Items()))`) is reported by the class of the widget it shows, `Items`, which is also the name `lynkeus map` gives it; it cannot be opened by name, and from the moment it is popped it is no longer the route. A route that is not a page (a dialog, a sheet) is not reported; the route stays the one under it. `navigate` to a route already on the stack goes back to it instead of pushing a second copy.

### The route graph

`lynkeus map build` reads a Flutter app's routes from the Dart under `lib/`, without the Dart SDK, so `map`, `case impact`, `case coverage`, `smoke` and `crawl` work as they do in React Native, with the same output and flags. It reads:

- **go_router:** `GoRoute` with nested `routes:`, inside `ShellRoute` and `StatefulShellRoute` branches, and `@TypedGoRoute`. The route is its `name:`, else its full path. A path or name built in a helper (an enum's field, a `switch` on it, a static constant, an interpolated string) is read at each call of the helper. A route that only redirects is not a screen.
- **A Navigator:** `MaterialApp` (or `CupertinoApp`, `WidgetsApp`) `routes:` and `home:`, and `onGenerateRoute` when it switches on, or compares, the route's name.
- **A router of the app's own** (fluro and the like): a call that registers a path with a builder, `router.define('/goods', handler: Handler(handlerFunc: (_, __) => const GoodsPage()))`.
- **Edges:** `context.go`, `push`, `goNamed`, `pushNamed`, `Navigator.pushNamed` and the like, with a location matched to its route (`/habits/42` to `/habits/:id`), and `Navigator.push(MaterialPageRoute(builder: (_) => X()))`, an edge to the screen named `X`. The control that leads there is the widget whose `on…:` callback holds the call, by its `key: ValueKey('…')`, directly or through the handler it names.

Each screen points at the file of the widget its builder makes; `case impact` follows imports from there (a barrel's names to the files that declare them), as it does in React Native. Whatever cannot be read is printed with its file and line by `map build` and kept in the graph's `warnings`; a route is never dropped without one. `smoke` opens the routes that need nothing: not one with a path parameter, one whose builder casts `state.extra` or the route's `arguments` to a type that is not nullable, or a page pushed without a name. Both `smoke` and `crawl` open routes through the agent's `navigate`, so the app needs a `Router`, the observer or `LynkeusRoutes` (above). A route that redirects (an onboarding gate) is reported where it landed.

## The network log

Requests through dart:io's `HttpClient` are recorded, mocked and held by the same commands as in React Native ([Fixtures](/guides/fixtures/), `lynkeus requests`, `lynkeus mock`). `package:http`'s `IOClient` and dio's default adapter use it; a client with its own networking (a platform channel, a webview) is not seen.

### The fence

A host (headless, and the Flutter host of [Lynkeus FastSim](/guides/fastsim/#flutter-apps)) keeps the app off the internet: it may reach loopback and `10.0.2.2` only. A request to any other host fails as a socket error that says why:

```text
lynkeus: images.example.com is outside networkHosts (127.0.0.1, localhost, ::1, 10.0.2.2): mock the request (app.mock in the case, or lynkeus mock), or allow the host with "flutterHost": { "networkHosts": [...] } in lynkeus.config.json
```

Mock it, or allow the host in `lynkeus.config.json` (`"flutterHost": { "networkHosts": ["127.0.0.1", "api.local"] }`; a list replaces the defaults, so keep the local hosts you need). A blocked request is still listed in `lynkeus requests`, and a request a mock answers never reaches the fence. On a Simulator, an emulator or a phone there is no fence.

### Replaying remote fetches

A network image drawn from a host the fence blocks shows its placeholder, where a device shows the picture. Record what the app fetches once, on a run where the network is real, and the hosts answer from the recording:

```bash
npx lynkeus case run --device <simulator> --net-cache qa/net --net-record
npx lynkeus case run --host --net-cache qa/net
```

The folder is the one the React Native host's `--net_cache` uses: a file per URL holding the body as the app read it, and a `.json` beside it with the URL, the status and a few headers. With `--host-command` (FastSim) the folder is replayed the same way. A replayed answer shows as `replayed` in `lynkeus requests`, and a mock still answers first.

What is recorded: successful (2xx) GETs and HEADs (a connectivity check's) to hosts outside the local ones, and none that sent an `Authorization` header or cookies unless you add `--net-record-credentials`. What is not: other methods, WebSockets, streamed bodies, and anything a client with its own networking fetched. A host the run starts records from its launch, so what the app fetches as it starts is kept too; a device build records from its launch with `--dart-define=LYNKEUS_NET_RECORD=1`, and otherwise from the moment the driver attaches. A replayed answer carries the recorded `Date` header, which an app that corrects its clock with the server's (as Rain does) then reads as the time it was recorded. The agent holds at most about 64 MB of recordings at a time, dropping the oldest, and the CLI takes them after every case. `--net-record` needs `--net-cache`, and only the Flutter agent can record; a React Native app has `--net_record`.

## Plugin stand-ins

On a host there is no native side: flutter_test leaves platform channels unanswered, and FastSim skips the app's generated plugin registrant. So the agent answers the channels itself, with in-memory stand-ins that live in `lynkeus_agent` (`package:lynkeus_agent/hosts.dart`). Headless and FastSim answer the same way, and the same `lynkeus call` commands drive them. On a Simulator, an emulator or a phone the real plugin runs.

| Plugin | Stand-in | Driven by |
|---|---|---|
| `shared_preferences`, `flutter_secure_storage` | a key-value map | the app |
| `path_provider` | folders under a temporary folder per run | |
| `sqflite` | the system's SQLite, databases in a folder of the run (2.4 or later needs `lynkeus_plugins`, below) | the app |
| `device_info_plus`, `package_info_plus` | an iPhone 17 on iOS 26.5, or an Android 15 emulator, as the host plays; fixed package info (`io.lynkeus.host`, 1.0.0) | |
| `url_launcher` | says it can open a URL, opens nothing, writes it down | `lynkeus call launched` (`{"clear": true}` empties it) |
| `local_auth` | Face ID on iOS, a fingerprint on Android; prompts succeed | `lynkeus os biometrics --available none\|face\|fingerprint --next success\|fail\|cancel\|<error code>` |
| `permission_handler` | every permission granted | `lynkeus call permissions '{"7": 4}'` (a permission's number to a status: 0 denied, 1 granted, 2 restricted, 3 limited, 4 permanently denied) |
| `connectivity_plus` | Wi-Fi; off is airplane mode: every request the app makes fails, a replayed one too, and only `netmock` still answers | `lynkeus os network off` (`lynkeus call network '{"state": "off"}'`) |
| `flutter_local_notifications` | every permission granted; what the app schedules or shows is written down, nothing is shown | `lynkeus call notifications` (`{"clear": true}` empties it) |
| `flutter_timezone` | the zone of `--time-zone`, else the machine's | |
| `share_plus` | the share sheet reports success and writes down what was shared | `lynkeus call shared` (`{"clear": true}`) |
| `file_selector` | a picker returns what `files` queued, or is cancelled; a save dialog answers a path in a folder of the run | `lynkeus call files '{"open": "/path/backup.json"}'` |
| `open_file`, `app_settings` | open nothing; written down with the URLs | `lynkeus call launched` |
| `dynamic_color` | no wallpaper colors | |
| `geolocator` | the position the iOS Simulator or the Android emulator starts at (Apple Park, the Googleplex), permission granted, services on; its settings screens are written down with `launched` | `lynkeus call location '{"permission": "denied", "request": "whileInUse", "latitude": 52.52, "longitude": 13.4, "service": false}'` |
| `geocoding` (up to 4.x) | the nearest known place: the two default positions, and those a case adds with `location`'s `place` | `lynkeus call location` |
| `home_widget` | keeps the widgets' data and the updates asked for | `lynkeus call widgets` (`{"clear": true}` empties the updates) |
| `workmanager` | tasks stay scheduled and never run | `lynkeus call tasks` |
| `flutter_displaymode` | one 120 Hz mode | |
| `restart_app` | counts the restart and reports it done; the app goes on | `lynkeus call tasks` (`restarts`) |

A case that reads these commands runs those steps only where they exist, with `on: has:notifications` (or `has:shared`, `has:files`, `has:launched`); on a simulator the system's share sheet and file picker are out of the agent's reach.

Any other channel answers null, so an `await` never hangs, and logs one `[stub] <channel>` line; `LYNKEUS_CHANNELS=trace` logs every call. Plugins with no method-channel default need more:

- **`flutter_local_notifications` and `workmanager`** only get their implementation from the registrant. The host file that `headless start` writes, and the kernel `fastsim-bundle` builds, set their iOS or Android class for the platform the host plays, when `pubspec.lock` lists them. A project needs to do nothing.
- **`geocoding` 5** has none and its platform classes are Pigeon proxies, so under a host it fails as a geocoder that finds nothing does, and an app's own fallback takes over.
- **sqflite 2.4 or later** (including through `cached_network_image`) and **shared_preferences' async API** throw on a host. The optional `lynkeus_plugins` package fixes them. Add it next to `lynkeus_agent`, as a regular dependency, and call it on the line after the agent starts:

```dart
LynkeusAgent.start();
LynkeusPlugins.ensureInitialized();
```

It does nothing on a Simulator, an emulator or a phone. `lynkeus init` adds it only when your `pubspec.lock` shows one of those plugins, and `lynkeus status` checks it.

- **A plugin that calls its native library through `dart:ffi`** (an Isar database through `isar_community_flutter_libs`) has no channel to stand in for. Many ship that library prebuilt for the desktop too, `macos/libisar.dylib` and `linux/libisar.so`, and a host runs on a desktop: before the app starts, it loads every library a plugin keeps in its `macos/` (or `linux/`) folder, as `.flutter-plugins-dependencies` lists the plugins, and says so (`native libraries: libisar.dylib`). The plugin's own lookup then finds it, and the database runs for real, its files in the run's temporary folder. On FastSim, `fastsim-bundle` copies the macOS and Linux libraries into the bundle. An FFI plugin that ships no desktop build fails as it would on a desktop the plugin does not support; one that ships only iOS or Android binaries is named, with what to do, by `fastsim-bundle` and when the host starts.

A project adds its own stand-ins in `test/lynkeus_host.dart`, which `lynkeus headless start` passes on:

```dart title="test/lynkeus_host.dart"
import 'package:lynkeus_headless/lynkeus_headless.dart';

void configureHost(HostConfig host) {
  host.standIns.add('com.example/wallet', (method, args) => method == 'balance' ? 1250 : null);
  host.plugins.preferences['flutter.onboarded'] = true;
}
```

## Limits today

- **Debug builds only.** A release build carries no agent. See [Security](/security/).
- **Headless sees the machine.** `Platform` answers for it and `DateTime.now()` reads the real clock; only `package:clock` is virtual. An app that branches on `Platform.isMacOS` takes its desktop path on a Mac, though `defaultTargetPlatform` and the screen are the phone's; `device_info_plus` answers that path's fields too, and a desktop-only channel answers null. Code behind `Platform.isAndroid` or `Platform.isIOS` never runs headless, whichever look the host plays: Rain schedules its widgets' work and picks a display mode only there.
- **`--seed` has no effect** on the headless host: Dart's `Random()` cannot be seeded from outside.
- **`--host-heap` restarts are skipped.** The Dart VM gives a running program no heap figures.
- **The route graph reads syntax, not types.** A route table built at runtime, a builder passed through more than a few helpers, or a widget wrapped in a router-specific page class may not resolve; `map build` says so with a warning. A page pushed without a name is reached by pressing what opens it, so a crawl cannot jump back into it, and a helper that takes the page as a closure (`NavigationHelper.open(context, () => PlaceInfo())`) is not followed.
- **`crawl` knows a screen by its route.** Tabs that change nothing but the body (a `NavigationBar` over a `TabBarView`) are one route, `/`, so their controls are pressed once from wherever the crawl stands, not explored as screens.
- **Lynkeus FastSim** has limits of its own; see [its section](#lynkeus-fastsim).
- **Two apps cannot dial the same port.** Close the other one, or give one its own with `LYNKEUS_PORT`.

## Tested against real apps

The cases in `flutter/validation/` of the repository were run against three open-source apps, which are not committed there: [flutter_deer](https://github.com/simplezhli/flutter_deer) (Apache-2.0, by simplezhli, 9 cases), [mhabit](https://github.com/FriesI23/mhabit) (Apache-2.0, by FriesI23, 10) and [Rain](https://github.com/darkmoonight/Rain) (MIT, by darkmoonight, 10). All of them pass on the headless host (flutter_deer's first eight cases) and, on a Mac, on FastSim with both looks (the Android look's pixels are the Linux host's); flutter_deer's first eight also pass on an iOS Simulator and an Android emulator, while mhabit's and Rain's have not been run on a Simulator or emulator yet. mhabit's own binding passes 10 of 10 on both looks once it extends `LynkeusBinding`; left as it is, 10 of 10 on the iOS look and 9 of 10 on the Android look. Pixel comparisons against a Simulator and an emulator were made on flutter_deer and on the sample app only. [VALIDATION.md](https://github.com/lynkeushq/lynkeus/blob/main/flutter/VALIDATION.md) has the cases, the figures and what the runs found. Rain's data comes from Open-Meteo (CC BY 4.0, free for non-commercial use) and OpenStreetMap (ODbL, with a tile policy that rules out sharing recordings of its tiles).

## Third-party software and trademarks

The Dart packages are MIT licensed, and what they depend on is BSD or Apache licensed. Flutter and Dart are trademarks of Google LLC. Lynkeus is not affiliated with or endorsed by Google.

# Lynkeus for Flutter

- `lynkeus_agent/`: the in-app agent, a Dart package. It dials the Lynkeus driver from a debug build, proves the
  project's token, and answers the [protocol](../docs/PROTOCOL.md) from the live widget tree: what the screen shows,
  real touches through Flutter's gesture system, typing through its text input. Release builds leave it out.
- `lynkeus_headless/`: hosts the app inside `flutter test`, with no simulator: `lynkeus case run --host` in a Flutter
  project.
- `sample/`: a small app (iOS and Android) and the cases in `sample/cases/` that run against it.
- `validation/`: cases for a real open-source app, and what running them found ([VALIDATION.md](VALIDATION.md)).

## Add the agent to an app

```yaml
# pubspec.yaml
dependencies:
  lynkeus_agent:
    path: ../lynkeus_agent   # until it is published
```

```dart
import 'package:lynkeus_agent/lynkeus_agent.dart';

void main() {
  LynkeusAgent.start();
  runApp(const MyApp());
}
```

Build with the project's token, which `lynkeus init` writes to `.lynkeus/token`:

```sh
flutter run --dart-define=LYNKEUS_TOKEN=$(cat .lynkeus/token)
```

A widget with a `ValueKey<String>` (or `Key('...')`) or a `Semantics(identifier: ...)` is found by that test id
(`#increment`). `LYNKEUS_HOST` and `LYNKEUS_PORT` (also `--dart-define`) change where it dials; by default
`127.0.0.1:8123`, and on Android `10.0.2.2` then `127.0.0.1`. `LynkeusAgent.register('reset', ...)` adds a command a
case can call (`app.call: { command: reset }`).

## Run the sample's cases

From `flutter/sample/`, with a token in `.lynkeus/token` (`openssl rand -hex 24 > .lynkeus/token` if there is none):

```sh
flutter pub get
# iOS Simulator
flutter build ios --simulator --debug --dart-define=LYNKEUS_TOKEN=$(cat .lynkeus/token)
xcrun simctl install <device> build/ios/iphonesimulator/Runner.app
xcrun simctl launch <device> io.lynkeus.lynkeusSample
# Android emulator
flutter build apk --debug --dart-define=LYNKEUS_TOKEN=$(cat .lynkeus/token)
adb -s <serial> install -r build/app/outputs/flutter-apk/app-debug.apk
adb -s <serial> shell am start -n io.lynkeus.lynkeus_sample/.MainActivity

npx lynkeus case run --device <device>
```

`flutter run` with the same `--dart-define` works too. Both cases start with `reset`, so they run in any order on one
launch of the app.

With no simulator at all, from `flutter/sample/`:

```sh
npx lynkeus case run --host
```

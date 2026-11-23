# lynkeus_headless

Runs a Flutter app inside `flutter test` as a Lynkeus host: the app's own `main()`, real layout and software paint,
no simulator. The app's lynkeus_agent dials the driver as it does on a device, so `lynkeus case run --host` and every
command in docs/DRIVE.md work unchanged.

```yaml
# pubspec.yaml of the app
dev_dependencies:
  lynkeus_headless:
    path: ../lynkeus_headless   # until it is published
```

```sh
npx lynkeus headless start      # writes .lynkeus/host/lynkeus_host_test.dart and runs it with flutter test
npx lynkeus case run --host     # starts that host for the run and stops it after
```

The host file lives under `.lynkeus/host/`, not `test/`: a host never ends, and the app's own `flutter test` would
pick it up with its unit tests and hang. The CLI finds Flutter through `FLUTTER_ROOT`, `flutter` on `PATH`, or
`mise which flutter`.

## Time

The app runs in flutter_test's fake time, so the host owns the clock. While the driver waits on the app (a request
of the driver is being served) and no request of the app is out, every turn moves the clock a whole frame at once: a
three second countdown passes in a few hundred milliseconds of the wall's. Otherwise the clock keeps the wall's pace,
so an idle host costs nothing and a real backend's latency stays real. `lynkeus os clock` drives it by hand:
`--advance <ms>` runs every frame and timer inside those milliseconds, `--settle` pumps frames without moving time
until none is scheduled, `--now` and `--reset` move what the app's clock answers.

The app's clock is `package:clock` (`clock.now()`, which flutter_test fakes): `DateTime.now()` reads the wall in any
widget test, so a screen that computes a countdown from `DateTime.now()` sees real seconds.

The driver's socket is real I/O, and a widget test's body only moves when it is pumped. The host keeps the test
binding (text input, assets, views) and runs its own loop in the test body: it yields to the real event loop with
`runAsync` (socket messages, font loads, PNG encoding arrive there), then pumps one frame of fake time. A
`LiveTestWidgetsFlutterBinding` would make the socket easy and lose the clock.

## Launch facts and screen

`lynkeus case run --host` passes `--locale`, `--time-zone` and `--epoch` on: the platform locale, `TZ` for
`DateTime`'s local time, and where the app's clock starts. `--seed` has no effect: Dart's `Random()` cannot be seeded
from outside. The host plays an iPhone-sized iOS device (402x874 points at 3x, with its safe-area insets) unless
`lynkeus.config.json` says otherwise:

```json
{ "flutterHost": { "platform": "android", "window": "412x915@2.625", "networkHosts": ["127.0.0.1", "api.local"] } }
```

## Commands the host adds

- `clock`: `{ now?, advanceMs?, settle?, reset? }`, as above.
- `screenshot`: `{ path }` writes the screen as PNG at the device's pixel size. The app's fonts (its FontManifest),
  Roboto under the system families (Material on iOS asks for San Francisco) and MaterialIcons are loaded first, so
  text is legible rather than flutter_test's boxes.
- `appstate`: `{ state: active | inactive | background }` as the OS would send it, through each state in between.
- `deeplink`: `{ url }`, as the engine delivers a link the OS opened.
- `memory`: the process's resident size. The Dart VM gives a running program no heap figures, so `--host-heap`
  restarts do not apply to this host.
- `exit`: ends the host.

## Remote fetches

The host stays off the internet (`networkHosts`), so a network image draws as its placeholder where a device shows
the picture. Record what the app fetches on a run where the network is real, and the hosts answer from it:

```sh
npx lynkeus case run --device <simulator> --net-cache qa/net --net-record   # records each successful remote GET
npx lynkeus case run --host --net-cache qa/net                               # replays what the fence would block
```

The folder is the React Native host's `--net_cache`: one file per URL (the first 16 bytes of its SHA-256, in hex)
holding the body as the app read it, and `<name>.json` with the URL, the status and a few headers (`content-type`,
`cache-control`, `expires`, `etag`, `last-modified`, `date`). Only GETs that answered 2xx are recorded, and none that
sent an `Authorization` header or cookies unless `--net-record-credentials` says so. A replayed answer is listed in
`requests` as `replayed`; `netmock` still answers first. WebSockets, streamed bodies and anything but GET are not
recorded.

## Plugins

flutter_test leaves platform channels unanswered: a plugin's method channel throws `MissingPluginException`, a
Pigeon one fails to connect. The host answers every channel. These plugins have stand-ins that keep their state in
memory for the run, answering the channels their platform interfaces fall back to under `flutter test`. They
live in lynkeus_agent (`package:lynkeus_agent/hosts.dart`), which answers the same way inside Lynkeus FastSim:

| Plugin | Stand-in | Driven by |
|---|---|---|
| shared_preferences | a key-value map | the app |
| flutter_secure_storage | a key-value map | the app |
| path_provider | folders under a temporary folder per run | |
| device_info_plus, package_info_plus | an iPhone 17 on iOS 26.5, or an Android 15 emulator, as the host plays | |
| url_launcher | answers that it can open a URL, opens nothing, writes it down | `lynkeus call launched` (`{ clear: true }` empties it) |
| local_auth | a sensor with Face ID enrolled (a fingerprint on Android); prompts succeed | `lynkeus os biometrics --available none\|face\|fingerprint --next success\|fail\|cancel\|<error code>` |
| permission_handler | every permission granted | `lynkeus call permissions '{"7": 4}'` (permission number to status) |
| connectivity_plus | Wi-Fi | `lynkeus call network '{"state": "off"}'` |
| sqflite | the system's SQLite (libsqlite3), databases in a folder of the run | the app |

Any other channel gets an empty success (null), so the app's await never hangs, and one `[stub] <channel>` line in
the host's log. `LYNKEUS_CHANNELS=trace` prints every call and its answer.

Two of these plugins never reach their channel unless the app also depends on `lynkeus_plugins` and calls
`LynkeusPlugins.ensureInitialized()` on the line after `LynkeusAgent.start()`: sqflite 2.4 (and with it
cached_network_image, whose cache is a sqflite database) and shared_preferences' `SharedPreferencesAsync` and
`SharedPreferencesWithCache`. Their platform interfaces have no method-channel default, and the registrant that would
set one does not run on a host. Native views (UiKitView, AndroidView, and so web views) stay blank on any host.

A project adds its own in `test/lynkeus_host.dart` (not a `_test.dart` file, so its unit tests leave it alone);
`lynkeus headless start` passes it on when it is there:

```dart
import 'package:lynkeus_headless/lynkeus_headless.dart';

void configureHost(HostConfig host) {
  host.standIns.add('com.example/wallet', (method, args) => method == 'balance' ? 1250 : null);
  host.standIns.add('dev.flutter.pigeon.wallet.WalletApi', (method, args) => null); // a Pigeon API, by name
  host.plugins.preferences['flutter.onboarded'] = true;
}
```

## Network

flutter_test answers every request with a 400 of its own. The host replaces it with the real `HttpClient`, fenced to
`networkHosts` (loopback and 10.0.2.2 by default): a request to any other host fails as a socket error. The agent's
`netmock` rules sit in front of it.

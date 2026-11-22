# Flutter: validation against a real app

The Flutter agent (`lynkeus_agent`) and the headless host (`lynkeus_headless`) were run against
[flutter_deer](https://github.com/simplezhli/flutter_deer) (Apache-2.0), a merchant app with about forty screens,
common plugins (shared_preferences through sp_util, url_launcher, dio, cached_network_image, image_picker, webview,
fluro routing, provider) and local mock data. The app is not committed here; its cases are, in
`validation/flutter_deer/cases/`.

- App: `simplezhli/flutter_deer` at `7b86fd00560c5001378396433d3a95dee3119116` (2026-11-15), Flutter 3.50.1. It
  resolved and analyzed with no change.
- Simulator: iPhone 17, iOS 26.5. Emulator: the `fastsim-e2e-android` AVD, Android 15, arm64.
- Agent: this stack plus the four fixes below (#159–#162).

## Reproduce

```sh
git clone https://github.com/simplezhli/flutter_deer && cd flutter_deer
npx lynkeus init        # adds lynkeus_agent and LynkeusAgent.start() to lib/main.dart, makes .lynkeus/token
```

Until the agent is on main, the git dependency `init` writes does not resolve: point it at a checkout instead, and
add the host for headless runs.

```yaml
dependency_overrides:
  lynkeus_agent:
    path: <lynkeus>/flutter/lynkeus_agent
dev_dependencies:
  lynkeus_headless:
    path: <lynkeus>/flutter/lynkeus_headless
```

```json
// lynkeus.config.json in the clone
{ "cases": { "dir": "<lynkeus>/flutter/validation/flutter_deer/cases" } }
```

```sh
# iOS Simulator
flutter build ios --simulator --debug --dart-define=LYNKEUS_TOKEN=$(cat .lynkeus/token) --dart-define=LYNKEUS_PORT=8141
xcrun simctl install <device> build/ios/iphonesimulator/Runner.app && xcrun simctl launch <device> com.weilu.flutterDeer
LYNKEUS_PORT=8141 npx lynkeus case run --device <device>
# Android emulator (unlocked)
flutter build apk --debug --dart-define=LYNKEUS_TOKEN=$(cat .lynkeus/token) --dart-define=LYNKEUS_PORT=8141
adb -s <serial> install -r build/app/outputs/flutter-apk/app-debug.apk && adb -s <serial> shell am start -n com.weilu.deer/.MainActivity
LYNKEUS_PORT=8141 npx lynkeus case run --device <serial>
# Headless
LYNKEUS_PORT=8142 FLUTTER_ROOT=<flutter sdk> npx lynkeus case run --host
```

The cases reach their screens with deep links (`app.deeplink: "/setting"`), which the agent delivers as the engine
does (`pushRouteInformation`), so they run in any order on one launch of the app.

## Results

Steps passed and seconds per case, after the fixes. iOS and headless are the last of two and three full runs, all
8/8; Android is a single run.

| Case | What it covers | iOS Simulator | Android emulator | Headless |
|---|---|---|---|---|
| 01-login | form validation, obscured field, eye toggle | 12/12, 5.5 s | 12/12, 9.1 s | 12/12, 1.6 s |
| 02-store-audit | typing, bottom-sheet picker, submit | 11/11, 3.3 s | 11/11, 3.5 s | 11/11, 1.1 s |
| 03-orders | tabs, a 30-row list that loads more, pull to refresh | 9/9, 35.2 s | 9/9, 21.5 s | 9/9, 2.6 s |
| 04-order-search | typing, submit, toast, the search API mocked through dio | 9/9, 2.1 s | 9/9, 4.3 s | 9/9, 0.8 s |
| 05-settings | a theme setting, three levels deep and back, a dialog | 23/23, 6.3 s | 23/23, 6.4 s | 23/23, 2.5 s |
| 06-shop-setting | a switch, a bottom-sheet choice, a text page | 15/15, 3.8 s | 15/15, 4.1 s | 15/15, 1.6 s |
| 07-statistics | a calendar switched between views, expand and collapse | 13/13, 3.3 s | 13/13, 3.4 s | 13/13, 1.6 s |
| 08-goods | a list with images, an item menu, a delete confirmed, a popup menu | 12/12, 6.7 s | 12/12, 7.7 s | 12/12, 1.6 s |
| All | | 104/104, 66 s wall | 104/104, 60 s wall | 104/104, 16–23 s wall with the host's start |

The headless run is 3–13 times faster: the app's own waits (a 2 s page load, the 3 s list-end wait) pass in virtual
time. Before the fixes, the first iOS run passed 3 of 8; the rest of the failures were the cases' own wrong guesses
about labels, corrected against the app.

Also checked: `screen` costs 0–4 ms per read on the simulator (debug build) with 8,166 elements in the tree, 676 of
them onstage and 16–44 listed. The headless host stubbed one channel, `window_manager`, and logged no app error.

The sample's own cases were also run where they had not been: all three on the Android emulator (the settings case
needed the sample's manifest to declare an https query, added in #156), and on two headless hosts at once
(`--jobs 2 --ports 8150,8151 --host-command "LYNKEUS_PORT={port} lynkeus headless start"`): 3/3 in 7–12 s wall, three
runs, and with `--keep-hosts`.

## Lynkeus FastSim

The same eight cases, and the sample's three, on the Flutter FastSim host: the app's debug kernel in Flutter's own
engine on the Mac, with the iOS look (an iPhone 17), on a clock the host moves. Nothing here is merged: this is a
local combination of draft branches, built and run on one Mac (Apple Silicon, Flutter 3.50.1, engine
`4d35714800b9266b6693a58e1225ecd7e9e45ed7`).

- lynkeus, branch `local/deer-fastsim` at `55d0e63` (not pushed): this stack (#149–#153, #155, #156) with the fixes
  #159–#162, the FastSim agent work #166, #168–#172 and the press fix #173. The CLI was built from the same tree.
- fastsim, `dev/flutter-pixel-compare` at `2abbd79` (#83), which holds the host stack #79 (core), #80 (kit), #81
  (commands), #82 (lifecycle) and #84 (the plugin registrant skipped). An unlicensed local build (`cmake -S
  host-flutter -B build -G Ninja`), laid out as the kit: `bin/fastsim-run`, `bin/fastsim-bundle`,
  `bin/fastsim-flutter-host`, its interpose library and `bin/fastsim-flutter-engine`.
- flutter_deer as above, with two lines changed in `lib/main.dart`: `LynkeusAgent.start()` moved before the app's
  `WidgetsFlutterBinding.ensureInitialized()` (the FastSim binding has to be the agent's), and
  `LynkeusPlugins.ensureInitialized()` after it, with `lynkeus_plugins` added to `dependencies` (#171; flutter_deer's
  images cache through sqflite).

```sh
<kit>/bin/fastsim-bundle <app> <bundle> ios -- --dart-define=LYNKEUS_TOKEN=$(cat <app>/.lynkeus/token)
npx lynkeus case run --ports 8232 --host-command "<kit>/bin/fastsim-run <bundle> {port}"
```

Bundling took 8 s (the sample) and 11 s (flutter_deer). Seconds per case are the median of three full runs, all
passing; the Simulator and headless columns are the runs above, made before the FastSim work.

| Case | iOS Simulator | Headless | FastSim (iOS look) |
|---|---|---|---|
| 01-login | 12/12, 5.5 s | 12/12, 1.6 s | 12/12, 1.3 s |
| 02-store-audit | 11/11, 3.3 s | 11/11, 1.1 s | 11/11, 1.3 s |
| 03-orders | 9/9, 35.2 s | 9/9, 2.6 s | 9/9, 8.8 s |
| 04-order-search | 9/9, 2.1 s | 9/9, 0.8 s | 9/9, 1.1 s |
| 05-settings | 23/23, 6.3 s | 23/23, 2.5 s | 23/23, 2.6 s |
| 06-shop-setting | 15/15, 3.8 s | 15/15, 1.6 s | 15/15, 1.4 s |
| 07-statistics | 13/13, 3.3 s | 13/13, 1.6 s | 13/13, 1.2 s |
| 08-goods | 12/12, 6.7 s | 12/12, 1.6 s | 12/12, 3.4 s |
| All | 104/104, 66 s wall | 104/104, 16–23 s wall | 104/104, 26–29 s wall with eight host starts |

The sample on the same host: 3/3 in all three runs, 5–6 s wall; list-and-dialog 16/16 in 1.9 s, resend-code 10/10 in
0.7 s (its 3 s countdown passes on the host's clock), settings 15/15 in 1.1 s. On the Simulator the same cases took
7.3, 4.9 and 3.3 s.

FastSim runs one host per case, so its wall time includes eight engine starts; headless keeps one host for the run.
Where a case waits on the app's timers (the orders list's page loads, the goods list), FastSim lands between the two;
where it only drives, it matches headless.

The Android look (a Pixel 9) runs on the Linux host, in the Lima VM. Those figures are the host owner's: before
#172 the sample passed 3/3 and flutter_deer 6/8. Settings and shop-setting failed on a `device_info_plus` answer
that the Android model could not parse; with #172, on the Mac's engine with the Android look, flutter_deer passed 8/8.
The rerun on Linux waits for the host's font fallback, which still draws Chinese text as boxes there (the cases pass;
the pixels would not).

`04-order-search` failed once in a full Simulator run before #173: the home page under it opens a loading dialog,
which can land on the search page between `see` and `press`. With #173, on the Simulator: 15/15 alone and two full
runs 8/8 (14/15 and one 7/8 run before). On FastSim, 15/15 both before and after the fix: the host's clock does not
leave that window open.

## Gaps

Found and fixed, each in its own draft PR with a regression test:

- #159: rows of a scrolled list and a settled swiper read `inert`, because the agent read `IgnorePointer`'s widget,
  which a Scrollable leaves stale. Scroll-to-find then dragged the wrong scroller.
- #160: an image request whose body the app never read stayed in flight, so the screen was busy for good and every
  `idle` waited 5.1 s.
- #161: `deepLink` and `back` answered before a frame showed the new route; the next step read the old page.
- #162: scroll-to-find took a list loading its next page for the list's end, turned around and set off pull to
  refresh. Its widget test does not reproduce the failure; the device did, before and after.
- #163 (CLI, from main): an app of the other platform than `--device` is refused. An iOS app answered an Android run.
- #156: the sample's Android manifest now declares the https query `canLaunchUrl` needs.

Open:

- iOS 26 native views. On iOS 26 flutter_deer puts its bottom tab bar in a native UITabBar (`adaptive_platform_ui`,
  a platform view). The in-app agent cannot read it, and Flutter pointer events do not reach UIKit, so it cannot tap
  it either. The cases reach the other tabs' screens by deep link. On Android and headless the app uses Flutter's
  BottomNavigationBar and the tabs are ordinary buttons.
- No `selected` state. The protocol has none, so a month picked in the statistics calendar, which only changes its
  highlight, cannot be asserted.
- Inputs with only a hint. Fields with no key and no label (the change-password form) are reachable only by index,
  since targets match text and labels, not placeholders, as in the React Native agent. Matching an input by its
  placeholder would be a change for both agents.
- A key on a composite field. flutter_deer's `MyTextField(key: 'phone')` wraps the TextField with its own buttons,
  so `#phone` names a view, and the input inside has no test id. Typing into `#phone` works (the press lands on the
  field), but its `value` is not on `#phone`.
- Platform under `flutter test`. `Platform.isIOS` and friends read the machine running the tests: headless,
  flutter_deer took its macOS desktop path (`window_manager`, answered by a stub). The UI was the same for every
  case here.
- `lynkeus screenshot` without `--device` captures the first booted simulator, not necessarily the app's. #163 does
  not catch a second device of the same platform.
- `--seed` does not reach a Flutter app (Dart's `Random()` cannot be seeded from outside), headless or not.
- Unlabeled images are not listed, as in the React Native agent. Headless, network images are blocked by the network
  fence and draw as their placeholders.
- `lynkeus init` (#154), as a customer meets it:
  - the git dependency does not resolve until the agent is on main;
  - the import is appended after the app's relative imports;
  - `LynkeusAgent.start()` is written without an app name, so the CLI calls the app "(ios)";
  - it says nothing about `lynkeus_headless` for `--host`;
  - a project whose `dev_dependencies` carry comments needs the host added by hand.
- Not exercised: focus traversal with the keyboard's next action, the webview and the image picker, and a phone over
  USB.

# Flutter: validation against real apps

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

- lynkeus, branch `local/deer-fastsim` at `883709d` (not pushed): this stack (#149–#153, #155, #156) with the fixes
  #159–#162, the FastSim agent work #166, #168–#172 and #177, the press and swipe fixes #173 and #178, and the
  record and replay of remote fetches (`dev/flutter-net-cache`, not turned on here). The CLI was built from the same
  tree.
- fastsim, `dev/flutter-check-hooks` at `0da0975`, the top of the host stack: #79 (core), #84 (the plugin registrant
  skipped), #87 (font fallback on Linux), #80 (kit), #81 (commands), #82 (lifecycle), #83, #85 (frames read only
  when looked at, and no run-ahead time counted twice) and #86. An unlicensed local build (`cmake -S host-flutter -B
  host-flutter/build -G Ninja`), laid out as the kit by `hack/flutter/make-kit.sh`.
- flutter_deer as above, with two lines changed in `lib/main.dart`: `LynkeusAgent.start()` moved before the app's
  `WidgetsFlutterBinding.ensureInitialized()` (the FastSim binding has to be the agent's), and
  `LynkeusPlugins.ensureInitialized()` after it, with `lynkeus_plugins` added to `dependencies` (#171; flutter_deer's
  images cache through sqflite).

```sh
<kit>/bin/fastsim-bundle <app> <bundle> ios -- --dart-define=LYNKEUS_TOKEN=$(cat <app>/.lynkeus/token)
npx lynkeus case run --ports 8232 --host-command "<kit>/bin/fastsim-run <bundle> {port}"
```

Seconds per case are the median of three full runs, all passing; the Simulator and headless columns are the runs
above, made before the FastSim work. `03-orders` has one step more than there: the mock described below.

| Case | iOS Simulator | Headless | FastSim (iOS look) |
|---|---|---|---|
| 01-login | 12/12, 5.5 s | 12/12, 1.6 s | 12/12, 0.8 s |
| 02-store-audit | 11/11, 3.3 s | 11/11, 1.1 s | 11/11, 0.8 s |
| 03-orders | 9/9, 35.2 s | 9/9, 2.6 s | 10/10, 2.8 s |
| 04-order-search | 9/9, 2.1 s | 9/9, 0.8 s | 9/9, 0.5 s |
| 05-settings | 23/23, 6.3 s | 23/23, 2.5 s | 23/23, 1.4 s |
| 06-shop-setting | 15/15, 3.8 s | 15/15, 1.6 s | 15/15, 0.8 s |
| 07-statistics | 13/13, 3.3 s | 13/13, 1.6 s | 13/13, 0.7 s |
| 08-goods | 12/12, 6.7 s | 12/12, 1.6 s | 12/12, 0.9 s |
| All | 104/104, 66 s wall | 104/104, 16–23 s wall | 105/105, 13–15 s wall with eight host starts |

The sample on the same host: 3/3 in all three runs, 3–6 s wall; list-and-dialog 16/16 in 0.9 s, resend-code 10/10
in 0.5 s (its 3 s countdown passes on the host's clock), settings 15/15 in 0.5 s. On the Simulator the same cases
took 7.3, 4.9 and 3.3 s.

`03-orders` swipes three times and needs the scroll each swipe starts to stop before the next: on the Simulator the
real time between two commands covers it, on the host's clock it does not. #178 makes `swipe` answer once its scroll
has stopped; before it, with #85 on the host, the case failed every run (0/4), after it 6/6.

The Android look (a Pixel 9) runs on the Linux host, in the Lima VM. Those figures are the host owner's: before #172
the sample passed 3/3 and flutter_deer 6/8; settings and shop-setting failed on a `device_info_plus` answer the
Android model could not parse. With #172, on the Mac's engine with the Android look, flutter_deer passed 8/8. The
Linux rerun with #87, which draws Chinese text there, is the host owner's to report.

FastSim fences the app's network as headless does (#177): requests go only to `flutterHost.networkHosts`
(loopback by default), and anything else fails at once and is listed in `requests`. Without a fence the host had
called the real GitHub API, whose rate-limit toast showed in the frames. `03-orders` now mocks the one request the home
page makes (`GET /users/simplezhli`, from the shop tab it builds), so no run depends on the internet. The goods list's
pictures come from image hosts outside the fence and draw as the app's placeholders on the hosts, while a device
loads them, unless the run replays a recording of them (`dev/flutter-net-cache`).

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

# Second app: mhabit

[mhabit](https://github.com/FriesI23/mhabit) (Table Habit, by FriesI23, Apache-2.0) is a habit tracker: a habits
table with check-in cells, detail pages with fl_chart charts and a heatmap, groups and sorting, reminders, theme,
date format and 24 languages, JSON export and import, and a WebDAV sync editor. It is fully offline and uses go_router,
provider, sqflite, shared_preferences, flutter_secure_storage, flutter_local_notifications, flutter_timezone,
home_widget, share_plus, file_selector, open_file, app_settings, path_provider, url_launcher, device_info_plus,
package_info_plus, connectivity_plus and dynamic_color. The app is not committed here; its cases are, in
`validation/mhabit/cases/`.

- App: `FriesI23/mhabit` at `44df07b9d318165a2129eab59062bf20888312e4` (2026-11-23), Flutter 3.47.9 (its pinned
  version; the clone's `.flutter` submodule was not used). It resolved with no change.
- Headless only so far: the iOS look (the host's default) and the Android look (`"flutterHost": { "platform":
  "android", "window": "412x915@2.625" }`). The Simulator, emulator and FastSim runs are still to do (below).

## Wiring it, as the docs say

`lynkeus init --headless` in the clone, then the `dependency_overrides` of the first app's section (the git
dependencies do not resolve until the packages are on main or pub.dev), and `lynkeus.config.json` pointing at the
cases. `lynkeus init` found sqflite 2.4 and shared_preferences' async API in the lock and added `lynkeus_plugins`.

What the app needed changed, beside the dependencies:

- `lib/main.dart`: the two lines `init` writes, `LynkeusAgent.start(app: {'name': 'mhabit'})` and
  `LynkeusPlugins.ensureInitialized()`, at the top of `main()`. Before the fix below, `init` put them in
  `habitWidgetBackgroundMain()`, a background entry point above `main()`.
- `lib/pages/common/_widgets/habit_summary_list_tile.dart`: `key: ValueKey('habit-record-$index')` on each check-in
  cell. The cell is an icon with no label, and its state is only the icon, so a case finds today's cell as
  `#habit-record-0` nearest the habit's name and reads the effect on the habit's page (records, grade).

Nothing else: no reset command, no route wiring. The app builds its `GoRouter` inside a widget's state, where the
docs' `LynkeusRoutes` example (a router in a global, given to `start()`) does not reach, so routes read `?` and the
cases go by what a person presses. Deep links were tried and left out: `/settings` then `/habits` left the home page
without its bottom bar.

## Results

Steps passed and seconds per case, headless, the last of two full runs on iOS and three on Android, all 10/10
(`case run --host --once`). The Android look skips different steps: where the two looks differ (the settings
button, an unlabeled control's index, a menu where iOS has buttons), a case has an `on: ios` and an `on: android`
branch, and the steps that read a stand-in's command run under `on: has:...`.

| Case | What it covers | iOS look | Android look |
|---|---|---|---|
| 01-create-habit | the form, a goal and a unit, the habit's page | 11/11, 3.7 s | 11/11, 3.3 s |
| 02-check-in-undo | a check-in cell through its four states, the record count and grade | 19/19, 4.3 s | 19/19, 3.9 s |
| 03-habit-detail | heatmap, score chart by week, frequency chart by year | 19/19, 4.0 s | 19/19, 4.5 s |
| 04-edit-archive | rename, archive with a dialog, the archived filter, unarchive | 31/31, 8.0 s | 31/31, 7.4 s |
| 05-groups-sorting | a group in a sheet, a habit in it, grouped and sorted table, a delete undone | 54/54, 16.2 s | 53/53, 13.5 s |
| 06-reminder | the time picker, the notification flutter_local_notifications schedules and cancels | 24/24, 4.9 s | 24/24, 4.6 s |
| 07-settings | theme, a custom date format, Spanish and back | 42/42, 7.9 s | 46/46, 8.2 s |
| 08-export-import | export through share_plus, import the file through file_selector | 29/29, 7.0 s | 28/28, 5.2 s |
| 09-sync-server | the WebDAV editor, its password in secure storage, read back | 35/35, 5.4 s | 33/33, 4.3 s |
| 10-about-changelog | About, a link through url_launcher, the changelog, the license | 24/24, 3.6 s | 23/23, 3.1 s |
| All | | 288/288, 66–70 s wall | 283/283, 62–63 s wall |

The wall time includes the host's start (compiling the app under `flutter test`, about 15 s). The app logged one
error of its own on the Android look, `Looking up a deactivated widget's ancestor is unsafe`, with no effect on a
case.

## What it found

Fixed, each with a test:

- `lynkeus init` took the first `ensureInitialized()` in `lib/main.dart`, in a background entry point; and in
  `main()` the binding is picked in an `if` (a custom `FixedIos26FlutterBinding` on iOS). It now starts the agent in
  `main()`, before the whole `if`.
- Stand-ins for flutter_local_notifications (`lynkeus call notifications`, with the scheduled time of day),
  flutter_timezone, share_plus (`shared`), file_selector (`files`), open_file and app_settings (written down with
  `launched`) and dynamic_color. flutter_local_notifications has no method-channel default: before runApp the app
  died on a `LateInitializationError`; the headless host file now registers its iOS or Android class.
- `Platform.isMacOS` is true under `flutter test` on a Mac, so mhabit took its desktop path (`macOsInfo`, a desktop
  window chrome over Pigeon) with an iPhone or a Pixel on screen. device_info's answers carry the macOS fields, which
  the app parsed as nulls before (`type 'Null' is not a subtype of type 'String'`, a blank screen).
- Package icon fonts (CupertinoIcons) were loaded under their bare name and drew as boxes in screenshots.
- The agent read a Cupertino-style menu (an `OverlayPortal` built inside its button) as the button's text; it lists
  the items apart now. A tap handler around a disabled `IconButton` (the check-in cell) was listed as a disabled
  button though a tap works.
- Scroll-to-find (`wait --scroll`) flung the settings list more than a window per swipe, past rows being built; never
  turned back at the list's end while the support card's stars animated; and stopped with a row cut by the bottom
  edge, which a case's next press then scrolled away. Swipes now hold still before lifting, the end is read from the
  scroll offsets, and the row has to be wholly in.
- The changelog is markdown_widget, whose lists are `Text.rich` of widget spans: the agent listed empty texts.

Friction left in the cases, each said where it happens:

- Inputs with only a hint (the goal, the unit, Android's habit and group name) are reached by index or by typing into
  the focused field, as in flutter_deer. Indexes differ between the looks, so those steps branch.
- A capitalized word alone (`Delete`, `About`, `Week`) is read as a route in `wait` and `see`, the React Native
  convention; the cases quote it (`'"About"'`).
- mhabit's undo snackbars never close by themselves (since Flutter 3.47 an action makes a SnackBar persist): the
  deleted habit stays in the list, struck through, and on the Android look the snackbar covers the New Habit button.
  The cases swipe it away after each delete.
- After a submenu choice the Cupertino menu closes itself, and a press on its button while it fades does not open it
  again; the cases wait for it to go.
- Typed key by key into the Android look's time picker, 45 became 40; pasted, it is 45.

Stubs left answering empty: `foldable/methods` and `global.app.animation/scale_stream` (the app's own channels) and
`home_widget setAppGroupId` (home_widget's only call at start). None needs a stand-in for these cases.

Docs: the Flutter page's go_router example assumes a router in a global; `init --headless` and the new stand-ins
were not on the Flutter page (added); `lynkeus headless start --help` and the CLI's banner still describe React
Native (jest, RNTL); the case reference says `qa.register` where a Flutter app uses `LynkeusAgent.register`.

## Still to run

The same ten cases on an iOS Simulator, an Android emulator and Lynkeus FastSim, from the clone, with the cases'
`on: has:...` steps skipped on the devices:

```sh
cd ~/code/lynkeus/flutter-apps/mhabit
# iOS Simulator
flutter build ios --simulator --debug --dart-define=LYNKEUS_TOKEN=$(cat .lynkeus/token) --dart-define=LYNKEUS_PORT=8143
xcrun simctl install <device> build/ios/iphonesimulator/Runner.app && xcrun simctl launch <device> io.github.friesi23.mhabit
LYNKEUS_PORT=8143 npx lynkeus case run --device <device>
# Android emulator (unlocked)
flutter build apk --debug --dart-define=LYNKEUS_TOKEN=$(cat .lynkeus/token) --dart-define=LYNKEUS_PORT=8143
adb -s <serial> install -r build/app/outputs/flutter-apk/app-debug.apk   # the default flavor, f_generic
adb -s <serial> shell am start -n io.github.friesi23.mhabit/.MainActivity
LYNKEUS_PORT=8143 npx lynkeus case run --device <serial>
# FastSim
<kit>/bin/fastsim-bundle . <bundle> ios -- --dart-define=LYNKEUS_TOKEN=$(cat .lynkeus/token)
npx lynkeus case run --ports 8232 --host-command "<kit>/bin/fastsim-run <bundle> {port}"
```

On FastSim `Platform.isIOS` is true, so `main()` runs `FixedIos26FlutterBinding.ensureInitialized()` after the agent
has made its binding, which a debug build refuses (a binding cannot be replaced); and flutter_local_notifications
has no registration there (the headless host file does it). Both are expected to need work before the FastSim run.

# Third app: Rain

[Rain](https://github.com/darkmoonight/Rain) (by darkmoonight, MIT) is a weather app: onboarding, a city picked by
search, by GPS or on a map, an hourly strip and a 12-day forecast, air quality, saved cities that reorder and swipe
away, a map tab, units, themes and 40 languages. It uses go_router 18 (its router built inside a Riverpod provider),
flutter_riverpod 3, isar_community (a database over `dart:ffi`), dio, dio_cache_interceptor and flutter_map_cache,
flutter_map with OpenStreetMap tiles, geolocator, geocoding 5, flutter_timezone, flutter_local_notifications,
workmanager, home_widget, dynamic_color, connectivity_plus with internet_connection_checker_plus, google_fonts,
url_launcher, device_info_plus, package_info_plus, restart_app and flutter_displaymode. Its data comes from
[Open-Meteo](https://open-meteo.com/) (forecast, air quality, city search) and
[OpenStreetMap](https://www.openstreetmap.org/copyright) (map tiles, Nominatim's reverse geocoding), with no key. The
app is not committed here; its cases are, in `validation/rain/cases/`.

- App: `darkmoonight/Rain` at `9afa1fd` (2026-11-23), Flutter 3.50.1 (it needs 3.50). It resolved with no change.
- Headless only so far, on the iOS look and the Android look (`"flutterHost": { "platform": "android", "window":
  "412x915@2.625" }`), with `"launch": { "locale": "en-US", "timeZone": "Europe/Berlin" }`.

## Wiring it, as the docs say

`lynkeus init`, then `lynkeus init --headless`, then the `dependency_overrides` of the first app's section and
`lynkeus.config.json` pointing at the cases. `init` put `LynkeusAgent.start(app: {'name': 'rain'})` first in `main()`,
before `WidgetsFlutterBinding.ensureInitialized()`, and did not add `lynkeus_plugins` (nothing in the lock needs it).
What the app needed changed, beside the dependencies:

- `ValueKey('add-city')` on the Cities tab's floating action button and `ValueKey('locate')` on the city picker's
  location button. Both are icons with no label; by index, the add button moved with every card in the list.

Nothing else: no route wiring, no reset command, no `test/lynkeus_host.dart`. Each case starts on a fresh host
(`--host-command`), so each starts as a fresh install; the cases after the first go through the onboarding in six
steps.

```sh
cd <rain>
NET=$PWD/.lynkeus/net-cache
# Recording, once, with the network open to the app's hosts
LYNKEUS_NETWORK_HOSTS=127.0.0.1,localhost,::1,10.0.2.2,api.open-meteo.com,air-quality-api.open-meteo.com,geocoding-api.open-meteo.com,tile.openstreetmap.org,nominatim.openstreetmap.org,fonts.gstatic.com,one.one.one.one,icanhazip.com,ajax.googleapis.com,captive.apple.com \
  npx lynkeus case run --ports 8191 --host-command "LYNKEUS_PORT={port} npx lynkeus headless start" --net-cache $NET --net-record
# Every run after it, off the internet
npx lynkeus case run --ports 8191 --host-command "LYNKEUS_PORT={port} npx lynkeus headless start" --net-cache $NET --once
```

## Results

Steps passed and seconds per case, headless, from the recording; two full runs per look, all 10/10 both times (the
seconds are the first run's). A step under `on: ios`, `on: android` or `on: has:...` is skipped where it does not apply.

| Case | What it covers | iOS look | Android look |
|---|---|---|---|
| 01-onboarding | the three pages, a city found by search, its forecast | 19/19, 2.6 s | 19/19, 2.5 s |
| 02-location-permission | the location button denied, then allowed when asked; the device's default place named by Nominatim | 17/17, 2.3 s | 16/16, 2.3 s |
| 03-add-city | the add sheet, search, the new card | 20/20, 3.4 s | 20/20, 3.3 s |
| 04-reorder-delete | two cities, a long-press drag to reorder, a swipe and a confirmation to delete | 30/30, 5.1 s | 30/30, 5.0 s |
| 05-hourly-daily | the current hour from the server's clock, another hour picked, a day's page, the 12-day list | 25/25, 3.7 s | 25/25, 3.7 s |
| 06-units | Fahrenheit and m/s from Settings, on the forecast and the hourly details | 25/25, 4.0 s | 25/25, 4.0 s |
| 07-air-quality | the European index, its band, advice and pollutants, then the US index | 26/26, 4.7 s | 26/26, 4.0 s |
| 08-map | OpenStreetMap tiles, the city's marker, its card and page | 19/19, 3.2 s | 19/19, 3.1 s |
| 09-theme-language | dark theme, Spanish through the language search (a field with only a hint), English again | 26/26, 7.7 s | 26/26, 8.1 s |
| 10-network-down | a refresh offline keeps the forecast and says "No Internet", a search finds nothing, online again | 24/24, 4.9 s | 24/24, 4.8 s |
| All | | 231/231, 70–78 s wall | 230/230, 68–69 s wall |

The wall time includes ten host starts, about 3 s each (the app's kernel is cached between them). With the network
open, the same cases took 5–13 s each: the real APIs answer in 0.3–1.5 s.

## Deterministic data

- **Network.** The fence keeps the app on loopback; one recording run (above) kept 140 answers (2.1 MB): forecasts,
  air quality, city searches, Nominatim's reverse lookups, the map tiles both looks fetched, google_fonts' Ubuntu and
  the HEAD requests of the connectivity check. Every later run is answered from it, and `lynkeus requests` shows no
  request refused. The recording is in the clone, `<rain>/.lynkeus/net-cache` (2026-11-23, about 08:30 UTC), and is
  not committed: it holds OpenStreetMap tiles, which the tile policy does not allow to be redistributed.
- **Now.** Rain corrects the device's clock with the `Date` header of the forecast's answer (`clockSkewSeconds`). The
  replayed answer keeps the recorded header, so every run sees 2026-11-23, 09:xx in Berlin: the hourly strip selects
  hour 9 and the dates read "Mon, Nov 23, 2026" whatever day the cases run. Rain reads `DateTime.now()`, not
  `package:clock`, so `--epoch` would not reach it; the only line that moves is "Updated: …" (the device's own clock),
  which no case reads.
- **Time zone and locale** come from `launch` (Europe/Berlin, en-US); flutter_timezone answers the same zone.
- **Location.** geolocator's stand-in answers the iOS Simulator's or the Android emulator's default position, so the
  same case names Cupertino on one look and Mountain View on the other, as the devices would.

Not deterministic on its own: the recording itself. Recorded again an hour later, the forecast and the hour differ, and
the cases' numbers (0.2°C, AQI 27, hour 9) have to be read again from the new recording.

## What it found

Fixed, each with a test:

- **Isar, a database over `dart:ffi`.** Under `flutter test` nothing loads `libisar`, and the app died at
  `Isar.open` (`Failed to lookup symbol 'isar_version'`) before its first frame. isar_community_flutter_libs ships the
  library prebuilt for macOS and Linux; the headless host now loads every library a plugin keeps in its `macos/` (or
  `linux/`) folder before the app starts, and Isar runs for real, its files in the run's temporary folder. No
  stand-in, no `lynkeus_plugins`, no app change. On FastSim this is not done yet (below).
- **Routes with go_router built in a provider.** The docs' `LynkeusRoutes` example needed the router in a global.
  The agent now reads the app's root `Router` with nothing wired: go_router's state (name, else path pattern), else
  the location's path, and a page pushed without a name over it by its widget (`DailyCardInfo`, `PlaceInfo`).
  `LynkeusAgent.routes` takes routes where a router is made, for apps that navigate by route name. A popped page also
  stopped counting as the route at once (it counted while it slid out, so `back` answered with it).
- **Record and replay.** dio's responses were recorded with empty bodies (dio reads through `response.cast()`, whose
  handler went around the agent's); HEAD requests were neither recorded nor replayed, so the connectivity check
  (internet_connection_checker_plus) read offline on every replay and the app fetched nothing; what the app fetched at
  launch was lost, because recording started when the driver attached. All three fixed: bodies kept through a cast,
  HEADs recorded beside an empty body and replayed, and a host the run starts records from its launch
  (`LYNKEUS_NET_RECORD`, also a `--dart-define` for device builds).
- **Airplane mode.** `os network off` only told connectivity_plus; on a host it now fails every request the app makes,
  replayed ones included (netmock still answers), and a first version that also cut the agent's own link was caught by
  this app.
- **Stand-ins** for geolocator (position, permission states including the person's answer when asked, services, the
  position stream; `lynkeus call location`), geocoding up to 4.x, home_widget (`widgets`), workmanager (`tasks`; its
  Pigeon requests needed the stand-ins to read any Pigeon class), flutter_displaymode and restart_app. The host file
  registers workmanager's platform class.
- **Press with the keyboard up.** A press closed the keyboard first whenever a field was focused, so an autocomplete's
  suggestions vanished before the tap. The keyboard is now closed only when it covers the target.
- **A field with only a hint** (the language search, `Search...`) is found by that hint; before, only by an index that
  differs between the looks.
- **Case format.** `app.press: 5` (a YAML number) failed with a TypeScript error; `app.wait: { text: Delete }` waited
  for a route called Delete (a capitalized word alone is a route in `app.wait`, React Native's convention). In a Flutter
  project the `text` key now always names a text, as in `app.see` and `app.press`; a React Native project keeps its old reading. A bare word and `{ target }` keep their meaning: 
  React Native cases wait for routes with `{ target: Home.Main }` and `{ route: Intro.Main }`, so changing those would
  change existing cases. For Flutter, quote the word or use `{ text }`.

Seen on a real app, unchanged:

- `lynkeus map build` reads the three GoRoutes (their paths are static constants) and four pages pushed through the
  app's `pushRouteUp` extension. `PlaceInfo` and `DailyCardInfo`, pushed through a helper that takes the page as a
  closure, are not in the graph.
- `lynkeus smoke` on a fresh install: `/` and `/geolocation` land on `/onboarding` (the app's gate), reported as
  such; after the onboarding, `/` and `/geolocation` open and `/onboarding` lands on `/`.
- `lynkeus crawl --max 40`: 8 transitions, 3 screens, no problems, two edges learned (a city card to `PlaceInfo`).
  The four tabs are all route `/`, so the crawl pressed each tab but did not explore what each shows: it knows a
  screen by its route.
- Rain's bottom bar keeps its English labels after the language changes to Spanish until it is built again; the case
  says so. Fahrenheit shows `Feels 24.439999999999998°F` (the app's rounding).
- geocoding 5 has no channel (its platform classes are Pigeon proxies), so headless it fails as a geocoder finding
  nothing and Rain falls back to Nominatim, which a phone does only when its geocoder fails. Standing in would need a
  Dart `GeocodingPlatformFactory` in the host file (the CLI writes it when the lock has geocoding 5) or in
  `lynkeus_plugins` (which would then depend on geocoding_platform_interface 5).
- Rain calls workmanager, home_widget's updates and flutter_displaymode only behind `Platform.isAndroid`, which is
  false under `flutter test` on a Mac whatever the look: headless never runs them. FastSim's Android look will.
- Index targets during a page transition count the leaving page's elements; a case that must use an index waits
  (`app.idle`) first. Rain's cases use the two keys instead.
- A toast (2.5 s) shows across a press and a wait as on a device; the host fast-forwards only while the driver waits.

## Data and its terms

- **Open-Meteo** (forecast, air quality, geocoding): data under CC BY 4.0, which asks for attribution; Rain shows
  "Data by Open-Meteo (CC-BY 4.0)" in Settings. The free API is for non-commercial use only, under 600 calls a minute,
  5,000 an hour and 10,000 a day; a commercial team running these cases against it needs a paid plan or the replay. The
  terms say nothing about keeping responses; CC BY 4.0 allows it with attribution.
- **OpenStreetMap** (tiles, Nominatim): data under ODbL, attribution "© OpenStreetMap contributors", which Rain's map
  shows. The [tile policy](https://operations.osmfoundation.org/policies/tiles/) asks for an identifying User-Agent
  (Rain sends `com.yoshi.rain`), honoring cache headers, no prefetching, no headless bots that pan the map to force
  tiles, and no offline archives or redistribution of tiles. The
  [Nominatim policy](https://operations.osmfoundation.org/policies/nominatim/) caps clients at one request a second,
  asks for an identifying User-Agent, caching, and no systematic or periodic queries. Hence: one recording run (50
  tiles and two reverse lookups, at a person's pace), every run after it replayed, and the recording kept local.
  A team that runs map cases in CI should record against a tile server that allows it (its own, or a provider whose
  terms do) or mock the tiles, and never commit or share a recording of `tile.openstreetmap.org`.

## Still to run

The same ten cases on an iOS Simulator, an Android emulator and Lynkeus FastSim, from the clone. On the devices the
`on: has:...` steps are skipped (the denied permission in 02, airplane mode in 10), and the location permission has to
be granted beforehand; the forecasts come from the live APIs, so the cases' numbers hold only within the hour they were
recorded unless the device run replays too (it cannot: a device has no fence).

```sh
cd ~/code/lynkeus/flutter-apps/rain
# iOS Simulator
flutter build ios --simulator --debug --dart-define=LYNKEUS_TOKEN=$(cat .lynkeus/token) --dart-define=LYNKEUS_PORT=8144
xcrun simctl install <device> build/ios/iphonesimulator/Runner.app
xcrun simctl privacy <device> grant location com.example.rain
xcrun simctl launch <device> com.example.rain
LYNKEUS_PORT=8144 npx lynkeus case run --device <device>
# Android emulator (unlocked)
flutter build apk --debug --flavor gms --dart-define=LYNKEUS_TOKEN=$(cat .lynkeus/token) --dart-define=LYNKEUS_PORT=8144
adb -s <serial> install -r build/app/outputs/flutter-apk/app-gms-debug.apk
adb -s <serial> shell pm grant com.yoshi.rain android.permission.ACCESS_FINE_LOCATION
adb -s <serial> shell am start -n com.yoshi.rain/.MainActivity
LYNKEUS_PORT=8144 npx lynkeus case run --device <serial>
# FastSim
<kit>/bin/fastsim-bundle . <bundle> ios -- --dart-define=LYNKEUS_TOKEN=$(cat .lynkeus/token)
npx lynkeus case run --ports 8232 --host-command "<kit>/bin/fastsim-run <bundle> {port}" --net-cache $PWD/.lynkeus/net-cache
```

Each case expects a fresh install: on a device, reinstall (or clear the app's data) between cases, or give Rain a
`reset` command. On FastSim, Isar will fail as it did headless before the fix: the host does not load the plugin's
desktop library yet, and with `Platform.isIOS` true Isar looks the symbols up in the process
(`DynamicLibrary.process()`), so the FastSim host has to load `macos/libisar.dylib` (Mac) or `linux/libisar.so` (Linux,
where the Android look opens it by name) before the app starts. The device runs also need the recording made on a
device (`--net-record` with `--dart-define=LYNKEUS_NET_RECORD=1`) to compare a host's frames with a device's.

---
title: iOS
description: What is specific to running lynkeus on iOS. Requirements, how the CLI finds the simulator, the commands that reach the simulator from outside, limits and known problems.
---

This page covers what is particular to iOS: what the agent needs from the build, how the CLI picks a simulator, and the commands that act on the simulator from outside the app. Read it after [installing the agent](/getting-started/installation-react-native/), when you start running tests on a simulator or set one up on CI.

Everything that goes through the agent (reading the screen, pressing, typing, waiting, running cases) works the same on every platform and is not repeated here.

## Requirements

- **The New Architecture.** On iOS the agent requires it. It measures elements through the Fabric shadow tree and its native module is a Turbo Module.
- **A debug build.** The native code that synthesizes touches is wrapped in `#if DEBUG`. In a release build those symbols do not exist, and the module's methods are no-ops.
- **React Native 0.76 or newer.**
- **Xcode and a booted simulator.** The CLI uses `xcrun simctl` for everything it does to the simulator from outside.
- **Node 22 or newer** for the CLI.

After adding `lynkeus-agent`, install its pod and build the app once:

```bash
cd ios && pod install && cd ..
yarn ios
```

## How the agent works on iOS

**Touches** are synthesized with private UIKit API, the same technique KIF and Detox rely on. A press is a real touch delivered to the app's window, so gesture recognizers, `Pressable` and bottom sheets all respond to it as they do to a finger.

**Keys** go through the focused field's key input, so the app sees real key events: input masks and `onChange` handlers behave as they do for a person typing.

**Connecting.** The agent dials `ws://localhost:8123`. A simulator shares the Mac's network, so `localhost` is the Mac where the CLI listens. Pass `host` or `port` to `auto()` or `<Lynkeus>` to dial somewhere else.

## How the CLI picks a simulator

Reading the screen and driving the app need no simulator lookup at all: whichever app dials in is the app being driven. The CLI only needs to know *which* simulator when it does something from outside the app, such as launching it or taking a screenshot.

It asks Xcode for the booted simulators and picks one in this order:

| Source | Example |
|---|---|
| The `--device` flag | `--device 'iPhone 16'` or `--device <udid>` |
| The `LYNKEUS_DEVICE` environment variable | `LYNKEUS_DEVICE='iPhone 16'` |
| `device` in `lynkeus.config.json` | `"device": "iPhone 16"` |
| Otherwise | The first booted simulator |

A name matches when the simulator's name contains it. If you name a simulator that is not booted, the command fails with:

```text
No booted simulator matching "iPhone 16".
```

Boot the simulator first; lynkeus does not boot one for you.

Commands that launch the app or change its permissions also need its bundle identifier. Give it once in the configuration so you do not repeat it:

```json title="lynkeus.config.json"
{
  "device": "iPhone 16",
  "app": "com.example.myapp"
}
```

`--app <bundleId>` on the command line and `LYNKEUS_APP_ID` in the environment override it.

## Launching the app

Tests are more repeatable when each one starts from a fresh process.

```bash
npx lynkeus launch --clean
```

`launch` relaunches the app (it terminates the running process and starts a new one), waits for the agent to attach, and prints the first screen. With `--clean` it first runs the app's `reset` command, so that whatever the app clears on reset, such as storage and caches, is cleared before the relaunch. It takes the bundle identifier as an argument, from `--app`, or from `app` in the configuration.

The global flag `--launch` does the relaunch before any other command attaches, which also covers an app that is not running yet:

```bash
npx lynkeus screen --launch --app com.example.myapp
```

## Commands that reach the simulator from outside

Some things are not the app's to decide: whether it has permission to use the camera, what the system appearance is, where the device is. These commands change them from outside, through `simctl`. Each prints the `xcrun` command it ran.

| Command | What it does |
|---|---|
| `lynkeus os permissions <grant\|revoke\|reset> <service>` | Changes one permission for the app. Needs the bundle identifier. |
| `lynkeus os push <payload>` | Delivers a push notification to the app. Needs the bundle identifier. |
| `lynkeus os appearance <light\|dark>` | Switches the simulator between light and dark. |
| `lynkeus os location <lat>,<lon>` | Sets where the device is. `lynkeus os location clear` removes it. |
| `lynkeus os language [tag]` | Relaunches the app in a locale, such as `de-DE`. Needs the bundle identifier. |

### Permissions

```bash
npx lynkeus os permissions grant camera
npx lynkeus os permissions revoke photos
npx lynkeus os permissions reset all
```

The services are the ones `simctl privacy` accepts: `all`, `calendar`, `contacts`, `contacts-limited`, `location`, `location-always`, `photos`, `photos-add`, `media-library`, `microphone`, `motion`, `reminders`, `siri`, `camera`.

Granting a permission before the test reaches the screen that asks for it avoids the system dialog. That matters because the dialog is drawn by iOS, not by your app, so it is not an element and cannot be pressed by `testID`.

### Push notifications

```bash
npx lynkeus os push '{"alert":"Your order shipped"}'
npx lynkeus os push fixtures/order-shipped.json
```

The payload is either JSON or the path to a `.json` file. A bare notification is wrapped under `aps` for you; a payload that already has an `aps` key is sent as it is.

### Language

```bash
npx lynkeus os language de-DE
```

There is no system-wide language switch on a booted simulator, so this terminates the app and launches it again with the launch arguments iOS reads for its language and locale. Without a tag, it uses `locale.languageTag` or `language` from `lynkeus.config.json`.

### Light and dark

```bash
npx lynkeus os appearance dark
```

Light and dark are two different screens for checks that depend on color, such as the contrast check in [`lynkeus lint`](/guides/lint-and-contrast/). Run those checks once in each.

## Screenshots and pixels

On a simulator the pixels are real, which is what a headless host cannot give you.

```bash
npx lynkeus screenshot home.png
```

`lynkeus snapshot <name> --pixels` compares a screenshot against a stored baseline. Before taking it, lynkeus pins the simulator's status bar (the time reads 9:41, the battery is full, the signal bars are fixed) so that the clock does not count as a difference. `--no-freeze` skips that. See [Recording and snapshots](/guides/recording-and-snapshots/).

`lynkeus case run --out <dir> --screenshots` keeps a screenshot after every app step of every case. See [Reports](/guides/reports/).

## Limits

- **System UI is not part of the screen.** Permission dialogs, the share sheet, the system keyboard and anything else drawn by iOS rather than by React Native are not listed as elements. Use `lynkeus os permissions` for permissions, and expect a native screen your app opens to need a press at a point (`lynkeus press 100,200`).
- **Tabs and bars drawn by the system are not elements.** A tab bar rendered natively, as in the newest Expo template, cannot be pressed by name. Navigate with `lynkeus nav <route>`.
- **Debug builds only.** lynkeus cannot drive a release build or a build from TestFlight or the App Store.
- **The simulator is the documented target.** The agent dials `localhost`, which on a simulator is the Mac. The driver listens on the Mac's loopback address only.

## Known problems

### No keyboard appears while typing

`type` taps the field first, so the field is focused the way a person focuses it and the system keyboard comes up. When it does not, the simulator is taking keys from the Mac's keyboard instead. Turn off **I/O → Keyboard → Connect Hardware Keyboard** in the Simulator menu, or run:

```bash
defaults write com.apple.iphonesimulator ConnectHardwareKeyboard -bool false
```

### The driver never attaches

The agent dials `localhost:8123` and keeps retrying, so the order in which you start the app and the CLI does not matter. If the CLI still times out, check that the build is a debug build, that `enabled` is true for this environment, and that the token the app was built with is the `LYNKEUS_TOKEN` the CLI reads. `--attach-timeout <ms>`, or `attachTimeout` in the configuration, gives a slow launch longer than the default 15 seconds.

### A press does nothing

Read the screen first. The element may be covered (`~covered`), disabled (`!disabled`), or not presented at all, in which case the header counts it as hidden and `lynkeus screen --all` lists it. `lynkeus press <target> --js` calls the element's `onPress` handler directly instead of synthesizing a touch. If that works where the touch did not, something is intercepting the touch; it is a comparison to diagnose with, not a fix to keep.

### A step lands on the previous screen

A newly pushed screen is still sliding in, and no render shows that. `lynkeus case run` waits for the animation after an `app.wait` on a route. When you drive by hand or from a script of your own, do what the case runner does and run `npx lynkeus idle --quiet 700` after waiting for a route: it returns once the app has gone 700 ms without rendering.

More symptoms and fixes are in [Troubleshooting](/troubleshooting/).

## Next steps

- [Android](/platforms/android/): the same topics for the other platform.
- [Headless](/platforms/headless/): the same cases with no simulator.
- [Running on CI](/guides/ci/): what a job needs to boot a simulator and run a suite.

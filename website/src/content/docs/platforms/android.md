---
title: Android
description: What is specific to running lynkeus on Android. Requirements, how the agent reaches the driver from an emulator, limits and known problems.
---

This page covers what is particular to Android: what the agent needs from the build, how an emulator reaches the driver on your machine, and where Android differs from iOS today. Read it after [installing the agent](/getting-started/installation-react-native/), when you start running tests on an emulator.

Everything that goes through the agent (reading the screen, pressing, typing, waiting, running cases) works the same on every platform and is not repeated here.

## Requirements

- **A debuggable build.** The agent's native module checks the application's `FLAG_DEBUGGABLE` flag and refuses to run without it. A standard debug build has it; a release build does not.
- **React Native 0.76 or newer with the New Architecture.**
- **An Android emulator** with the app installed and running, and `adb` on your `PATH` for the commands that act on the device from outside the app.
- **Node 22 or newer** for the CLI.

The native module is linked automatically. After adding `lynkeus-agent`, build the app once:

```bash
yarn android
```

In an Expo project, use `npx expo prebuild` and `npx expo run:android` instead. Expo works on Android as it does on iOS: a development build attaches, the screen is read, and expo-router's routes are recognized. See [Install in an Expo app](/getting-started/installation-expo/).

## How the agent works on Android

**Touches** are `MotionEvent`s dispatched to the activity's window. This needs no instrumentation and no special permission, and the app's views receive the events as they receive a finger's.

**Keys** go through the focused `EditText`, so the app sees the text arrive as typed input.

**Positions** come from the native views. On Android a view can stand somewhere other than where React Native's shadow tree places it; in an app that draws under the status bar, the two differ by the height of the status bar. The agent asks the native side where each view actually is, so a press lands on its target.

:::caution
That placement was added in `lynkeus-agent` 0.2.0, and it lives in native code. An app must be **rebuilt** after upgrading to get it. Until then the agent behaves as before, and in an app that draws under the status bar a press can land above its target.
:::

## How an emulator reaches the driver

The app is the side that connects, and the driver listens on your machine's loopback address. From inside an Android emulator, `localhost` is the emulator itself, not your machine. The emulator provides the address `10.0.2.2` as an alias for the machine it runs on.

The agent uses that address by default on Android: it dials `ws://10.0.2.2:8123`. You do not configure anything for an emulator.

To dial somewhere else, pass `host` and `port` to the agent:

```js title="index.js"
auto({ token: process.env.LYNKEUS_TOKEN, host: '10.0.2.2', port: 8124 });
```

When you change the port in the app, change it for the CLI too, with `LYNKEUS_PORT=8124` or `port` in `lynkeus.config.json`. Each app and its driver are a pair on one port, which is how several pairs run on one machine.

## Verify

With the app running on the emulator and `LYNKEUS_TOKEN` exported:

```bash
npx lynkeus hello
```

You should see the platform reported as `android` and the native module as available:

```text
{
  "event": "hello",
  "protocolVersion": 1,
  "agentVersion": "0.2.1",
  "platform": "android",
  "native": true,
  ...
}
```

`"native": false` means the build is not debuggable, or the app was not rebuilt after the package was added. Reading the screen works in that state; pressing and typing do not, and fail with:

```text
Lynkeus native module unavailable: debug builds only, and the app must be rebuilt after adding the package
```

## Cases on Android

A case runs unchanged on Android. Where a step applies to one platform only, wrap it in `on:`:

```yaml
steps:
  - app.press: "#open-camera"
  - on: android
    do:
      - app.press: "#android-permission-rationale-ok"
  - app.see: "#camera-preview"
```

`on:` accepts `android`, `ios`, `device` (a simulator or emulator, as opposed to the headless host), `headless`, and `has:<command>` for a build whose app registered that command. A `!` in front reverses any of them: `on: "!android"`.

On a device, a case does some waiting that the headless host does not need, and it applies to Android as it does to iOS: after a swipe it waits for the screen to stop moving, since a pager keeps going after the finger lifts; and after `app.wait` on a route it waits for the new screen to finish sliding in.

## Differences from iOS

The CLI does two kinds of things. Most go through the agent and are identical on both platforms. A few are done from outside the app, with the platform's own tools: launching the app, taking a screenshot, and the `lynkeus os` commands that change the device. On iOS those use `xcrun simctl`; on Android the CLI maps them to `adb`.

### How the CLI picks the device

Driving the app needs no device lookup: whichever app dials in is the app being driven. The CLI only needs to know which device to address when it acts from outside the app.

When the app attaches, it says which platform it runs on. For an app on Android, the CLI then asks `adb devices` which devices are ready and picks one:

| Source | Example |
|---|---|
| The `--device` flag, when it is the serial of a ready device | `--device emulator-5554` |
| The `LYNKEUS_DEVICE` environment variable, same rule | `LYNKEUS_DEVICE=emulator-5554` |
| Otherwise | The first device `adb devices` lists as ready |

A name that matches no serial is not an error on Android. It is ignored and the first ready device is used, so a `device` setting meant for an iOS simulator does not get in the way when you drive both platforms from one project. Name the serial yourself whenever more than one Android device is connected, such as an emulator and a phone plugged in for something else.

If no device is ready, the command fails with:

```text
No Android device or emulator is up (adb devices lists none).
```

With this lookup, `lynkeus screenshot` was verified on the emulator:

```bash
npx lynkeus screenshot home.png
```

### The `os` commands

The `lynkeus os` commands available for Android are fewer:

| Command | Android |
|---|---|
| `lynkeus os permissions <grant\|revoke> <permission>` | Yes. The permission is an Android name, such as `android.permission.CAMERA`; a short name like `camera` is expanded to that form. There is no `reset`. Needs the application ID (`--app` or `app` in the configuration). |
| `lynkeus os appearance <light\|dark>` | Yes. |
| `lynkeus os location <lat>,<lon>` | Yes. There is no `clear`. |
| `lynkeus os push` | No. |
| `lynkeus os language` | No. |

Asking for one that is not available fails with:

```text
"push" is not available on Android through lynkeus; permissions, appearance and location are
```

:::note
Of the commands that act from outside the app, `lynkeus screenshot` is the one that has been run on the Android emulator. `lynkeus launch` and the `lynkeus os` commands in the table use the same device lookup, but they were not run on Android for this documentation. Confirm them on your setup before a suite depends on them.
:::

`lynkeus os deeplink <url>` is not in that group. It goes through the agent and works on Android as it does everywhere.

## Limits

- **System UI is not part of the screen.** Permission dialogs, the system keyboard, the notification shade and anything else drawn by Android rather than by React Native are not listed as elements.
- **Debuggable builds only.** lynkeus cannot drive a release build or a build installed from Google Play.
- **The emulator is the documented target.** The default address, `10.0.2.2`, exists only inside an emulator, and the driver listens on your machine's loopback address only.

## Known problems

### A press lands above its target

The app draws under the status bar, and the installed binary predates the native placement described above. Upgrade `lynkeus-agent` to the CLI's version and rebuild the app. When it attaches, the CLI prints a warning if the agent in the app and the CLI are from different releases; install the matching version, and then rebuild rather than reload, because the placement is in native code.

### The driver never attaches

```text
✗ No app attached on 127.0.0.1:8123 within 15000ms. Is a dev build running with <Lynkeus>?
```

Check that the build is a debug build, that `enabled` is true for this environment, and that the token the app was built with is the `LYNKEUS_TOKEN` the CLI reads. If you passed `host` to the agent, check that the address reaches your machine from inside the emulator. `--attach-timeout <ms>`, or `attachTimeout` in the configuration, gives a slow launch longer than the default 15 seconds.

### A press does nothing

Read the screen first. The element may be covered (`~covered`), disabled (`!disabled`), or not presented at all, in which case the header counts it as hidden and `lynkeus screen --all` lists it. `lynkeus press <target> --js` calls the element's `onPress` handler directly instead of synthesizing a touch, which tells you whether the touch or the handler is the problem. It is a comparison to diagnose with, not a fix to keep.

More symptoms and fixes are in [Troubleshooting](/troubleshooting/).

## Next steps

- [iOS](/platforms/ios/): the same topics for the other platform.
- [Headless](/platforms/headless/): the same cases with no emulator.
- [Running on CI](/guides/ci/): what a job needs to boot an emulator and run a suite.

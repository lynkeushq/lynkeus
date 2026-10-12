---
title: Install in an Expo app
description: Add the lynkeus agent to an Expo app with a development build, mount it before expo-router loads, pass the token, and verify from the terminal.
---

This page takes an Expo app from nothing to a terminal that can read its screen. The steps were verified on a new Expo SDK 57 project (React Native 0.86) that uses expo-router, on the iOS simulator and on the Android emulator.

Expo needs three things that a React Native CLI app does not, and each has a reason:

- **A development build.** The agent contains native code, and Expo Go only runs the native code it was shipped with. lynkeus does not work in Expo Go.
- **An entry file of your own.** An expo-router project has no `index.js`, and the agent has to be mounted before the router loads.
- **A second name for the token.** Expo only passes the app environment variables that start with `EXPO_PUBLIC_`.

If your app does not use Expo, follow [Install in a React Native app](/getting-started/installation-react-native/) instead.

## Before you start

- An Expo project that you can build locally: Xcode for iOS, Android Studio for Android.
- Node 22 or newer.
- React Native 0.76 or newer with the New Architecture enabled.

No config plugin is needed. The agent's native module is autolinked.

## Steps

### 1. Add the packages

The agent goes into the app; the CLI stays on your machine.

```bash
npx expo install lynkeus-agent
npm install --save-dev lynkeus
```

Keep both on the same version. The CLI prints a warning when it attaches to an agent from a different release.

### 2. Mount the agent

`lynkeus init` mounts the agent from the app's entry, and knows what an Expo project needs:

```bash
npx lynkeus init
```

In an expo-router project you should see:

```text
wrote index.js (mounts the agent, then loads expo-router) and pointed package.json's main at it
Expo: the agent has native code, so it runs in a development build (npx expo run:ios, npx expo run:android), not in Expo Go
Expo: start the dev server with EXPO_PUBLIC_LYNKEUS_TOKEN set to the same value as LYNKEUS_TOKEN; Expo passes the app only variables with that prefix
```

The first line is what it changed. The two lines that start with `Expo:` are reminders of steps 3 and 4 below.

In an Expo project that already has an entry file (`index.js`, `index.tsx` or `index.ts`), `init` adds the `auto()` call to that file instead, after its last import, and reads the token from `EXPO_PUBLIC_LYNKEUS_TOKEN` there too.

:::note
`lynkeus init` is new and not yet released. If your version of the CLI answers that the command is unknown, make the two changes by hand as shown below.
:::

#### What it does, and doing it by hand

An expo-router project starts from `expo-router/entry`, named as `"main"` in `package.json`, so it has no entry file of its own. `init` gives it one that mounts the agent first and then loads the router.

That is an `index.js` at the root of the project:

```js title="index.js"
import { auto } from 'lynkeus-agent/auto';

auto({ token: process.env.EXPO_PUBLIC_LYNKEUS_TOKEN });

import 'expo-router/entry';
```

And `"main"` pointing at it:

```json title="package.json"
{
  "main": "index.js"
}
```

The order in `index.js` matters. `auto()` wraps the app's root component, so it has to run before the router registers that component.

`auto()` runs only in development by default (`enabled` defaults to `__DEV__`). To gate it further, pass `enabled` yourself, for example to keep the agent off in a development build that points at production.

If your project already has an `index.js` (it does not use expo-router, or you added an entry earlier), the `auto()` call goes there, before the app is registered.

### 3. Set the token under both names

The token is a shared secret: the app is built with a value, the CLI presents the same value, and the agent ignores a driver that presents anything else.

Two programs read it, under two names:

| Who reads it | Variable | Why |
|---|---|---|
| The app | `EXPO_PUBLIC_LYNKEUS_TOKEN` | Expo only inlines variables that start with `EXPO_PUBLIC_`. |
| The CLI | `LYNKEUS_TOKEN` | The CLI always reads this name. |

Both must hold the same value. Export both in the shell where you build the app and start the development server, and export `LYNKEUS_TOKEN` in any other shell where you run `lynkeus`:

```bash
export EXPO_PUBLIC_LYNKEUS_TOKEN=some-local-secret
export LYNKEUS_TOKEN=some-local-secret
```

The app's copy is read when the JavaScript is bundled, so it must be set before the development server starts.

:::caution
If the app reads `process.env.LYNKEUS_TOKEN` (without the `EXPO_PUBLIC_` prefix), the value is `undefined` inside the bundle. The agent then serves any driver that connects, with or without a token.
:::

### 4. Generate the native projects and build

`prebuild` generates the `ios` and `android` folders with the agent's native module linked. `run:ios` and `run:android` compile a development build and install it.

```bash
npx expo prebuild
npx expo run:ios
```

Or, for Android:

```bash
npx expo run:android
```

You should see the app open on the simulator or emulator, as a development build of your own app rather than inside Expo Go.

You build once. After that, the development server is enough for JavaScript changes; rebuild only when you add or update a package with native code, `lynkeus-agent` included.

### 5. Verify from the terminal

With the app running, from the project's folder:

```bash
npx lynkeus screen
```

You should see a line on standard error saying the app attached, and then the screen. The first line is the route and, in parentheses, the chain of navigators that leads to it:

```text
index (__root > index)
```

Below it comes one line per element a user could see or touch, which depends on your app. The first line is the part to check: `index` is the route as expo-router names it, and `__root > index` is the path to it. Seeing them means the agent found the router's navigation container, so routes are recognized.

Installation is complete. Continue with [Your first test](/getting-started/first-test/).

## How it works

`auto()` asks React Native to wrap whatever root component is registered later. When expo-router registers its root, the agent is already around it. expo-router is built on React Navigation, so the agent finds its navigation container the same way it does in any React Navigation app, and reports the routes expo-router derives from your `app/` folder.

From there everything is the same as in a React Native CLI app: the agent dials out to port 8123 on your machine (`localhost` from the iOS simulator, `10.0.2.2` from the Android emulator), and each `npx lynkeus …` command listens there, presents the token, and runs.

## What is different in an Expo app

Two things behave differently from what the rest of the documentation shows. Both are covered in more detail in [Expo](/platforms/expo/).

**Route names are file names, in lowercase.** The examples elsewhere use React Navigation names such as `Settings.Main`. expo-router names a route after its file: `index`, `explore`. `lynkeus nav index` works with any name. `lynkeus wait` and `lynkeus see`, however, take either a route or a target in the same position, and read a lowercase word as a text to look for. Say that it is a route with the `route:` prefix: `npx lynkeus wait route:index`, or `app.wait: "route:index"` in a case. The prefix is new and not yet released.

**Native tabs are not elements.** The tab bar of the newest Expo template is drawn by the system, not by React Native. Its tabs are not listed by `lynkeus screen` and cannot be pressed by name. Move between tabs with `lynkeus nav <route>`.

## Common problems

### The CLI never attaches

```text
✗ No app attached on 127.0.0.1:8123 within 15000ms. Is a dev build running with <Lynkeus>?
```

Check, in this order:

1. The app is a development build, not Expo Go. In Expo Go the agent's native module does not exist.
2. `package.json` has `"main": "index.js"`, and `index.js` calls `auto()` before it imports `expo-router/entry`. `npx lynkeus init` sets both up.
3. `EXPO_PUBLIC_LYNKEUS_TOKEN` and `LYNKEUS_TOKEN` hold the same value. A mismatch looks exactly like no app at all.
4. The development server was started with `EXPO_PUBLIC_LYNKEUS_TOKEN` set. A value exported afterwards is not in the bundle.

### The screen reads, but a press fails

```text
Lynkeus native module unavailable: debug builds only, and the app must be rebuilt after adding the package
```

Reading the screen is done in JavaScript; touching it needs the native module. This message means the JavaScript is new but the installed binary is not. Run `npx expo prebuild` and `npx expo run:ios` (or `run:android`) again.

### A tab cannot be pressed

If the tab bar does not appear in `lynkeus screen`, it is a native tab bar. Use `lynkeus nav <route>`.

## Next steps

- [Your first test](/getting-started/first-test/): drive the app by hand, then write and run a case.
- [Expo](/platforms/expo/): what is specific to Expo, and its limits.
- [Concepts](/getting-started/concepts/): the vocabulary used in the rest of the documentation.

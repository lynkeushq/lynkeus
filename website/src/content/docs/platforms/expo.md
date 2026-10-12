---
title: Expo
description: What is specific to running lynkeus in an Expo app. Development builds, the entry file, the token variable, expo-router routes, native tabs, and known limits.
---

This page collects what is particular to Expo, with the reason for each point. It is the reference to return to after the step-by-step [installation guide](/getting-started/installation-expo/), and the page a lead should read to decide whether lynkeus fits an Expo project.

The facts here were verified on a new Expo SDK 57 project, with React Native 0.86 and expo-router, on the iOS simulator and on the Android emulator. On both, a development build attaches, the screen is read, and expo-router's routes are recognized.

## Summary

| Topic | In an Expo app |
|---|---|
| Expo Go | Not supported. |
| Development build | Required. |
| Config plugin | None needed. The native module is autolinked. |
| Mounting the agent | `npx lynkeus init` (not yet released). In an expo-router app it writes an `index.js` that calls `auto()` and then loads `expo-router/entry`. |
| Token in the app | `EXPO_PUBLIC_LYNKEUS_TOKEN` |
| Token in the CLI | `LYNKEUS_TOKEN` |
| Routes | Recognized, with expo-router's names (`index`, not `Home`). In `wait` and `see`, written `route:index` (not yet released). |
| Native tab bar | Not listed as elements. Navigate with `lynkeus nav`. |

## Requirements

### A development build, not Expo Go

The agent has native code: the part that synthesizes touches and keystrokes and asks the platform which view a touch would reach. Expo Go is a prebuilt app that contains a fixed set of native modules, and the agent is not one of them. A development build is your own app, compiled with the native modules your project depends on.

```bash
npx expo install lynkeus-agent
npx lynkeus init
npx expo prebuild
npx expo run:ios
```

Use `npx expo run:android` for Android. No config plugin is needed. `lynkeus init` mounts the agent; it is described in the next section.

Rebuild whenever `lynkeus-agent` changes version. Its JavaScript reloads through the development server, but its native half is in the binary.

### Debug builds only

The same rule as everywhere: the agent's native module compiles to no-ops outside debug builds on iOS and refuses to run in a non-debuggable app on Android. `auto()` is enabled only when `__DEV__` is true unless you say otherwise.

## The entry file

An expo-router project has no `index.js`. Its `package.json` names `expo-router/entry` as `"main"`, and that module registers the app's root component.

The agent has to be mounted before that happens, because `auto()` works by wrapping the root component when it is registered. So the project gets an entry of its own:

```js title="index.js"
import { auto } from 'lynkeus-agent/auto';

auto({ token: process.env.EXPO_PUBLIC_LYNKEUS_TOKEN });

import 'expo-router/entry';
```

```json title="package.json"
{
  "main": "index.js"
}
```

Keep the order: the `auto()` call first, the router import after it.

`npx lynkeus init` makes both changes. It recognizes an Expo project by the `expo` dependency in `package.json`, and an expo-router project by `"main": "expo-router/entry"` with no entry file present. In an Expo project that already has an `index.js`, `index.tsx` or `index.ts`, it adds the `auto()` call to that file, after the last import. In every Expo project it reads the token from `EXPO_PUBLIC_LYNKEUS_TOKEN`, and it prints two reminders: that the agent needs a development build, and that the development server must be started with that variable set.

:::note
`lynkeus init` is new and not yet released. Until your version of the CLI has it, create the file and change `"main"` by hand; the result is the same.
:::

## The token

Expo inlines an environment variable into the app's JavaScript only when its name starts with `EXPO_PUBLIC_`. Any other `process.env` value is `undefined` in the bundle.

The CLI, on the other hand, is a Node program and always reads `LYNKEUS_TOKEN`.

So the same secret is set under two names:

```bash
export EXPO_PUBLIC_LYNKEUS_TOKEN=some-local-secret
export LYNKEUS_TOKEN=some-local-secret
```

The first must be set when the development server bundles the app. The second must be set in every shell, and every CI step, that runs `lynkeus`.

:::caution
A token that is `undefined` in the app does not make the agent refuse drivers. It makes the agent serve any driver. If you copy the React Native example, which reads `process.env.LYNKEUS_TOKEN`, into an Expo app, the app runs unprotected and everything appears to work.
:::

A value with the `EXPO_PUBLIC_` prefix is embedded in the JavaScript bundle. That is acceptable here because the token protects a debug build on your own machine, and the agent does not run in a release build. Do not reuse a secret that matters elsewhere.

## Routes

Routes from expo-router are recognized. `lynkeus screen` prints the route and its path on the first line:

```text
index (__root > index)
```

The names are expo-router's, derived from the files in your `app/` folder. They are what you pass to `lynkeus nav`, and what a case uses in `app.nav`.

### Waiting for a route

`lynkeus wait` and `lynkeus see` take either a route or a target in the same position, and decide which by its shape. A word that starts with a capital letter, like `Settings.Main`, is a route, as React Navigation names them. A lowercase word alone, such as `index`, is a text to look for on screen.

expo-router names a route after its file, in lowercase, so you say that a route is meant with the `route:` prefix:

```bash
npx lynkeus wait route:index
npx lynkeus see route:explore
```

In a case, the same spelling goes in `app.wait`. Quote it, because of the colon:

```yaml
steps:
  - app.nav: explore
  - app.wait: "route:explore"
  - app.see: "#explore-list"
```

Without the prefix nothing changes: `npx lynkeus wait index` still looks for the text "index", and a capitalized word is still read as a route.

`lynkeus nav` needs no prefix. Its argument is always a route.

:::note
The `route:` prefix is new and not yet released.
:::

## Native tabs

The newest Expo template uses a tab bar drawn by the operating system, not by React Native. lynkeus reads the tree React rendered, and those tabs are not in it. As a result:

- The tabs do not appear in `lynkeus screen`.
- They cannot be pressed by `testID` or by label.

Move between tabs by route. For a tab whose route is `explore`:

```bash
npx lynkeus nav explore
```

`nav` is a teleport: it changes the route without touching anything. That is the right tool for getting a test to the tab it is about. It does not prove that the tab bar itself works; a tab bar built from React Native components, which lynkeus can see and press, is the only kind it can test directly.

## Cases in an Expo app

Cases need nothing Expo-specific. The file format, `lynkeus case run`, fixtures and reports are the same as in any React Native app. Keep two habits from the sections above:

- Start a case with `app.nav` to the route it begins on, using the expo-router name.
- Wait for a route with the prefix: `app.wait: "route:explore"`, not `app.wait: explore`.

```yaml title="cases/explore-opens.md"
---
id: explore-opens
title: "Explore: the tab shows its list"
---
setup:
  - app.nav: explore

steps:
  - app.wait: "route:explore"
  - app.see: "#explore-list"
```

## Limits and open points

- **Expo Go** is not supported and cannot be, for the reason given above.
- **Native tab bars** cannot be inspected or pressed.
- **Lowercase route names** need the `route:` prefix in `lynkeus wait` and `lynkeus see`.
- **The headless host** (`lynkeus headless start`) is documented for React Native CLI projects. `lynkeus headless init` looks for the app's root component in `App.tsx`, `App.jsx`, `App.js`, `app/App.tsx` or under `src/`, which an expo-router project does not have, and the sources do not describe a setup for expo-router. Run Expo apps on a simulator or emulator.
- **Versions tested**: Expo SDK 57, React Native 0.86, expo-router, on the iOS simulator and the Android emulator. Other SDK versions need React Native 0.76 or newer with the New Architecture.

## Common problems

**The app runs but the CLI never attaches.** Confirm you are in a development build and not Expo Go, that `"main"` is `index.js` and that file calls `auto()` before it loads the router, and that the two token variables hold the same value. A token mismatch produces the same message as no app at all: `No app attached on 127.0.0.1:8123 within 15000ms`.

**`lynkeus screen` works but `lynkeus press` fails with `Lynkeus native module unavailable`.** The binary on the device was built before the agent was added. Run `npx expo prebuild` and `npx expo run:ios` or `npx expo run:android` again.

**`lynkeus wait index` times out on the right screen.** The lowercase name was read as a text, not a route. Write `lynkeus wait route:index`. See [Waiting for a route](#waiting-for-a-route).

**A tab cannot be found.** It is a native tab. See [Native tabs](#native-tabs).

## Next steps

- [Install in an Expo app](/getting-started/installation-expo/): the same setup as numbered steps.
- [Your first test](/getting-started/first-test/): drive the app and write a case.
- [iOS](/platforms/ios/) and [Android](/platforms/android/): what applies to the simulator and the emulator underneath.

---
title: Install in a React Native app
description: Add the lynkeus agent to a React Native CLI app, mount it, give it the project's token, and verify that the CLI can read the screen.
---

This page takes an app built with the React Native CLI from nothing to a terminal that can read its screen. It is for the developer who installs lynkeus; once it is done, anyone on the team can write and run tests without touching the app's code again.

If your app uses Expo, follow [Install in an Expo app](/getting-started/installation-expo/) instead.

## What you are installing

Two packages, with two different jobs:

- `lynkeus-agent` goes **inside the app**. It has native code (the part that synthesizes touches and keystrokes), so the app must be rebuilt once after adding it.
- `lynkeus` is the **CLI**. It runs on your machine or on CI and talks to the agent.

The agent only runs in debug builds. Its native module compiles to no-ops outside them. The client, which is the JavaScript that reads the screen and talks to the driver, is loaded only when the agent is enabled, however your app imports the package. Adding it does not change what you ship.

## Before you start

- React Native 0.76 or newer, with the New Architecture enabled. On iOS the agent requires it.
- Node 22 or newer.
- A debug build of the app that already runs on an iOS simulator or an Android emulator.

## Steps

### 1. Add the packages

Install both as development dependencies, from the app's folder:

```bash
yarn add -D lynkeus-agent lynkeus
```

With npm:

```bash
npm install --save-dev lynkeus-agent lynkeus
```

`lynkeus init`, in the next step, also adds `lynkeus-agent` when the app does not depend on it yet, with the package manager whose lockfile it finds (bun, pnpm, yarn or npm). Installing it yourself first, as above, works the same way.

Keep the two packages on the same version. If they differ, the CLI prints a warning when it attaches, because an agent and a CLI from different releases can misread each other without raising an error:

```text
⚠️  The app runs lynkeus-agent 0.5.1, this CLI is lynkeus 0.6.0: they can misread each other without an error. Install lynkeus-agent@0.6.0 in the app and rebuild it (or run the lynkeus CLI of the agent's version).
```

### 2. Mount the agent

The agent is mounted by one call in the app's entry file. `lynkeus init` writes it for you, and makes the project's token:

```bash
npx lynkeus init
```

You should see:

```text
lynkeus-agent is already a dependency
added auto() to index.js
made a token for this project in .lynkeus/token (kept out of git); the CLI, the MCP server and the app all read it
added lynkeus-agent/babel to babel.config.js
restart Metro with --reset-cache so the bundle picks the token up; LYNKEUS_TOKEN in the environment still wins over the file
next: build the app again and open it, then `lynkeus status` (over MCP: the status tool) to see that it attaches
      or, with no native build at all: `lynkeus headless init` runs the app in Node in a minute
```

The first four lines are what it found and changed. The rest are reminders of steps 3 to 5. When the agent was not a dependency yet, the first line says how `init` installed it instead; `--no-install` leaves that to you.

`init` looks for `index.js`, `index.tsx` or `index.ts` and inserts the import and the `auto()` call after the file's last import, so that your own polyfills still run first. It then adds a Babel plugin, `lynkeus-agent/babel`, to `babel.config.js` (or `babel.config.cjs`); step 3 explains what the plugin and the token are for. Run `init` again and it answers `index.js already mounts the agent` and `babel.config.js already has lynkeus-agent/babel`, and changes nothing.

If `init` cannot find a Babel configuration it knows how to edit, it prints the change for you to make instead:

```text
add 'lynkeus-agent/babel' to the plugins in babel.config.js, so the app can read LYNKEUS_TOKEN
```

:::note[Since 0.3.0]
`lynkeus init` arrived in version 0.3.0, together with the Babel plugin. It installs the agent and makes the token since 0.4.0. On an earlier version, make the changes by hand as shown below.
:::

#### What it does, and doing it by hand

There are two changes. The first is the call that mounts the agent. It goes in the app's entry file, before `AppRegistry.registerComponent`:

```js title="index.js"
import { AppRegistry } from 'react-native';
import { auto } from 'lynkeus-agent/auto';

import App from './src/App';
import { name as appName } from './app.json';

auto({ token: process.env.LYNKEUS_TOKEN, enabled: __DEV__ });

AppRegistry.registerComponent(appName, () => App);
```

`init` writes `auto({ token: process.env.LYNKEUS_TOKEN })`. The `enabled` option shown here is one you add yourself when you want to gate the agent further.

`auto()` does three things:

- It wraps the app's root component through `AppRegistry`, so no screen has to render anything.
- It finds your React Navigation container by itself, so routes are reported without passing a ref around.
- It starts the agent, which begins dialing your machine.

The two options shown are the ones that matter on day one:

| Option | Default | Meaning |
|---|---|---|
| `enabled` | `__DEV__` | Whether the agent runs at all. Gate it further on your own environment: a debug build pointed at production, with real accounts, should not run the agent. For example `enabled: __DEV__ && config.ENV !== 'prod'`. |
| `token` | none | A shared secret. When set, the agent serves only a driver that presents the same value. See step 3. |

`auto()` also accepts `host`, `port` and `app`; they are described in the [agent API reference](/reference/agent-api/).

The second change is the Babel plugin that lets the app read the token:

```js title="babel.config.js"
module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: ['lynkeus-agent/babel'],
};
```

### 3. Give the app the token

The token keeps other processes on your machine from driving the app. The app is built with a value, and the CLI presents the same value. If the two differ, the agent does not answer.

`lynkeus init` made the project's token: a random value in `.lynkeus/token`, which `.lynkeus/.gitignore` keeps out of git. Three programs read it from there: the CLI (and `lynkeus mcp`), `lynkeus headless start`, and the Babel plugin that writes it into the app. `LYNKEUS_TOKEN` in the environment wins over the file wherever it is set.

The app needs the plugin because React Native gives it no environment: `process.env.LYNKEUS_TOKEN` is `undefined` inside a bundle unless something writes the value there. When Metro transforms your code, `lynkeus-agent/babel` replaces `process.env.LYNKEUS_TOKEN` with `LYNKEUS_TOKEN` from Metro's environment, or else with the value in `.lynkeus/token`. It does this in a development bundle only. A release bundle is left alone, so the token is never written into one.

Metro keeps what it has already transformed. After the token is made, or its value changes, start Metro once with `--reset-cache` so the value reaches the bundle:

```bash
yarn start --reset-cache
```

To use a value of your own instead, on CI for example, export `LYNKEUS_TOKEN` both in the shell where you start Metro and in the shell where you run the CLI, and restart Metro with `--reset-cache` once:

```bash
export LYNKEUS_TOKEN=some-local-secret
```

:::caution[Since 0.3.0]
A token that the app passes and that arrives empty keeps the agent off. The app says so in its log, and `lynkeus` never attaches:

```text
lynkeus: the app passed a token and it is empty, so the agent stays off. …
```

The agent does not fall back to serving any driver that connects. If you see this line, the plugin is missing from `babel.config.js`, Metro found neither `LYNKEUS_TOKEN` nor `.lynkeus/token`, or Metro is still serving what it transformed before the value changed. See [The app logs that the token is empty](#the-app-logs-that-the-token-is-empty).
:::

`auto()` called with no `token` key at all is a different case: the app asked for no protection, and the agent serves any driver that connects. That can be acceptable on a machine of your own; see [Security](/security/#the-token) for when it is not.

The `token` option is an ordinary string. An app that already has a configuration module for build-time values, such as the API URL, can pass the token from there instead, and then does not need the plugin.

### 4. Rebuild the app

The agent's native module is linked automatically, but the app has to be compiled once with it.

For iOS, install the pod and build:

```bash
cd ios && pod install && cd ..
yarn ios
```

For Android:

```bash
yarn android
```

You rebuild only this once. From then on, Metro is enough: changes to your JavaScript, including the `auto()` call, reload as usual.

### 5. Verify from the terminal

With the app running on a booted simulator or emulator, run this from the app's folder:

```bash
npx lynkeus status
```

It checks the project and the running app, one line each, and says what fixes a line that fails:

```text
✓ lynkeus-agent is a dependency
✓ lynkeus-agent is installed
✓ index.js mounts the agent
✓ babel.config.js has lynkeus-agent/babel
✓ the project has a token
✓ an app is attached (iPhone 16 Pro)
✗ the app can run headless, in Node with no simulator — `lynkeus headless init` installs what it needs and writes its entry; optional
✗ cases to run — `lynkeus case init` writes an example and the format
✗ runs can be pushed to the reports service — set LYNKEUS_REPORTS_KEY to an API key of your organization (lynkeus.io, API keys); optional
```

The last three are for later. It only waits for the app once every line about the project passes; `--offline` checks the files alone.

Then ask the app what it says about itself:

```bash
npx lynkeus hello
```

You should see a line on standard error saying the app attached, with the simulator or emulator it runs on, then the app's answer:

```text
attached in 104ms (iPhone 16 Pro)
{
  "event": "hello",
  "protocolVersion": 1,
  "agentVersion": "0.6.0",
  "platform": "ios",
  "native": true,
  "commands": ["events", "logs", "netmock", "networkBodies", "profile", "stores", "traceContext"],
  "route": "Home"
}
```

`commands` lists what a driver can call in this app: the ones the agent answers in every app, plus anything your app registers itself. An app whose analytics SDKs the agent can read also answers `analytics`. Two other fields are worth checking. `"native": true` means the native module is in this build; if it is `false`, the app was not rebuilt after the package was added, or it is not a debug build. `"route"` is the screen the app is on, as your navigation library names it; if it is missing, the agent has not found a navigation container (see [Routes are missing](#routes-are-missing)).

Now read the screen:

```bash
npx lynkeus screen
```

You should see the route on the first line, then one line per element a user could see or touch:

```text
Home
text #title "Hello, agent"
input #name-input value="" placeholder="Your name"
button #next-button "Next"
```

Each line gives the element's kind, its `testID` after a `#`, its label, and its value or state. That listing is what every other command works from. Installation is complete; continue with [Your first test](/getting-started/first-test/).

## The explicit component

`auto()` suits most apps. Use the `<Lynkeus>` component instead when you want to hand the agent a navigation adapter yourself, for example because your router is not React Navigation, or because you prefer the mount to be visible in your component tree.

```tsx title="src/App.tsx"
import { NavigationContainer, useNavigationContainerRef } from '@react-navigation/native';
import { Lynkeus, reactNavigationAdapter } from 'lynkeus-agent';

export default function App() {
  const ref = useNavigationContainerRef();
  return (
    <NavigationContainer ref={ref}>
      <RootNavigator />
      <Lynkeus
        navigation={reactNavigationAdapter(ref)}
        enabled={__DEV__ && config.ENV !== 'prod'}
        token={config.LYNKEUS_TOKEN}
        app={{ name: 'myapp', env: config.ENV }}
      />
    </NavigationContainer>
  );
}
```

`<Lynkeus>` renders nothing. Mount it once, anywhere under your navigation container. Its props:

| Prop | Default | Meaning |
|---|---|---|
| `enabled` | `__DEV__` | Whether the agent runs at all. |
| `navigation` | none | A navigation adapter. `reactNavigationAdapter(ref)` ships with the package. Without one you still get the screen, touches and waits, but no routes. |
| `host`, `port` | `localhost` (`10.0.2.2` on Android), `8123` | Where the driver listens. |
| `token` | none | The shared secret from step 3. |
| `app` | none | Free-form description sent when the app attaches (name, version, environment). |

The same rule as in step 3 applies to the `token` prop: leave the prop out and the agent serves without a token; pass it with an empty or undefined value and the agent stays off and logs why.

An app that uses both `auto()` and `<Lynkeus>` keeps working: the first one to start owns the connection, and the second stays quiet.

Two things are only available with `auto()`, because it wraps the root: `lynkeus record`, which turns a person's touches into steps, and `lynkeus profile`, which measures React rendering time per route.

## How it works

The app is the side that connects. When the agent starts, it opens a WebSocket to `localhost:8123` on the iOS simulator, or to `10.0.2.2:8123` on the Android emulator (the address an emulator uses to reach the machine it runs on). If nothing is listening, it stays quiet and tries again: every 100 ms for the first 3 seconds, then at growing intervals up to 1.5 seconds.

The CLI is the side that listens. Each `npx lynkeus …` command opens port 8123 on your machine's loopback address, waits for the app to dial in, sends the token, runs the command, and exits. Nothing listens inside the app, and nothing in it is reachable from the network.

## Platform notes

**iOS.** Touches are synthesized with private UIKit API, the technique KIF and Detox rely on. That code is wrapped in `#if DEBUG`: the symbols do not exist in a release binary. The New Architecture is required. More in [iOS](/platforms/ios/).

**Android.** Touches are `MotionEvent`s dispatched to the activity's window, and keys go through the focused `EditText`. The native module refuses to run unless the app is debuggable (`FLAG_DEBUGGABLE`). More in [Android](/platforms/android/).

## Common problems

### The CLI never attaches

```text
✗ No app attached on 127.0.0.1:8123 within 15000ms. Is a dev build running with <Lynkeus>?
```

The CLI listened for 15 seconds and no app dialed in with the right token. Check, in this order:

1. The app is running, and it is a debug build.
2. `enabled` is true for the environment this build points at.
3. The token reached the app. Look in the app's log, where its `console.warn` output goes, for `lynkeus: the app passed a token and it is empty`; if it is there, see the next problem.
4. The token the app was built with is the one the CLI reads: `LYNKEUS_TOKEN` in this shell, or else `.lynkeus/token`. When an app dials in and does not answer, the message ends with `An app connected but did not answer: its token is not this one` instead; restart Metro with `--reset-cache` from a shell with the CLI's token.
5. Nothing else moved the port. The app dials 8123 unless you passed `port`; the CLI listens on 8123 unless `LYNKEUS_PORT` or `port` in `lynkeus.config.json` says otherwise.

`--attach-timeout <ms>` gives the app longer. `--launch --app <bundleId>` relaunches the app before attaching.

### The app logs that the token is empty

```text
lynkeus: the app passed a token and it is empty, so the agent stays off. React Native gives the app no environment: add 'lynkeus-agent/babel' to the plugins in babel.config.js and start Metro with LYNKEUS_TOKEN set (after a change, with --reset-cache). In Expo, name the variable EXPO_PUBLIC_LYNKEUS_TOKEN.
```

The entry file reads `process.env.LYNKEUS_TOKEN` and nothing put a value there, so the agent stays off rather than serve whoever connects. The CLI then reports that no app attached. Check three things:

1. `babel.config.js` lists `'lynkeus-agent/babel'` among its plugins. `npx lynkeus init` adds it.
2. The project has a token: `.lynkeus/token` exists in the folder Metro runs from, or Metro was started from a shell where `LYNKEUS_TOKEN` is set. `npx lynkeus init` makes the file.
3. Metro was started once with `--reset-cache` after the token was made or changed. Without that, Metro serves the file it transformed earlier, when there was no value.

### The port is already taken

```text
✗ Port 8123 is already taken: another lynkeus run is probably still driving the app there. Stop it, or use another port (LYNKEUS_PORT, --ports).
```

Only one driver can hold the port. Another `lynkeus` command, session or MCP server is still running; stop it, or run this pair on another port.

### The native module is unavailable

```text
Lynkeus native module unavailable: debug builds only, and the app must be rebuilt after adding the package
```

Reading the screen works without the native module, so `lynkeus screen` can succeed while `lynkeus press` fails with this message. Rebuild the app (step 4), and confirm you are running a debug build.

### Routes are missing

If the first line of `lynkeus screen` starts with `?` instead of a route name, the agent sees elements but no route. With `auto()`, the agent looks for a React Navigation container for 20 seconds after the app mounts; an app that uses another router needs the explicit component with an adapter of its own. Without routes, `lynkeus wait Settings.Main` has nothing to wait for, but targets such as `#next-button` work as usual.

### No keyboard on the iOS simulator while typing

The simulator is taking keys from the Mac instead of showing its own keyboard. Turn off **I/O → Keyboard → Connect Hardware Keyboard** in the Simulator menu, or run:

```bash
defaults write com.apple.iphonesimulator ConnectHardwareKeyboard -bool false
```

## Next steps

- [Your first test](/getting-started/first-test/): drive the app by hand, then write and run a case.
- [Concepts](/getting-started/concepts/): the vocabulary used in the rest of the documentation.
- [Headless](/platforms/headless/): run the same app in Node, with no simulator.
- [Security](/security/): what the agent exposes and why it is debug-only.

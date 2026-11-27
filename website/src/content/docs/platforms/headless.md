---
title: Headless
description: Run the app in Node with no simulator. What the headless host is, how to set it up, the commands that stand in for the operating system, and what it cannot tell you.
---

The headless host runs your app in Node, with no simulator, no emulator and no native build. `lynkeus headless start` renders the app under Jest and React Native Testing Library, and the agent inside it dials the driver exactly as it does on a device. Every drive command and every case works unchanged.

It exists for speed and scale. A host starts in about 40 seconds, several run side by side on one machine, and nothing waits for an animation. That makes it the usual choice for CI and for running a large suite on every pull request. It is not a replacement for a device: the native layer is mocked, so some things cannot be observed at all. This page ends with that list, and you should read it before deciding what runs where.

## What is real and what is not

| | Headless host | Simulator or emulator |
|---|---|---|
| Your JavaScript: screens, state, navigation | Real | Real |
| Requests to your backend | Real, limited to local addresses by default. A body that is not JSON reaches the app as its own `SyntaxError`, as on a phone | Real |
| Layout: frames, what is covered, scrolling | Computed with Yoga | Real |
| Native modules: storage, keychain, camera, biometrics | Mocked | Real |
| WebView contents | An empty box | Real |
| Pixels and screenshots | None | Real |
| Deep links, clock, app state, network failures | Commands you send | The real thing |

## Before you start

- The agent is mounted in the app. See [Install in a React Native app](/getting-started/installation-react-native/).
- Jest works in the project, with the React Native preset and the app's own Babel transform. The host runs the app through your Jest configuration.
- jest, `@testing-library/react-native` and `lynkeus-headless` are installed as development dependencies. `lynkeus headless init` adds what is missing, with the jest preset the app needs (`jest-expo` for Expo), using the package manager of the project. `--no-install` leaves that to you.

- Node 22 or newer.
- An app with a root component the host can import (`App.tsx` and the like), or an Expo Router app (since 0.4.0; see [An Expo Router app](#an-expo-router-app)).
- A backend the app can reach on a local address, if the app needs one to get past its first screen.

## Steps

### 1. Write the headless entry

The **entry** is one file that tells the host how to load your app. It is the only place that knows your app's specifics: which native modules to mock beyond the defaults, and where the root component is.

```bash
npx lynkeus headless init
```

You should see what it did and what to do next:

```text
installed jest, @testing-library/react-native, lynkeus-headless (npm install --save-dev …)
wrote cases/headless.tsx (runs index.js, which registers the default export of src/App.tsx)
made a token for this project in .lynkeus/token (kept out of git); the CLI and the MCP server read it
jest: when the app has no jest configuration, `headless start` passes the preset it needs …
next: lynkeus headless start  (the app reads its API address from API_URL: set it, or "apiUrl" in lynkeus.config.json, to your local backend; the token is the project's, in .lynkeus/token)
      or, in one go: lynkeus case here first-screen --host --write, then lynkeus case run --host  (lynkeus headless doctor lists what still needs a mock)
```

`init` also makes the project's token in `.lynkeus/token` when there is none, because `headless start` refuses to run without one and an app tested only headless never runs `lynkeus init`.

The entry goes next to your cases, in `<cases.dir>/headless.tsx`. If the project already has a `qa/headless.tsx`, that one is kept. `--entry` or `entry` in `lynkeus.config.json` choose another place.

Lynkeus finds the environment variable your app reads its API address from, by reading the source. There is no default: an app that reads none gets none. `--api-env <NAME>` (or `apiEnv` in the configuration) overrides what it found. `init` finds the root component through the app's own entry, the one that calls `registerRootComponent` or `AppRegistry.registerComponent`; otherwise pass `--component <path>`. When it finds none, it stops with `no App component found`. Add `--auto` to also insert the `auto()` call into `index.js` if you have not mounted the agent yet. `--force` overwrites an existing entry.

The generated file looks like this:

```tsx title="cases/headless.tsx"
import { installDefaultMocks, registeredApp } from 'lynkeus-headless/mocks'

installDefaultMocks({
  // Real requests, to local hosts only (add others with networkHosts).
  network: 'real',
  // locale: { country: 'DE', languageTag: 'de-DE', languageCode: 'de' },
})

// App-specific mocks go here, before the app is required:
//   jest.mock('some-native-package', () => ({ method: async () => 'what a device answers' }))

// The app's own entry runs as on a device; the component it registers is the App.
const App = registeredApp(() => require('../index'))

export { App }
```

It has three parts:

- **No guard on the API address.** The entry does not refuse an address that is not local. The host's network fence does that work: with `network: 'real'`, the app reaches only the hosts in `networkHosts`, which defaults to loopback, so an automated run cannot act against production by accident. Requests that a `lynkeus mock` rule answers are the exception. They never leave the process, so they are answered even for hosts outside `networkHosts`.
- **`installDefaultMocks`** replaces the native modules that would fail in Node. `network: 'real'` lets the app reach your backend; without it, Jest's default ban on network requests stays in place.
- **The export.** The entry must export `App`. It may also export `navigation`, an adapter, for an app whose router the agent cannot find by itself. Lynkeus finds React Navigation by itself, so most apps need none.

Because the entry runs the app's own `index.js`, whatever it does before rendering (polyfills, internationalization setup, service initialization) runs here too.

### 2. Allow Lynkeus through Jest's transform

The agent is published as ES modules. A Jest configuration that only transforms `react-native` packages will not parse it, and the host stops at `Unexpected token 'export'` in `lynkeus-agent`. Add `lynkeus-[^/]+` to the allow-list in `transformIgnorePatterns`, next to `react-native`:

```js title="jest.config.js"
module.exports = {
  preset: '@react-native/jest-preset',
  transformIgnorePatterns: ['node_modules/(?!(react-native|@react-native|lynkeus-[^/]+)/)'],
};
```

Adapt the pattern to the one you already have; the point is that `lynkeus-agent` and `lynkeus-headless` are transformed. When the app has no Jest configuration of its own, you need none of this: the host detects the packages Jest must transpile instead of using a fixed list.

### 3. Check which native modules need a mock

```bash
npx lynkeus headless doctor
```

`doctor` reads your source without running anything and reports three things: which installed libraries Lynkeus mocks for you, which mocks your entry adds, and which native modules your code references that nothing covers. A report looks like this:

```text
lynkeus headless doctor — headless readiness for myapp

Auto-mocked by Lynkeus (installDefaultMocks):
  ✓ react-native-mmkv
  ✓ react-native-safe-area-context

Mocked in cases/headless.tsx (app-specific):
  (none beyond the Lynkeus defaults)
  network: real

Native modules your app's source references:
  ⚠ Updater                      src/native/Updater.ts:4  (NativeModules)

1 native module(s) look unmocked. Under jest they do not exist, so
the app can crash when it touches them. Add a mock for each in cases/headless.tsx:
  jest.mock('...Updater...', () => ({ /* the methods your app calls */ }))
```

`npx lynkeus headless doctor --fix` writes stubs into the entry for the uncovered modules that come from packages, and a `TODO` comment for each one that is local to your app. A stub is an empty object: it gets the app past the import, and you fill in the methods the app calls.

The scan is a heuristic. A module it flags may already be covered by a wrapper you mock; review the list.

### 4. Start the host

`headless start` needs the project's token and refuses to run without it. It reads `.lynkeus/token`, which `init` made, or `LYNKEUS_TOKEN` in the environment, which wins:

```bash
API_URL=http://127.0.0.1:3000/ npx lynkeus headless start
```

When the app has a local backend, give its address either in the variable the app reads it from (`API_URL` here; Lynkeus detects the name, and `apiEnv` in `lynkeus.config.json` overrides it) or as `apiUrl` in `lynkeus.config.json`; the variable wins.

You should see Jest start, the host's log lines, and finally:

```text
hosting; waiting for a driver (press Ctrl-C or call the exit command to stop)
```

The host stays in the foreground until you stop it. Arguments after `--` are passed to Jest.

### 5. Drive it

In another shell, in the same project, so that it reads the same token:

```bash
npx lynkeus screen
```

You should see `attached in …ms (headless host)` on standard error, then your app's first screen. From here every command from [Your first test](/getting-started/first-test/) works as it does on a device.

### 6. Run cases on it

With the host running, `npx lynkeus case run` uses it like any other host. To have the run start a host and stop it afterwards, add `--host`:

```bash
API_URL=http://127.0.0.1:3000/ npx lynkeus case run --host
```

You should see `host: up (its log: …)` once the host is ready, then the cases. The run waits up to 180 seconds for the host to come up, and reports the last lines of its output if it does not.

With `--host`, the run also looks after the host. If it dies during a case (out of memory, a crash) or its app stops answering, the run starts it again before the next case, so the cases after it do not all fail with `No app attached`. The case that lost the host still fails, and its reasons say how the host ended, with its last words and its log; the host started again writes a log of its own. Before each case, the run reads the host's heap (one line in the log) and starts it again past `--host-heap` percent of its limit, 60 unless told. See [Hosts that die](/reference/cli/#hosts-that-die).

**Cases on one host start fresh.** A host that serves several cases (`--host`, or `--keep-hosts` with a host command that runs `headless start`, which `lynkeus ci` uses) is reset before each case after its first, in about 200 ms: its mocked storage (MMKV, keychain, AsyncStorage), network rules, clock, offline state and native mocks are emptied, the app's own `reset` command runs when it registered one, and the app is mounted again, so navigation starts over. The case's log says so with a `↺` line. One thing survives: what the app keeps at module scope, such as a query cache or a store created when a file is imported, because the app's modules are loaded once per host. When cases see each other's data that way, give each case a host of its own with `--host-command` and no `--keep-hosts`, at the cost of a host start per case.

## How it works

`headless start` writes a Jest test file under `.lynkeus/host/` that imports your entry and renders its `App` with React Native Testing Library, then runs Jest on that one file. The test never ends: it hosts the app until you stop it.

Inside, the agent is the same code as on a device with a different backend underneath. It reads the same React tree. Layout is computed with Yoga, so elements have frames, a swipe across a scroller scrolls it, and the frames follow the scroll. The host also respects what a device would refuse: a swipe on an element that is not presented fails.

Jest's stand-ins lose some of the styles a device applies, and the host puts them back where it can tell: a scroll view's `contentContainerStyle` goes on the view that holds its content, and a library's native view with no size of its own (a keyboard or gesture provider) that only wraps a screen meant to fill fills like it. Without that, a whole screen collapsed to no height, each field lay on the next, and a control read as covered made every press and type into it wait for it to clear.

The host renders without `React.StrictMode`. Production has none, and its double renders and double-mounted effects would double every request and every millisecond the host measures. `"strictMode": true` in `lynkeus.config.json` keeps it.

## The entry in detail

`installDefaultMocks` mocks these libraries when they are installed: MMKV, keychain, device-info, safe-area-context, react-native-localize, expo-localization, async-storage, worklets, pager-view and webview. A library's own shipped Jest mock or Jest setup file is used automatically. Reanimated and gesture-handler are deliberately left alone, because their Jest support is a Babel plugin rather than a mock.

The mocks for biometrics, in-app-review, vision-camera, image-picker, video, fast-image and the native half of vector-icons are opt-in. Pass the ones the app needs through `overrides`:

```tsx
import { installDefaultMocks, biometrics, imagePicker } from 'lynkeus-headless/mocks'

installDefaultMocks({
  network: 'real',
  overrides: { 'react-native-biometrics': biometrics, 'react-native-image-picker': imagePicker },
})
```

A native module that nobody provides is answered empty: each of its methods resolves `undefined`. Each run and `lynkeus headless doctor` list those modules and how to give a real answer, which is a `jest.mock` in the entry or `cases.nativeMocks`. SDK screens that cannot run under Jest, such as identity verification or a messenger, stand in only when `cases.nativeMocks` lists them.

`XMLHttpRequest`, the Expo app config and Metro's script URL are provided, so axios, Reactotron and expo-linking work. Jest runs from `.lynkeus/host/`, never in the app's own Jest. The host takes back the unit-test mocks of the app's Jest setup, unless that setup reads `LYNKEUS_HEADLESS`. React Native Testing Library 12, 13 and 14 are supported, and `headless doctor` checks the version.

Its options:

| Option | Default | Meaning |
|---|---|---|
| `network` | `'banned'` | `'real'` replaces Jest's banned `fetch` with Node's own, restricted to `networkHosts`. |
| `networkHosts` | local hosts only | The hosts that real requests and sockets may reach. Anything else is refused at once. |
| `websocket` | `'stub'` | What `WebSocket` is. `'stub'` connects and stays silent; `'real'` is a real socket, restricted to `networkHosts`; `'none'` leaves it undefined. |
| `animations` | `'deferred'` | Reanimated's mock completes `withTiming` and `withSpring` synchronously, which can loop forever when a completion triggers another animation. `'deferred'` moves completions to the next tick; `'sync'` leaves the mock as the app registered it. |
| `locale` | US, `en-US`, `en`, America/New_York | The locale the app reads, for example `{ country: 'DE', languageTag: 'de-DE', languageCode: 'de' }`. `case run --locale` and `--time-zone` win over it. |
| `deviceVersion` | version 9.9.9, build 9999, iOS | What the device-info mock reports. |
| `initialUrl` | none | What `Linking.getInitialURL` answers: the deep link the app was opened with. |
| `skip` | none | Modules to leave alone, so that you mock them yourself. |
| `overrides` | none | Your own mock factories by module name. One wins over the default, and applies even when the module is not installed. |

**Language and time zone.** A run started with `--locale es-AR` (or `launch.locale` in `lynkeus.config.json`) reaches the app wherever it asks: expo-localization, react-native-localize, and `Intl` itself, so `toLocaleString()` and `new Intl.NumberFormat()` with no locale format for es-AR. Separators, currency, 12- or 24-hour clock and first weekday are what Intl says a phone in that locale shows. `--time-zone` moves both what those libraries report and the zone `Date` runs in (the host's `TZ`). The `locale` option in the entry sets the same answers when no run says otherwise, but cannot move `Date`'s zone, which only the host's environment sets.

Mocks for your own native modules are ordinary `jest.mock` calls in the entry, placed before the app is required:

```tsx title="cases/headless.tsx"
jest.mock('../src/native/Updater', () => ({
  checkForUpdate: async () => ({ available: false }),
}));
```

The entry's path and the API variable can live in the configuration, so you do not pass them on every call:

```json title="lynkeus.config.json"
{
  "entry": "cases/headless.tsx",
  "apiEnv": "API_URL"
}
```

## Commands that stand in for the operating system

Under the host, what a device would receive from the outside world is a command. These work only on the headless host, except `os deeplink`, `os appstate` and `mock`, which also work on a simulator or an emulator. On a device you get the real thing instead.

| Command | What the app experiences |
|---|---|
| `lynkeus os deeplink <url>` | Its `Linking` listeners receive the URL, React Navigation's included. |
| `lynkeus os appstate <active\|background\|inactive>` | `AppState` listeners see the change. Send `background`, then `active`, to test what refetches or locks again on return. On a simulator or an emulator the OS does it for real, and `inactive` does not exist. |
| `lynkeus os network <off\|on>` | Airplane mode: requests fail, open sockets drop, NetInfo listeners are told. |
| `lynkeus os clock --now <iso>` | What `Date` answers. Timers run on real time, so a countdown still ticks in real seconds. `--advance <ms>` moves the clock forward and runs the timers and intervals that fall due inside it, each at its own due time, without waiting; `--reset` returns `Date` to the real clock; `--settle` waits a few event-loop turns until the screen stops committing, without waiting for timers due later. |
| `lynkeus os biometrics --available <FaceID\|TouchID\|none> --next <outcomes>` | The sensor the device has, and what the next prompts answer, in order: `success`, `fail`, `cancel`. `--fallback <outcome>` sets what a fallback prompt answers. |
| `lynkeus os scan <value> [--type qr]` | The open camera's code scanner receives a value. |
| `lynkeus os gallery <uri> [--name] [--mime]` | What the next image picker returns. `--cancel` makes the user cancel. |

### Mocking the network

`lynkeus mock` answers a request before it reaches the network: on the headless host the host answers, and on a device the agent does, inside the app. Error states, timeouts and empty states become one line each, with no backend fixture:

```bash
npx lynkeus mock 'GET /v3/accounts' --status 500 --delay 3000   # a slow failure
npx lynkeus mock '/v3/accounts' --body '[]' --times 1           # any method; only once
npx lynkeus mock 'GET /v3/session' --status 401 --sticky        # survives an app reset
npx lynkeus mock 'POST /v3/payments' --lost                     # sent; only the answer is lost
npx lynkeus mock --list
npx lynkeus mock --clear
```

| Flag | Default | Meaning |
|---|---|---|
| `--status <code>` | `200` | The HTTP status to answer. |
| `--body <json>` | none | The JSON body. |
| `--delay <ms>` | none | Answer after this long. |
| `--times <n>` | every time | Apply the rule only this many times. |
| `--sticky` | off | Keep the rule across an app reset. Without it, the app's `reset` command drops the rule. |
| `--lost` | off | Send the request to the server and lose only its answer. The app sees a failed request and the server has acted on it, as after a dropped connection. |
| `--list`, `--clear` | | Show the rules, or drop them all. |

A request that a rule answered or lost is marked `mocked`. `lynkeus requests` and `lynkeus trace` print `(mocked)` on it, and so does the evidence of a failed case, whose reasons never blame the backend for an answer the case made. The host's network marks its answers with the response header `x-lynkeus-mocked`; that is how the agent tells them from the server's.

In a case these are steps: `app.mock`, `app.network`, `app.appstate`, `app.deeplink`, with the same arguments by name. A step that the host the case runs on cannot do, such as `app.network` on a simulator, is reported as unsupported there: the case stops, and the run does not fail because of it. Use `on: headless` to keep such a step to the host that can do it.

## Running several hosts

Each host and its driver are a pair on one port. `LYNKEUS_PORT` moves both, so pairs do not collide:

```bash
LYNKEUS_PORT=8201 npx lynkeus headless start
LYNKEUS_PORT=8201 npx lynkeus screen
```

`LYNKEUS_HOST` tells a host where its driver is listening, for a host that does not run in the same place as its driver, such as a container dialing out.

`lynkeus case run --jobs <n> --ports <list>` runs cases in parallel, each job on its own host. With `--host`, the run starts one headless host per job, each dialing its job's port (picked free when `--ports` is left out), keeps it for the run and starts it again when it dies; each writes its log to the system's temporary folder, named after the run and the port. See [Writing cases](/guides/writing-cases/) and [Running on CI](/guides/ci/).

## Security

- `headless start` refuses to run without a token, from `.lynkeus/token` or `LYNKEUS_TOKEN`. A hosted app talks to a real backend, and without a token any local process could drive it.
- With `network: 'real'`, the host refuses any address outside `networkHosts`, which defaults to loopback.
- The guard in the generated entry checks that the API URL is local before the app is rendered.

## What headless cannot tell you

The host runs your JavaScript against a real backend with the native layer mocked. These are left out on purpose:

- **The real camera and decoder.** `lynkeus os scan` hands the open scanner a value; nothing is decoded.
- **Complex native gestures.** A swipe is driven through the gesture handler, not by a finger.
- **Push delivery.** A simulator can be pushed from outside with `lynkeus os push`.
- **What a WebView renders.** It is an empty box. The boundary is still testable: what the app sends the WebView and what it does with the messages that come back.
- **Native crashes.** There is no native code to crash. A native module that is missing surfaces as a Jest error instead.
- **Pixels.** The host renders nothing to capture. `lynkeus screenshot` and `lynkeus snapshot --pixels` need a simulator; the tree baseline of `lynkeus snapshot` works under the host.
- **Video.** `case run --video` films a case only where the host offers a `record` command, which it names in `hello`. The built-in headless host draws nothing, so it offers none and a run has no video.

For those, run the same cases on a simulator or emulator. Only the way the app is started differs.

### An Expo Router app

Since 0.4.0, an Expo Router app runs on the headless host. It has no root component to import, since its screens are files the router loads, so the entry renders the router itself over the route files. `lynkeus headless init` writes that entry when it finds `expo-router` and an `app/` or `src/app/` folder:

```tsx title="cases/headless.tsx (the end of it)"
process.env.EXPO_ROUTER_IMPORT_MODE = 'sync'
const { getMockContext } = require('expo-router/testing-library')
const React = require('react')
const { ExpoRoot } = require('expo-router')
const routes = getMockContext(require('path').resolve(__dirname, '../src/app'))
require('lynkeus-agent/auto').auto({ token: process.env.LYNKEUS_TOKEN })
const App = () => React.createElement(ExpoRoot, { context: routes })
```

`expo-router/testing-library` is Expo's own way to render the router under Jest. It also stands in for `expo-linking` and Reanimated, so it is loaded before the router. `auto()` mounts the agent as a development build does, and the agent then finds the router's navigation by itself: `lynkeus screen` prints `index (__root > index)`, and `nav` goes to a route by its expo-router name.

For an Expo app with no Jest setup of its own, `headless init` installs `jest-expo` with Expo's installer, which picks the version of the app's SDK. `headless start` gives Jest that preset, maps style sheets (the Expo template imports `global.css`) to an empty module, and maps the aliases in `tsconfig.json`'s `paths`, the longest first.

Tried on a new Expo SDK 57 project with React Native 0.86: a case that reads the home screen, goes to `explore` and reads it passes in under half a second. The native tab bar of the newest template is not drawn by React Native, so its tabs are not on the screen there either; go to a tab's route with `nav`.

## Common problems

**`headless init` stops with `no App component found`.** The root component is not in a standard place: pass `--component <path>`. An Expo Router app needs no component; that message there means `expo-router` is not installed or the routes are not in `app/` or `src/app/`.

**The host stops with `Unexpected token 'export'`.** Jest is not transforming `lynkeus-agent`. See step 2.

**The host crashed with a Jest error you do not recognize.** When the host exits with an error, its last lines say what that error usually means. For an error you have at hand, paste its first line, not the stack:

```bash
npx lynkeus headless doctor --explain "<first line of the error>"
```

**The app never leaves the splash screen.** Usually a native module that nothing mocks: run `lynkeus headless doctor` and mock what it lists. The other cause is Node resolving `localhost` to IPv6 while your backend listens on IPv4; use `127.0.0.1` in the API URL.

**A change to an environment variable has no effect.** If your Babel configuration inlines environment variables, Jest's transform cache keeps the first value it saw. `headless start` keeps a cache per value of the variable `apiEnv` names (under `.lynkeus/jest-cache/`), so changing the API address takes effect, at the cost of a slower first start with a new one. For any other inlined variable, remove `.lynkeus/jest-cache/`.

**A screen never settles.** A screen that keeps re-rendering, such as a countdown or a spinner, never goes idle, and `lynkeus idle` answers `idle: false`. That is information about the screen, not a fault in the host. If the cause is one control whose content changes on its own, list its `testID` pattern under `live` in `lynkeus.config.json` and its text stops counting.

**Screens never load and the host says `did not answer (ECONNREFUSED)`.** The backend is not up at that address, or the app is not using the one you meant: it reads its API base from the env var `apiEnv` names (or `apiUrl` in `lynkeus.config.json`), and falls back to its own default when neither is set where `headless start` runs.

**Two hosts fight over the port.** The driver keeps whichever host dialed in last, so two hosts on one port take turns and a step can land on the wrong app (a command one has and the other lacks fails as `this host has no …`). The CLI warns once with `Another app attached on port …`, naming both. Stop the host you left running, or set `LYNKEUS_PORT` on both the host and the driver of each pair.

**Memory over a long run.** Every `jest.fn()` the app's mocks are made of keeps what it was called with, for a test to read. Under the host nothing reads it, so the host clears those records every 10 seconds and the mocks keep what they do. Left alone, they grew by some 20 MB per sign-in and screen in a large app and ran a 4 GB heap out in about 30 cases. What is left grows slowly. `lynkeus call memory` reads the heap after a collection, with no `--expose-gc` (which `NODE_OPTIONS` refuses), and says where the heap stops (`heapLimitMb`), so a runner can compare a reading with the next case's and with the limit. `case run --host` does this itself: it starts the host again past `--host-heap` percent of the limit (60 by default). A runner of your own that drives hundreds of cases on one host can do the same.

## Next steps

- [Running on CI](/guides/ci/): the headless host in a pipeline.
- [Writing cases](/guides/writing-cases/): `on: headless`, parallel jobs, and steps that only one host can do.
- [Configuration](/reference/configuration/): `entry`, `apiEnv`, `strictMode`, `live` and the rest.
- [Environment variables](/reference/environment-variables/): `LYNKEUS_TOKEN`, `LYNKEUS_PORT`, `LYNKEUS_HOST`.

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
| Requests to your backend | Real, limited to local addresses by default | Real |
| Layout: frames, what is covered, scrolling | Computed with Yoga | Real |
| Native modules: storage, keychain, camera, biometrics | Mocked | Real |
| WebView contents | An empty box | Real |
| Pixels and screenshots | None | Real |
| Deep links, clock, app state, network failures | Commands you send | The real thing |

## Before you start

- The agent is mounted in the app. See [Install in a React Native app](/getting-started/installation-react-native/).
- Jest works in the project, with the React Native preset and the app's own Babel transform. The host runs the app through your Jest configuration.
- `lynkeus-headless` and `@testing-library/react-native` are installed as development dependencies:

  ```bash
  yarn add -D lynkeus-headless @testing-library/react-native
  ```

- Node 22 or newer.
- An app with a root component the host can import (`App.tsx` and the like). An app that uses Expo Router has none, and cannot run on the headless host; see [What headless cannot tell you](#what-headless-cannot-tell-you).
- A backend the app can reach on a local address, if the app needs one to get past its first screen.

## Steps

### 1. Write the headless entry

The **entry** is one file that tells the host how to load your app. It is the only place that knows your app's specifics: which native modules to mock beyond the defaults, and where the root component is.

```bash
npx lynkeus headless init --api-env API_URL
```

You should see what it wrote and what to do next:

```text
wrote qa/headless.tsx (app: src/App.tsx)
jest: make sure transformIgnorePatterns lets 'lynkeus-[^/]+' through, next to react-native (lynkeus headless doctor checks it)
next: LYNKEUS_TOKEN=<token> API_URL=http://127.0.0.1:3000/ lynkeus headless start
      then, in another shell: lynkeus screen  (or lynkeus headless doctor to see what still needs a mock)
```

`--api-env` names the environment variable your app reads its API base URL from; it defaults to `API_URL`. `init` finds the root component when it is in a standard place (`App.tsx`, `App.jsx` or `App.js`, at the root or under `src/`, or `app/App.tsx`); otherwise pass `--component <path>`. When it finds none, it stops with `no App component found`. Add `--auto` to also insert the `auto()` call into `index.js` if you have not mounted the agent yet. `--force` overwrites an existing entry.

The generated file looks like this:

```tsx title="qa/headless.tsx"
import { installDefaultMocks } from 'lynkeus-headless/mocks'

// Refuse anything that is not a local backend.
const apiUrl = process.env.API_URL ?? ''
if (!/^https?:\/\/(localhost|127\.0\.0\.1|10\.0\.2\.2)(:\d+)?(\/|$)/.test(apiUrl)) {
  throw new Error(`lynkeus headless only drives a local backend; API_URL is "${apiUrl}"`)
}

installDefaultMocks({
  network: 'real',
})

// App-specific mocks go here, before the app is required:
//   jest.mock('some-native-package', () => ({ method: () => undefined }))

const { default: App } = require('../src/App')

export { App }
```

It has three parts:

- **The guard** stops the host before the app renders if the API URL does not point at a local address. A hosted app with real network access is exactly what would let an automated run act against production by accident.
- **`installDefaultMocks`** replaces the native modules that would fail in Node. `network: 'real'` lets the app reach your backend; without it, Jest's default ban on network requests stays in place.
- **The export.** The entry must export `App`. It may also export `navigation`, an adapter, for an app whose router the agent cannot find by itself.

If your app's `index.js` runs anything before rendering (polyfills, internationalization setup, service initialization), require it in the entry too, before the app.

### 2. Allow lynkeus through Jest's transform

The agent is published as ES modules. A Jest configuration that only transforms `react-native` packages will not parse it, and the host stops at `Unexpected token 'export'` in `lynkeus-agent`. Add `lynkeus-[^/]+` to the allow-list in `transformIgnorePatterns`, next to `react-native`:

```js title="jest.config.js"
module.exports = {
  preset: '@react-native/jest-preset',
  transformIgnorePatterns: ['node_modules/(?!(react-native|@react-native|lynkeus-[^/]+)/)'],
};
```

Adapt the pattern to the one you already have; the point is that `lynkeus-agent` and `lynkeus-headless` are transformed.

### 3. Check which native modules need a mock

```bash
npx lynkeus headless doctor
```

`doctor` reads your source without running anything and reports three things: which installed libraries lynkeus mocks for you, which mocks your entry adds, and which native modules your code references that nothing covers. A report looks like this:

```text
lynkeus headless doctor — headless readiness for myapp

Auto-mocked by lynkeus (installDefaultMocks):
  ✓ react-native-mmkv
  ✓ react-native-safe-area-context

Mocked in qa/headless.tsx (app-specific):
  (none beyond the lynkeus defaults)
  network: real

Native modules your app's source references:
  ⚠ Updater                      src/native/Updater.ts:4  (NativeModules)

1 native module(s) look unmocked. Under jest they do not exist, so
the app can crash when it touches them. Add a mock for each in qa/headless.tsx:
  jest.mock('...Updater...', () => ({ /* the methods your app calls */ }))
```

`npx lynkeus headless doctor --fix` writes stubs into the entry for the uncovered modules that come from packages, and a `TODO` comment for each one that is local to your app. A stub is an empty object: it gets the app past the import, and you fill in the methods the app calls.

The scan is a heuristic. A module it flags may already be covered by a wrapper you mock; review the list.

### 4. Start the host

`headless start` needs the token in the environment and refuses to run without it:

```bash
LYNKEUS_TOKEN=some-local-secret API_URL=http://127.0.0.1:3000/ npx lynkeus headless start
```

You should see Jest start, the host's log lines, and finally:

```text
hosting; waiting for a driver (press Ctrl-C or call the exit command to stop)
```

The host stays in the foreground until you stop it. Arguments after `--` are passed to Jest.

### 5. Drive it

In another shell, with the same token:

```bash
export LYNKEUS_TOKEN=some-local-secret
npx lynkeus screen
```

You should see `attached in …ms (headless host)` on standard error, then your app's first screen. From here every command from [Your first test](/getting-started/first-test/) works as it does on a device.

### 6. Run cases on it

With the host running, `npx lynkeus case run` uses it like any other host. To have the run start a host and stop it afterwards, add `--host`:

```bash
LYNKEUS_TOKEN=some-local-secret API_URL=http://127.0.0.1:3000/ npx lynkeus case run --host
```

You should see `host: up` once the host is ready, then the cases. The run waits up to 180 seconds for the host to come up, and reports the last lines of its output if it does not.

## How it works

`headless start` writes a Jest test file under `.lynkeus/__tests__/` that imports your entry and renders its `App` with React Native Testing Library, then runs Jest on that one file. The test never ends: it hosts the app until you stop it.

Inside, the agent is the same code as on a device with a different backend underneath. It reads the same React tree. Layout is computed with Yoga, so elements have frames, a swipe across a scroller scrolls it, and the frames follow the scroll. The host also respects what a device would refuse: a swipe on an element that is not presented fails.

The host renders without `React.StrictMode`. Production has none, and its double renders and double-mounted effects would double every request and every millisecond the host measures. `"strictMode": true` in `lynkeus.config.json` keeps it.

## The entry in detail

`installDefaultMocks` mocks these libraries when they are installed: MMKV, keychain, device-info, safe-area-context, localize, async-storage, worklets, pager-view, video, fast-image, biometrics, in-app-review, webview, vision-camera, image-picker, and the native half of vector-icons (an icon rendered to an image gets a file path back). Reanimated and gesture-handler are deliberately left alone, because their Jest support is a Babel plugin rather than a mock.

Its options:

| Option | Default | Meaning |
|---|---|---|
| `network` | `'banned'` | `'real'` replaces Jest's banned `fetch` with Node's own, restricted to `networkHosts`. |
| `networkHosts` | local hosts only | The hosts that real requests and sockets may reach. Anything else is refused at once. |
| `websocket` | `'stub'` | What `WebSocket` is. `'stub'` connects and stays silent; `'real'` is a real socket, restricted to `networkHosts`; `'none'` leaves it undefined. |
| `animations` | `'deferred'` | Reanimated's mock completes `withTiming` and `withSpring` synchronously, which can loop forever when a completion triggers another animation. `'deferred'` moves completions to the next tick; `'sync'` leaves the mock as the app registered it. |
| `locale` | US, `en-US`, `en` | The locale the localize mock reports, for example `{ country: 'DE', languageTag: 'de-DE', languageCode: 'de' }`. |
| `deviceVersion` | version 9.9.9, build 9999, iOS | What the device-info mock reports. |
| `initialUrl` | none | What `Linking.getInitialURL` answers: the deep link the app was opened with. |
| `skip` | none | Modules to leave alone, so that you mock them yourself. |
| `overrides` | none | Your own mock factories by module name. One wins over the default, and applies even when the module is not installed. |

Mocks for your own native modules are ordinary `jest.mock` calls in the entry, placed before the app is required:

```tsx title="qa/headless.tsx"
jest.mock('../src/native/Updater', () => ({
  checkForUpdate: async () => ({ available: false }),
}));
```

The entry's path and the API variable can live in the configuration, so you do not pass them on every call:

```json title="lynkeus.config.json"
{
  "entry": "qa/headless.tsx",
  "apiEnv": "API_URL"
}
```

## Commands that stand in for the operating system

Under the host, what a device would receive from the outside world is a command. These work only on the headless host, except `os deeplink`, which works everywhere. On a device you get the real thing instead.

| Command | What the app experiences |
|---|---|
| `lynkeus os deeplink <url>` | Its `Linking` listeners receive the URL, React Navigation's included. |
| `lynkeus os appstate <active\|background\|inactive>` | `AppState` listeners see the change. Send `background`, then `active`, to test what refetches or locks again on return. |
| `lynkeus os network <off\|on>` | Airplane mode: requests fail, open sockets drop, NetInfo listeners are told. |
| `lynkeus os clock --now <iso>` | What `Date` answers. Timers stay real. `--advance <ms>` moves it forward; `--reset` returns to the real clock. |
| `lynkeus os biometrics --available <FaceID\|TouchID\|none> --next <outcomes>` | The sensor the device has, and what the next prompts answer, in order: `success`, `fail`, `cancel`. `--fallback <outcome>` sets what a fallback prompt answers. |
| `lynkeus os scan <value> [--type qr]` | The open camera's code scanner receives a value. |
| `lynkeus os gallery <uri> [--name] [--mime]` | What the next image picker returns. `--cancel` makes the user cancel. |

### Mocking the network

`lynkeus mock` answers a request before it reaches the network. Error states, timeouts and empty states become one line each, with no backend fixture:

```bash
npx lynkeus mock 'GET /v3/accounts' --status 500 --delay 3000   # a slow failure
npx lynkeus mock '/v3/accounts' --body '[]' --times 1           # any method; only once
npx lynkeus mock 'GET /v3/session' --status 401 --sticky        # survives an app reset
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
| `--lost` | off | Let the request reach the server, and fail it on the way back. |
| `--list`, `--clear` | | Show the rules, or drop them all. |

In a case these are steps: `app.mock`, `app.network`, `app.appstate`, `app.deeplink`, with the same arguments by name. A case that uses one and runs on a device does not fail there: the step is reported as unsupported on that host, the case stops, and the run does not fail because of it. Use `on: headless` to keep such a step to the host that can do it.

## Running several hosts

Each host and its driver are a pair on one port. `LYNKEUS_PORT` moves both, so pairs do not collide:

```bash
LYNKEUS_PORT=8201 LYNKEUS_TOKEN=secret npx lynkeus headless start
LYNKEUS_PORT=8201 LYNKEUS_TOKEN=secret npx lynkeus screen
```

`LYNKEUS_HOST` tells a host where its driver is listening, for a host that does not run in the same place as its driver, such as a container dialing out.

`lynkeus case run --jobs <n> --ports <list>` runs cases in parallel, each job on its own host. See [Writing cases](/guides/writing-cases/) and [Running on CI](/guides/ci/).

## Security

- `headless start` refuses to run without `LYNKEUS_TOKEN`. A hosted app talks to a real backend, and without a token any local process could drive it.
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

An Expo Router app cannot run on the headless host. The host imports the app's root component and renders it, and an Expo Router app has no root component to export: its screens are files the router loads. `lynkeus headless init` stops with `no App component found`. Such an app runs on a simulator or an emulator.

## Common problems

**`headless init` stops with `no App component found`.** The root component is not in a standard place: pass `--component <path>`. If the app uses Expo Router, there is no root component to point at, and the app cannot run on the headless host.

**The host stops with `Unexpected token 'export'`.** Jest is not transforming `lynkeus-agent`. See step 2.

**The host crashed with a Jest error you do not recognize.** When the host exits with an error, its last lines say what that error usually means. For an error you have at hand, paste its first line, not the stack:

```bash
npx lynkeus headless doctor --explain "<first line of the error>"
```

**The app never leaves the splash screen.** Usually a native module that nothing mocks: run `lynkeus headless doctor` and mock what it lists. The other cause is Node resolving `localhost` to IPv6 while your backend listens on IPv4; use `127.0.0.1` in the API URL.

**A change to an environment variable has no effect.** If your Babel configuration inlines environment variables, Jest's transform cache keeps the first value it saw. Remove the cache directory your Jest configuration points at.

**A screen never settles.** A screen that keeps re-rendering, such as a countdown or a spinner, never goes idle, and `lynkeus idle` answers `idle: false`. That is information about the screen, not a fault in the host. If the cause is one control whose content changes on its own, list its `testID` pattern under `live` in `lynkeus.config.json` and its text stops counting.

**Two hosts fight over the port.** Set `LYNKEUS_PORT` on both the host and the driver of each pair.

**Memory grows over a long run.** Node's heap grows by a few dozen megabytes per full app reset. A runner that drives hundreds of cases on one host should restart the host when `lynkeus call memory` reports too much.

## Next steps

- [Running on CI](/guides/ci/): the headless host in a pipeline.
- [Writing cases](/guides/writing-cases/): `on: headless`, parallel jobs, and steps that only one host can do.
- [Configuration](/reference/configuration/): `entry`, `apiEnv`, `strictMode`, `live` and the rest.
- [Environment variables](/reference/environment-variables/): `LYNKEUS_TOKEN`, `LYNKEUS_PORT`, `LYNKEUS_HOST`.

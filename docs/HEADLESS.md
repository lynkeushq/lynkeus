# Headless: the app in Node, no simulator

`lynkeus headless start` writes a jest test that never ends, imports your
entry, and renders it with React Native Testing Library. The agent inside the
app dials out exactly as it does on a device, so every command in
[DRIVE.md](DRIVE.md) works unchanged.

```sh
npx lynkeus headless init         # writes the entry: default mocks, your app's own entry (--auto mounts the agent too)
npx lynkeus headless doctor       # what lynkeus will mock, and which native modules still need one (--fix writes the stubs)
npx lynkeus headless start        # hosts the app and waits for a driver on 8123 (LYNKEUS_TOKEN overrides .lynkeus/token)
```

`headless start` needs a token, from `.lynkeus/token` (which `lynkeus init` makes) or
`LYNKEUS_TOKEN` in the environment: a hosted app talks to a real backend, and
without a token any local process could drive it. `LYNKEUS_PORT` moves the host
and its driver together; `LYNKEUS_HOST` says where the driver listens, for a
host that is not beside it (a container dialing out). Arguments after `--` go to jest. The entry path can
live in `lynkeus.config.json` as `entry` instead of `--entry` on every call.
`apiEnv` there names the variable the app reads its API address from. Lynkeus
detects it from the app's source; set `apiEnv` only to override that. An app
that reads no address gets none: there is no default `API_URL`.

The host's own test file lives in `.lynkeus/host/`, so it never runs in the
app's own jest. The host takes back the unit-test mocks of the app's jest
setup (the app's code runs for real), unless that setup reads
`LYNKEUS_HEADLESS`. Packages jest must transpile are detected from what the
app installs, not taken from a fixed list. React Native Testing Library 12, 13
and 14 work; `headless doctor` checks the version.

The host renders without `React.StrictMode`: production has none, and its
double renders and double-mounted effects double every request, commit and
millisecond the host measures. `"strictMode": true` in `lynkeus.config.json`
keeps it.

When the host crashes, the last thing printed is what the error usually
means and the fix. `lynkeus headless doctor --explain "<first line>"` does the
same for an error you paste.

## The entry

Your entry exports `App` and, optionally, a `navigation` adapter. It is the one
place that knows your app. An existing `qa/headless.tsx` is kept; otherwise the
entry goes next to the cases, in `<cases.dir>/headless.tsx`. `entry` in
`lynkeus.config.json` or `--entry` choose it explicitly. The generated one runs
the app's own entry (`registerRootComponent` or `AppRegistry`) and finds React
Navigation by itself. It does not check the API address: the network fence
below keeps the app off non-local hosts. The entry:

```tsx
import { installDefaultMocks } from 'lynkeus-headless/mocks';

// Only what lynkeus cannot guess: your own native modules, app-relative paths.
jest.mock('../app/native/Updater', () => ({ /* … */ }));

installDefaultMocks({
  network: 'real',                       // let the app reach your local backend
  networkHosts: ['127.0.0.1', 'localhost'],   // and nothing else (default: loopback and 10.0.2.2)
  locale: { country: 'DE', languageTag: 'de-DE', languageCode: 'de' },
});

const { default: App } = require('../app/App');
export { App };
```

`installDefaultMocks` mocks what is installed and would otherwise explode in
Node: MMKV, keychain, device-info, safe-area-context, react-native-localize,
expo-localization, async-storage, worklets, pager-view and webview. A library's own shipped jest mock or jest
setup file is used automatically. Reanimated and gesture-handler are
deliberately left alone (their jest story is a babel plugin, not
`jest.mock`); pass `overrides` if your app wants them mocked.

The biometrics, in-app-review, vision-camera, image-picker, video, fast-image
and vector-icons mocks are opt-in. Pass the ones you want:

```ts
import { installDefaultMocks, biometrics } from 'lynkeus-headless/mocks';

installDefaultMocks({ overrides: { 'react-native-biometrics': biometrics } });
```

`XMLHttpRequest`, the Expo app config and Metro's script URL are provided, so
axios, Reactotron and expo-linking work.
Options: `skip`, `overrides`, `network` (`'real'` or `'banned'`), `networkHosts`, `websocket` (`'stub'`, `'real'` or `'none'`),
`animations`, `deviceVersion`, `locale`, `initialUrl` (what `Linking.getInitialURL` answers).

The launch locale (`case run --locale`, `launch.locale`, `LYNKEUS_LOCALE`) wins
over `locale` and reaches expo-localization, react-native-localize and `Intl`'s
default locale, all derived from the tag with Intl. The launch time zone
(`--time-zone`, `LYNKEUS_TIME_ZONE`) also sets the host's `TZ`, so `Date` runs
in it; an entry's `locale.timeZone` reaches the libraries only.

`headless init` finds your App component through the app's own entry
(`--component` otherwise), takes `--api-env <NAME>` to set the variable the
app reads its API address from, and with
`--auto` also adds the `auto()` mount to `index.js`. `--force` overwrites an
existing entry.

## What you get and what you give up

- **Get**: no simulator, no build, start in ~40 s, several apps at once
  (`LYNKEUS_PORT`), a real backend if you point it at one, and the same screen
  reading and touches as on a device, layout included, computed with Yoga.
- **Give up**: anything native. Camera, biometrics, deep OS integrations are
  mocks. A WebView renders as an empty box. Native crashes are jest errors.

Long runs: every `jest.fn()` the app's mocks are made of keeps what it was
called with, for a test to read. Nothing reads it under the host, so the host
clears those records every 10 s (the mocks keep what they do); left alone they
grew some 20 MB per sign-in and screen and ran a 4 GB heap out in about 30
cases. What is left grows slowly. `lynkeus call memory` reads the heap after a
collection (no `--expose-gc`, which `NODE_OPTIONS` refuses) and answers
`heapUsedMb`, `heapTotalMb`, `heapLimitMb` (where V8 gives up, about 4096 by
default), `rssMb`, `resets`, `roots`, `listeners` and `commands`, so a runner
can compare a reading with the next case's and with the limit. `case run
--host` and `--keep-hosts` do: they start the host again past `--host-heap` percent of
`heapLimitMb` ([CASES.md](CASES.md)).

The host's real network (`network: 'real'`) hands the app a body that is not
JSON as the app's own `SyntaxError`, not Node's, so `error instanceof
SyntaxError` inside jest's sandbox holds, as on a phone.

## Controls: what the OS would hand the app

Under the host, what a device would receive from the outside world is a
command instead. These are headless-only unless noted; on a device you get
the real thing.

```sh
npx lynkeus os deeplink 'myapp://pay/abc'     # Linking listeners (react-navigation included) receive it; works on a device too
npx lynkeus os appstate background            # then `active`: what refetches or re-locks on foreground
npx lynkeus os clock --now 2027-01-01T00:00:00Z   # what Date answers (--advance <ms> moves the clock and runs the timers that fall due inside it, --reset, --settle to run what is pending without waiting for timers)
npx lynkeus os biometrics --available FaceID --next success   # the sensor and the next prompts (success, fail, cancel; --fallback)
npx lynkeus os scan 'https://pay.example/abc' --type qr       # the open camera's code scanner receives a value
npx lynkeus os gallery ./fixtures/id.jpg --name id.jpg --mime image/jpeg   # what the next image picker answers (--cancel)
```

The network is a rule table in front of `fetch`:

```sh
npx lynkeus mock 'GET /v3/accounts' --status 500 --delay 3000   # answer before the backend
npx lynkeus mock '/v3/accounts' --body '[]' --times 1           # a bare path matches any method; only once
npx lynkeus mock 'GET /v3/session' --status 401 --sticky        # survives an app reset
npx lynkeus mock --list
npx lynkeus mock --clear
```

Error states, timeouts and empty states are one line each, with no backend
fixture. A rule without `--sticky` is dropped by the app's `reset` command.
`--lost` sends the request to the backend and loses only the answer, so the
server acts and the app sees a failure. The host's network fence puts the
`x-lynkeus-mocked: 1` header on every answer a rule makes, and the agent reads
it to mark the request `mocked` in `requests` and `trace`
([PROTOCOL.md](PROTOCOL.md)).

The biometric sensor is a mock a driver sets, so a case can walk both the
success and the fallback paths:
`lynkeus os biometrics --available FaceID --next success` (or `cancel`,
`fail`).

### Native SDKs with a screen of their own

A native SDK that puts up its own screen (identity verification, a messenger) cannot run under jest. The cases
config's `nativeMocks` stands in for it: the SDK's call puts up a page whose buttons (`#native-mock-<label>`) each
resolve the call with a result, so a case presses Submit or Close as a person would. Nothing stands in by default:
the app lists its SDKs in `lynkeus.config.json`, for example

```json
{ "cases": { "nativeMocks": { "SNSMobileSDKModule.launch": { "screen": { "title": "Sumsub", "buttons": {
  "Submit": { "success": true, "status": "Pending" }, "Close": { "success": false, "status": "Incomplete" } } } } } } }
```

The stand-in answers the SDK's native module, so the SDK's JavaScript has to be the real one. An app whose jest
setup stubs the package whole for its unit tests can leave it real for a host: `lynkeus headless start` sets
`LYNKEUS_HEADLESS=1`.

```js
// jest.setup.js
if (!process.env.LYNKEUS_HEADLESS) jest.mock('@sumsub/react-native-mobilesdk-module', () => ({}));
```

If the package ships untranspiled ES modules, list it in the app's `transformIgnorePatterns` as react-native is.

### Native modules nobody provides

A native module that neither the library's own jest mock nor your entry provides is answered empty: each method
resolves `undefined`. Each run and `lynkeus headless doctor` list those modules and how to give a real answer: a
`jest.mock` in the headless entry, or `cases.nativeMocks`.

### Native values the host does not know

Under jest a native property nothing answers reads as `undefined`: `NativeModules.RNFoo.isTablet` is undefined, a
module that is not there is undefined, `TurboModuleRegistry.get` answers null and `getEnforcing` throws. On a device
the property has a value, and Lynkeus FastSim answers it with a function, which reads as true: the two hosts guess in
opposite ways, so the app can take another path than on a phone.

`installDefaultMocks` therefore wraps `NativeModules` and records each property or module the app reads that is not
there (once each; `then`, `toJSON` and the event emitter's probes are not reads). The `nativeValues` command returns
the list, and `lynkeus case run` prints it after the run with a `nativeMocks` snippet and keeps it in `run.json`.

The cases config sets the value. An entry with `value` (both platforms), `ios` or `android`, or `absent: true` (or a
list of platforms) sets a constant instead of answering a call:

```json
"nativeMocks": {
  "RNFoo.isTablet": { "value": false },
  "RNFoo.density": { "ios": 3, "android": 2.75 },
  "RNFoo.legacyFlag": { "absent": ["android"] },
  "EXDevLauncher": { "absent": true }
}
```

`lynkeus headless start` puts the constants in `LYNKEUS_NATIVE_VALUES` (JSON) and `installDefaultMocks` applies them
before the app is required, so a module-level read finds them. A `nativeMocks` `set` during a case applies them too,
but the app has already read what it read. A key with no property (`"EXDevLauncher": { "absent": true }`) declares a whole module absent: the app reads it as undefined, and the run no longer lists it among the native values the host does not know. The value to use is in the library's native code under `node_modules`.

## What headless cannot tell you

The host runs the app's JavaScript against a real backend, with the native
layer mocked. That leaves out, on purpose: the real camera and the decoder
(`lynkeus os scan` hands the open scanner a value), complex native gestures (a
swipe is driven through the gesture handler, not a finger), push delivery
(the simulator can be pushed from outside with `lynkeus os push`), what a
WebView renders (the seam is testable: what the app sends it and what it
does with the messages back), native crashes, and pixels (`lynkeus snapshot
--pixels` needs a simulator; the tree baseline works under the host). For
those, the same cases run on a simulator; only the way the host starts
differs.

An Expo Router app has no root component to export: its screens are files the
router loads. `headless init` writes an entry that renders the router over them
with `expo-router/testing-library` (`getMockContext` and `ExpoRoot`), mounts the
agent with `auto()` so it finds the router's navigation, and installs `jest-expo`.
`headless start` maps style sheets to an empty module and the `tsconfig.json`
aliases, the longest first, since jest-expo tries `@/*` before `@/assets/*`.

## Security posture

- `headless start` refuses to run without a token. The token is the
  shared secret between the hosted app and its driver, the same value the
  app reads for its `token` prop.
- With `network: 'real'`, the host refuses any host outside `networkHosts`,
  which defaults to loopback. An automated harness pointed at production is
  exactly the accident this prevents. The entry itself does not refuse a
  non-local API address; the fence does that work. Requests answered by
  `lynkeus mock` rules (`netmock`) are the exception: they are answered even
  for hosts outside `networkHosts`, since they never leave the process.

## Troubleshooting

**An env var change has no effect.** If your babel inlines environment
variables, jest's transform cache freezes the first value it saw. `headless
start` keeps one cache per value of the API variable, under
`.lynkeus/jest-cache/`; for any other inlined variable, remove that folder.

**The app never leaves the splash.** Usually a native module that Lynkeus does
not know: run `lynkeus headless doctor`, then mock it in your entry (`--fix`
writes stubs). Node resolving `localhost` to IPv6 while your backend listens
on IPv4 is the other half of that bug; use `127.0.0.1`.

**The host crashed with a jest error you do not recognize.** Paste its first
line to `lynkeus headless doctor --explain "<line>"`; it maps the usual errors
to their cause and fix.

**A screen never settles.** A ticking screen (a countdown, a spinner that
re-renders) never goes idle, and `lynkeus idle` says so with `idle: false`.
That is information, not a bug in the host.

**Two hosts fight over the port.** The driver keeps whichever host dialed in
last, so two on one port take turns; the CLI warns once with `Another app
attached on port …`. Stop the one left running, or set `LYNKEUS_PORT` on both
the host and the driver; each pair is independent.

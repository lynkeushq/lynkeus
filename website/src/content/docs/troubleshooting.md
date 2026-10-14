---
title: Troubleshooting
description: Problems by symptom — what you see, why it happens and how to fix it — for the app connection, driving, cases, the headless host and reports.
---

This page is organized by symptom. Find what you are seeing, read why it happens, and apply the fix. Exact error texts are quoted so that you can search the page for them.

Before you read further, use the two tools lynkeus has for this:

- After a failed `press`, `wait`, `type`, `swipe` or `nav`, lynkeus prints `why:` followed by what it read from the screen, the requests and the trace. Read that first.
- `lynkeus why <target>` asks the same question at any moment. `lynkeus why --route <Route>` asks it about a route you expected.

```bash
lynkeus why '#pay-button'
lynkeus why --route Checkout.Confirm
```

The [last section](#what-why-tells-you) lists every answer `why` can give.

## The app does not attach

### `No app attached on 127.0.0.1:8123 within 15000ms`

**What you see.** Any command that needs the app stops after 15 seconds with:

```text
✗ No app attached on 127.0.0.1:8123 within 15000ms. Is a dev build running with <Lynkeus>?
```

**Why.** The CLI listens, and the app dials in. The app dials `localhost:8123` on iOS and `10.0.2.2:8123` on the Android emulator, every 100 ms for the first 3 seconds and then at growing intervals up to 1.5 seconds. If nothing arrives, the agent in the app is not running, is dialing somewhere else, or is being refused.

**Fix.** Check these in order:

1. **The build is a debug build.** The agent does not run in a release build.
2. **`enabled` is true for this environment.** If you gate it, as in `enabled: __DEV__ && config.ENV !== 'prod'`, check what the expression gives in the build you are running.
3. **The token reached the app.** Look in the app's log for `lynkeus: the app passed a token and it is empty`. If the line is there, the agent is off; see [the next entry](#the-app-logs-lynkeus-the-app-passed-a-token-and-it-is-empty).
4. **The tokens match.** The token the app received when it was bundled must be the value of `LYNKEUS_TOKEN` in the terminal where you run the CLI. A mismatch looks exactly like no app at all.
5. **The app runs on a simulator or an emulator.** Physical devices are not supported: the CLI looks for a booted simulator or emulator.
6. **The ports match.** If you set `LYNKEUS_PORT` or `port` in `lynkeus.config.json`, the app's `port` option must be the same number.
7. **The app was rebuilt after you added the package.** The native module is compiled into the app.
8. **The app is running.** `--launch --app <bundleId>` relaunches it before attaching.

If the app is only slow to start, give it longer with `--attach-timeout <ms>`, or `attachTimeout` in `lynkeus.config.json`.

### The app logs `lynkeus: the app passed a token and it is empty`

**What you see.** The CLI reports that no app attached. The app's log, where its `console.warn` output goes, has this line:

```text
lynkeus: the app passed a token and it is empty, so the agent stays off. React Native gives the app no environment: add 'lynkeus-agent/babel' to the plugins in babel.config.js and start Metro with LYNKEUS_TOKEN set (after a change, with --reset-cache). In Expo, name the variable EXPO_PUBLIC_LYNKEUS_TOKEN.
```

**Why.** The entry file passes `token: process.env.LYNKEUS_TOKEN` and nothing put a value there. React Native gives the app no environment, so that expression is `undefined` inside a bundle unless something writes the value in. An app that asks for a token and does not get one keeps the agent off, rather than serve whoever connects.

**Fix.** In a React Native CLI app:

1. Add `'lynkeus-agent/babel'` to the plugins in `babel.config.js`. `npx lynkeus init` does it for you.
2. Start Metro from a shell where `LYNKEUS_TOKEN` is set to the value the CLI reads.
3. Start it once with `--reset-cache`. Metro keeps what it has transformed, so without this it goes on serving the entry file as it was when the variable was empty.

In an Expo app the plugin is not needed. Name the variable `EXPO_PUBLIC_LYNKEUS_TOKEN`, read that name in the entry file, and start the development server with it set.

The plugin writes the token into a development bundle only, never a release one.

:::note[Since 0.3.0]
Before 0.3.0 an empty token did not turn the agent off: it served any driver, with or without a token. If an app that attached before the update stopped attaching after it, this is the reason.
:::

### The app attaches in a React Native app but not in Expo

**Why.** Two things are specific to Expo:

- The agent has native code, so it does not work in Expo Go. It needs a development build: `npx expo prebuild`, then `npx expo run:ios` or `npx expo run:android`.
- Expo only inlines environment variables that start with `EXPO_PUBLIC_`. An app that reads `process.env.LYNKEUS_TOKEN` gets `undefined`, and with an empty token the agent stays off.

**Fix.** Run a development build, and read the token from `EXPO_PUBLIC_LYNKEUS_TOKEN` in the app. The CLI still reads `LYNKEUS_TOKEN`. Both must hold the same value. See [Expo](/platforms/expo/).

### `Port 8123 is already taken`

**What you see.**

```text
✗ Port 8123 is already taken: another lynkeus run is probably still driving the app there. Stop it, or use another port (LYNKEUS_PORT, --ports).
```

or, from `case run`:

```text
port 8123 is held by another lynkeus case run (pid 4242), which is probably still going: stop it, or give this run other --ports
```

**Why.** Only one driver can listen on a port. A `lynkeus session`, a `lynkeus mcp` server or another run is still holding it. Sharing a port would hand the app to whichever driver it dials next, and two runs' steps would mix.

**Fix.** Stop the other process. To run two at once on purpose, give each pair its own port: set `LYNKEUS_PORT` for the driver and for the headless host, and the `port` option of an app on a simulator.

### `No booted simulator matching "…"`

**Why.** You asked for a simulator with `--device`, `LYNKEUS_DEVICE` or `device` in `lynkeus.config.json`, and no booted simulator has that udid or a name that contains it.

**Fix.** Boot it, or correct the name.

### A warning that the app and the CLI are different versions

**What you see.**

```text
⚠️  The app runs lynkeus-agent 0.2.0, this CLI is lynkeus 0.4.0: they can misread each other without an error. Install lynkeus-agent@0.3.0 in the app and rebuild it (or run the lynkeus CLI of the agent's version).
```

**Why.** The agent in the app and the CLI are from different releases. They may still talk, and one may misread the other without any error, such as typing into nothing.

**Fix.** Install the same version of `lynkeus-agent` and `lynkeus`, and rebuild the app.

### `Lynkeus native module unavailable`

**What you see.**

```text
Lynkeus native module unavailable: debug builds only, and the app must be rebuilt after adding the package
```

**Why.** The JavaScript side of the agent is running, but the native side that synthesizes touches is not in this binary. Either the build is a release build, or the app was not rebuilt after `lynkeus-agent` was added.

**Fix.** Rebuild a debug build. On iOS, run `pod install` first. On Android the same condition reads `Lynkeus is only available in debuggable builds`.

## Driving the app

### A press does nothing

**Why.** The element is on the listing but a finger cannot act on it. Read the screen and look at its state:

```bash
lynkeus screen
```

| You see | Meaning | Fix |
|---|---|---|
| `~covered` | A touch at its center would land on something else. | Close what is over it, or press what covers it. If every control reads `~covered` on Android, see the next entry. |
| `!disabled` | The control will not answer a touch. | A form is not valid yet, or a request it depends on is still in flight. Wait for it. |
| `3 hidden: 3 behind-overlay` in the header | The element is mounted but belongs to a screen the app is not showing. | Close what is open, or target something inside it. `lynkeus screen --all` lists the hidden elements. |

`lynkeus press <target> --js` presses through the React handler instead of the OS. If that works where a normal press does not, something is over the element. It is a useful comparison, not a fix.

### On Android, every control reads `~covered`

**What you see.** In a development build on Android, `lynkeus screen` marks every control `~covered`, and a case waits out its deadline before each press.

**Why.** React Native lays an invisible debugging overlay over every development build. An older native module counted any visible view over a control as covering it, the overlay included. The current one asks React Native what a touch would stop at, so a control is covered only by something that would take the touch.

**Fix.** Update `lynkeus-agent` to 0.3.0 or newer and rebuild the app. The fix is in the native module, so a Metro reload is not enough.

### An input's value reads empty after typing

**What you see.** `lynkeus type` succeeds and the text is visible in the app, but the listing shows `value=""`, or still shows the field's `defaultValue`. An `app.see` on the field's text fails.

**Why.** An input's value is what its native field holds. An app built before `lynkeus-agent` 0.3.0 has a native module that cannot answer that question, so the agent reads React's props instead, as it used to. A field the app does not control, one with no `value` prop, has nothing in its props after typing, and one with a `defaultValue` goes on reading as that.

**Fix.** Rebuild the app after updating `lynkeus-agent`. Updating the package and reloading Metro is not enough: the native module has to be compiled in.

### On Android, a press lands above its target

**Why.** In an app that draws under the status bar, an older native module placed elements a status bar's height too high.

**Fix.** Update `lynkeus-agent` and rebuild the app. The fix is in the native module, so a Metro reload is not enough.

### `No element matches …`

**Why.** Nothing on screen answers the target. The most common causes are a `testID` that changed, a screen that has not arrived yet, and an element below the fold.

**Fix.** Run `lynkeus screen` to see what is there. Wait for the element with `lynkeus wait <target>`, or scroll to it with `lynkeus wait <target> --scroll`.

### A text target does not match

**Why.** A text target matches a control (button or input) by its exact label first, then by substring. A paragraph matches only by its exact text, so a word inside running copy is never a target. The text may also differ from what you wrote by wording, by an accent or by case.

A text that looks like something else is read as that. `12` is an index, and to `wait` and `see` a capitalized word is a route.

**Fix.** `lynkeus why 'Log in'` says whether a text close to yours is on screen. Put a text that could be mistaken in quotes of its own, inside the shell's: `lynkeus press '"12"'`. Since 0.3.0 the quotes mean "this is a text"; before, they stayed in the text and matched nothing. Prefer a `testID` for anything a test presses.

### A wait times out on a screen that is clearly there

**What you see.**

```text
✗ Timed out waiting for Settings.Main  (on Settings.Profile)
```

**Why.** One of three things:

- The route has another name. Route names come from the navigation adapter, not from your file names.
- The app has no navigation adapter. Without one there are no routes at all, only elements.
- You meant a text, and lynkeus read a route. A word that starts with a capital letter, such as `Continue`, is read as a route name by `wait` and `see`.

**Fix.** `lynkeus screen` prints the real route on its first line. If it prints no route, mount the agent with `auto()` or pass `navigation` to `<Lynkeus>`. To wait for a control, use its `testID`, or quote its text so that it cannot be a route: `lynkeus wait '"Continue"'`, or `app.wait: '"Continue"'` in a case.

### `lynkeus idle` never settles

**Why.** A screen that keeps rendering (a countdown, a ticking clock, a spinner) never goes quiet. `idle` reports that with `idle: false`. It is information about the screen, not a failure.

**Fix.** List the `testID`s of such controls under `live` in `lynkeus.config.json`. Their text then stops counting as a render on the headless host.

### No keyboard on the simulator while typing

**Why.** `type` taps the field first, so the field is focused the way a person focuses it and the system keyboard comes up. When it does not, the simulator is taking keys from the Mac's keyboard instead.

**Fix.** In the Simulator menu, turn off I/O → Keyboard → Connect Hardware Keyboard. Or run:

```bash
defaults write com.apple.iphonesimulator ConnectHardwareKeyboard -bool false
```

### Everything is slow

**Why.** There are two usual causes, and they need different fixes.

- **One process per step.** A command on its own pays for a process and a connection, about 1.5 seconds. The same step in a session costs about 50 ms.
- **The backend.** If a test waits seconds after login, the time is your backend answering, not the agent.

**Fix.** For the first, keep one connection open with `lynkeus session`, or run cases with `lynkeus case run`. For the second, `lynkeus requests` shows how long each request took.

### In an Expo app, the tabs are not listed and cannot be pressed

**Why.** The native tab bar of the newest Expo template is drawn by the system, not by React Native. The agent reads React's tree, so those tabs are not elements.

**Fix.** Move between tabs with `lynkeus nav <route>`.

### An overlay the app raises takes over the screen

**Why.** A lock screen, a "rate us" sheet, a forced-update wall. lynkeus has no idea what yours looks like, on purpose.

**Fix.** Describe it once, in the place that fits:

- In cases, add it to `cases.interruptions` in `lynkeus.config.json`. See [Interruptions](/reference/case-format/#interruptions).
- For `smoke` and `crawl`, pass `--overlay-when '#key-1' --overlay-flow flows/keypad.json`.
- By hand, compose it from commands: `lynkeus wait '#key-1'`, `lynkeus press '#key-1'`, `lynkeus wait '#key-1' --gone`.

## The map

### `No graph at … : run lynkeus map build`

**Why.** `map show`, `map paths`, `map plan` and the commands built on them read `.lynkeus/graph.json`, and it does not exist yet.

**Fix.** Run `lynkeus map build` in the app's folder.

### `map plan` has no directions

**Why.** The static graph only knows the navigations it can read from source. It knows nothing about sheets and dialogs, which exist only while the app runs.

**Fix.** Run `lynkeus crawl` from the starting screen to add observed edges, then ask again. `lynkeus map paths <Route>` shows what lynkeus currently knows about the destination.

### `map changes` reports nothing

**Why.** It compares what `lynkeus screen --record` (or `LYNKEUS_RECORD_SCREENS=1`) kept under `.lynkeus/screens/`. Without recorded screens there is nothing to compare.

**Fix.** Record screens first, then run it again after the app has changed.

## Cases

### `no cases under cases`

**Why.** `case run` without files looks in `cases.dir`, which defaults to `cases`, and found no `.md` file there.

**Fix.** `lynkeus case init` writes an example. If your cases live elsewhere, set `cases.dir`, or pass the files.

### `… is not a step`

**What you see.**

```text
app.logn is not a step: lynkeus has no command logn, and the project declares no macro for it
```

or

```text
give_points is not a step lynkeus has, and the project declares no fixtures (cases.fixtures in lynkeus.config.json)
```

**Why.** The first is an `app.` step that names neither a lynkeus command nor a macro: usually a typo, or a macro missing from `cases.macros`. The second is a fixture step in a project that has no fixtures command.

**Fix.** Correct the name, or declare the macro or the fixtures command. `lynkeus case run --dry-run` checks every step of every case without running anything.

### `<case>: no fixture <name>`

**What you see.** Nothing runs, and the output lists the missing fixtures and then `the fixtures command answers: …`.

**Why.** Before the first case, lynkeus asks your fixtures command what it answers. A case that names a fixture missing from that list is refused before anything runs, instead of failing halfway with the backend already changed.

**Fix.** Add the fixture to your server, or correct its name in the case.

### `the fixtures server cannot serve: …`

**Why.** Your fixtures command is running but said it cannot work, such as when its database is down. Every case would fail at its first fixture, so none starts.

**Fix.** Fix what the message names, then run again.

### `the fixtures command did not answer within 120000 ms` or `the fixtures command ended`

**Why.** A fixture took longer than the timeout, or the fixtures process exited. When it exited, the message ends with the last lines it wrote to stderr.

**Fix.** For a slow fixture, raise `cases.fixtures.timeoutMs`. For a process that ended, run the command from `cases.fixtures.command` by hand and read its error. Make sure it writes exactly one JSON line per line it reads.

### ``no alias 'u'`` or `{{u.user_id}} is empty`

**Why.** A reference names an alias no earlier step created, or a path the answer does not have.

**Fix.** Add `as: u` to the step that creates the thing. For an empty path, check what the fixture actually answers.

### A case reports `NOT ON THIS HOST`

**What you see.** A step is marked 🚫 with `this host has no <command>`, and the summary says `2 cannot run on this host`.

**Why.** The step needs something this host cannot do: a mocked response on a simulator or an emulator, or a command the app does not register in this build. That says nothing about the app, so the case is not failed and the run still exits with 0.

**Fix.** Nothing is broken. Run the case where the host can do it, or keep the step to that host with `on:`. See [Conditions with `on:`](/reference/case-format/#conditions-with-on).

### A case passes on retry

**What you see.** `⚠ passed on retry` next to the case.

**Why.** The case failed, ran once more, and passed. That is a flaky test, or a flaky app.

**Fix.** `lynkeus case run --once` turns the second chance off while you investigate. See [Flaky tests](/guides/flaky-tests/).

### `--screenshots and --video keep what they take in the run directory: add --out <dir>`

**Why.** `--screenshots`, `--video` and `--push` all work on a run directory.

**Fix.** Add `--out <dir>`.

### `--jobs and --host-command need a driver port per job`

**Why.** Each job drives its own host, and each host dials its own port.

**Fix.** Pass one port per job: `--jobs 2 --ports 8123,8124`.

## The headless host

### `lynkeus headless needs LYNKEUS_TOKEN in the environment`

**Why.** A hosted app talks to a real backend. Without a token, any local process could drive it, so `headless start` refuses to run.

**Fix.** Set `LYNKEUS_TOKEN` for the host and for the driver, to the same value.

### `No qa/headless.tsx in …`

**Why.** The host needs an entry file that exports your `App`.

**Fix.** `lynkeus headless init` writes one. If yours lives elsewhere, pass `--entry` or set `entry` in `lynkeus.config.json`.

### The app never leaves the splash screen

**Why.** Usually one of two things:

- A native module that lynkeus does not mock.
- Node resolving `localhost` to IPv6 while your backend listens on IPv4 only.

**Fix.** Run `lynkeus headless doctor` to list the native modules that still need a mock, and mock them in your entry (`--fix` writes stubs). Use `127.0.0.1` instead of `localhost` in the API address.

### The host crashed with a jest error

**What you see.** A long jest stack, and at its end a block that starts with `lynkeus: what this looks like`.

**Why and fix.** lynkeus recognizes the usual errors and prints the cause and the fix. For an error you have from elsewhere, paste its first line:

```bash
lynkeus headless doctor --explain "ReferenceError: structuredClone is not defined"
```

The errors it recognizes:

| The error contains | Cause | Fix |
|---|---|---|
| `TurboModuleRegistry.getEnforcing(...): 'X' could not be found` | The native module `X` does not exist under jest. | Mock the package that owns it in the headless entry with `jest.mock`. `lynkeus headless doctor` lists where it is referenced. |
| `"X" was not found in the UIManager` | The native view `X` has no jest counterpart. | Mock the library that renders it with a plain `View`. |
| `Cannot find module 'X' from 'Y'` | `Y` imports `X`, which jest cannot resolve. | If `X` is a path alias, add it to jest's `moduleNameMapper`. If it is an optional native package, mock it in the entry. |
| `lynkeus headless only drives a local backend; API_URL is "…"` | The API variable does not point at a local backend. | Export it as `http://127.0.0.1:<port>/` before `headless start`. If the app inlines the environment at build time, clear jest's transform cache too. |
| `X.y is not a function` | Usually a mock that does not implement a method the app calls. | Extend the mock for `X` with `y`. The defaults can be overridden per key with `installDefaultMocks({ overrides })`. |
| `Cannot read properties of undefined (reading 'x')` | Something the app expected to exist is undefined. | Look one frame up the stack for the module: a mock that returns `{}` instead of the shape the app reads, or a store that was not initialized because a service failed earlier. |
| `Jest did not exit one second after the test run has completed` | The host finished but something kept the event loop alive. | Harmless for a host that is meant to stay up. Otherwise, look for an open socket or timer from a mock. |
| `ECONNREFUSED <ip>:<port>` | Nothing is listening there. | Start the backend, or the lynkeus driver if this is the agent's connection, and check the port the entry dials. |
| `Unexpected token 'export'`, `Cannot use import statement` or `Test environment jest-environment-… cannot be found` | jest is not transforming a dependency that ships ES modules. | Add the package to the allow-list in `transformIgnorePatterns` in the app's jest configuration, the same way `react-native` is listed. `lynkeus-agent` and `lynkeus-headless` need `lynkeus-[^/]+` there. |
| `ReferenceError: X is not defined` | `X` is a global the runtime does not provide under jest. | Define it in the entry before requiring the app (`globalThis.X = …`), or mock the module that expects it. |

### `the host did not come up within 180 s`

**Why.** `case run --host` starts the headless host and waits for it. The host did not get as far as waiting for a driver. The message ends with the host's last lines.

**Fix.** Run `lynkeus headless start` on its own and read what it prints.

### An environment variable change has no effect

**Why.** If your babel configuration inlines environment variables, jest's transform cache keeps the first value it saw.

**Fix.** Remove the cache directory your jest configuration points at, then start the host again.

### The screen goes empty and has no route

**Why.** A component threw while rendering and took the tree with it, or the host broke a render loop: a component whose effect and store feed each other. `lynkeus why` names which, and for a crash it prints the error.

**Fix.** Fix the component. To continue meanwhile, reset the app with `lynkeus call reset`.

### The host's memory grows over a long run

**Why.** Node's heap grows by a few dozen megabytes per full app reset.

**Fix.** A runner that drives hundreds of tests should restart the host when `lynkeus call memory` reports too much. `case run --host-command` starts a fresh host for every case.

### Requests are refused by the host

**Why.** With `network: 'real'`, the headless host only lets the app reach the hosts in `networkHosts`, which defaults to loopback. Anything else is refused at once. This is what keeps an automated test from reaching production by accident.

**Fix.** If the screen needs that host, add it to `networkHosts` in your entry, or answer the request with `lynkeus mock`.

## Reports

### `set LYNKEUS_REPORTS_URL and LYNKEUS_REPORTS_KEY`

**Why.** `case run --push` and the `lynkeus report` commands need the address of the report service and your organization's API key.

**Fix.** Export both. `case run --push` checks for them before it runs anything, so a missing key does not surface only after every case has run.

### `not kept on this plan: …`

**Why.** The run was uploaded, but some files were left out: the Free plan does not keep films.

**Fix.** Nothing failed. The report has frames and no film. `lynkeus report plan` shows what your plan keeps.

### `the report was not uploaded: …`

**Why.** The run finished, but the upload failed. The cases still ran, and the exit code reflects the cases, not the upload.

**Fix.** The run directory is intact. Upload it again with `lynkeus report push <dir>`.

## What `why` tells you

`lynkeus why` reads the screen, the last requests and the trace, and reports every rule that matches. Each line starts with one of these.

| It says | Meaning | What to do |
|---|---|---|
| `the screen is empty and has no route` | A component threw while rendering and took the tree with it. When the host recorded the error, it is printed. | Reset the app and fix the render error. |
| `every request answered 401` | The session is gone: a logout, a reset, or a key revoked elsewhere. | Log in again. |
| `the backend refuses … with 403` | An account state or a permission, not the screen. | Check what the test expects of this user. |
| `the backend answered 5xx on …` | A server error, not the app. | Reproduce it with `curl` before touching the test. |
| `a request answered 429` | The backend is rate limiting this client. | Space the runs out, or raise the limit locally. |
| `the host broke a render loop` | A component whose effect and store feed each other. The screen is dead until a reset. | Fix the loop. |
| `… is in the tree but not presented` | The target belongs to a screen the app is not showing. | Close what is open, or target something inside it. |
| `… is on the screen but covered` | A sheet or an overlay is over it. | Close it, or press what covers it. |
| `… is on the screen but disabled` | A form is not valid yet, or a request it depends on is in flight. | Wait for what it depends on. |
| `the text is not there, but "…" is` | A wording, accent or case difference. | Correct the text, or use a `testID`. |
| `the list shows N near matches and yours is not among them` | The data has accumulated look-alikes and the list is capped. | Search by something unique, or reset the data. |
| `the app was on X and moved to Y` | Something navigated after the step: a redirect, a gate, a modal. | Read the order in `lynkeus trace`. |
| `N request(s) still in flight when the command gave up` | The screen had not finished loading. | Use a longer timeout, or wait for the request it needs. |
| `no request left the app while this ran` | Nothing was fetched. | Check that the user is logged in and that the app talks to the backend it should. |
| `N request(s) were refused by the host` | The headless host blocked hosts outside `networkHosts`. | Allow the host, or mock it. |
| `the last command that failed was …` | Nothing else explains it; this is the last error the app recorded. | Start from that error. |
| `nothing in the evidence explains it` | The screen, requests and trace look ordinary. | Read `lynkeus screen` and `lynkeus trace --last 20` yourself. |

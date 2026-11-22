# Beyond React Native

Goal: testing an app built with Expo Exact, Flutter, native iOS (SwiftUI, UIKit) or native Android (Compose, Views) is
as easy as testing a React Native app is today: the same readable cases, the same CLI and MCP tools (`screen`, `press`,
`type`, `wait`, `case run`), the same reports.

## What is already runtime-agnostic

The [protocol](PROTOCOL.md) never names React. The driver (CLI, MCP server, case runner) talks to *an app* over a
WebSocket the app opens: a handshake that proves the project token, then requests (`screen`, `find`, `press`, `type`,
`swipe`, `waitFor`, `idle`, `back`, `batch`, `requests`, `trace`, app commands such as `clock`). What it needs from an app:

- `screen`: elements with a kind, a frame in points, an enabled flag, a test id, a text or label, a value for inputs.
- `press` and `type` on a target (`{testId}`, `{text}`, `{i}`, `{x, y}`), `waitFor` and `idle`.
- Optional: a route (`navigation`), requests and trace, and commands (`clock`, `reset`).

So a new runtime is **one adapter that speaks this protocol**. Nothing in the CLI, the cases or the MCP changes. Three
places the adapter can live:

| | A. In-app agent | B. Driver adapter | C. FastSim-style host |
|---|---|---|---|
| What it is | A library inside the app, dialing the driver (lynkeus-agent does this for React Native) | A process beside the app that translates the protocol onto the runtime's own driver (WebDriver-like, JSON lines, a test framework) | A process that runs the app's code without a device (jest in Node for headless; FastSim runs the Hermes bundle against a native-looking host) |
| Reads the screen from | The runtime's live tree: views, semantics, accessibility | The runtime driver's tree query | The host's own layout |
| Press and type | Calls into the runtime (activate an accessibility element, insert text) or synthesizes touches | The driver's tap and type | The host's input path |
| Needs a change in the app | Yes: one line to start the agent, a token | No, or a debug flag | No (the host is the device) |
| Where it works | Simulator, emulator, a phone, a debug build | Wherever the driver does | Anywhere without a simulator: CI, a laptop, a server |
| Cost | A library per runtime | One process per driver | A host per runtime: months |

The rule of thumb used here: **A where the app can carry a small library (native iOS and Android, Flutter), B where the
runtime already ships a driver with the right hooks (Exact), C only when speed or no-device runs matter enough to be worth
a host per runtime** (React Native has it as FastSim; nothing else needs it yet).

## The four targets

### Expo Exact (step 1, done against a stand-in: PR #146)

Exact's native hosts speak JSON lines on stdio (`tree`, `layout`, `tap`, `type`, `clock`, `state`) and own a clock that
moves only when the driver moves it. `lynkeus-exact` is a **B** adapter: it starts the host binary, dials the driver and
maps requests (`waitFor` and `idle` spend the app's own time in 100 ms steps; `os clock --advance` is `clock {to}`).
Verified against a stand-in only: a real Exact host needs Bun, Swift 6.4 and Xcode 27.1, or a Rust Linux build. Exact's
web host drives a browser over CDP, so the same adapter would need a second transport.

### Native iOS (step 2, spike in this PR)

An **A** agent in Swift (`native/ios/LynkeusAgent`): a SwiftPM library the app starts with its token. It dials the driver
(URLSession's WebSocket), proves the token with CryptoKit's HMAC, reads the key window's view hierarchy and the
accessibility elements its views vend, and answers `screen`, `find`, `press`, `type`, `waitFor`, `idle` and `batch`.
A press activates the accessibility element (`accessibilityActivate`, or `sendActions(.touchUpInside)` for a UIControl),
typing goes into the UITextField SwiftUI puts behind a TextField (`insertText`). It needs no change to the SwiftUI code
beyond the start call and `.accessibilityIdentifier(...)` where a test id is wanted: the same wish as `testID` in React
Native. See "Spike results" below for what was measured.

### Spike results

Run on the iOS 26 Simulator (iPhone 17), the sample app in `native/ios/Sample`, built with `swiftc` alone:
`lynkeus case run cases/resend-code.md` passes 8 of 8 steps in 9.6 s: `see`, two `press`es, `type` into a SwiftUI TextField,
a `press`, a `see` and a `wait` that lasts through a three second countdown. `lynkeus screen`, `press "Add one"` as separate
CLI invocations work too. What it showed:

- SwiftUI vends its accessibility tree to the hosting view without VoiceOver or an Accessibility Inspector running, so an
  in-process agent can read it (labels, traits, identifiers, frames). `accessibilityIdentifier` arrives as the test id.
- A press by `accessibilityActivate()` runs a SwiftUI Button's action; no touch is synthesized, so `mode` is `js`.
- A TextField is a UITextField underneath; `insertText` reaches SwiftUI's binding. SwiftUI also vends a plain element
  for the same field, which the agent drops.
- Reading is on the main actor and costs a few milliseconds; the app's own timers and animations run in real time (no
  `clock` command), so `wait` and `idle` poll.
- A bug the first run found: `as? UIAccessibilityIdentification` on SwiftUI's elements aborts the process; the property
  is read by name instead.
- The elements come in two passes (accessibility elements, then UIKit views), so a field is listed after the buttons even
  when it is drawn above them. Order is only a tiebreak in targets; sorting by frame would fix it.

What it does not do yet: scrolling and swipes (needs touch synthesis or `UIScrollView.setContentOffset`), the
`within` scope of a target, routes (a SwiftUI app has no navigation object to read; `NavigationStack` paths would need an
opt-in), requests and trace (an `URLProtocol` can record them), a clock (a simulator has no `clock` command either), and
`native: true` presses (a real touch through the hit-test path, for gestures and what an accessibility activation skips).

### Flutter (next)

An **A** agent in Dart (a `lynkeus_agent` package): the semantics tree (`SemanticsOwner`, with semantics enabled) gives
the elements, frames and labels; `performAction(SemanticsAction.tap)` is the press; `testTextInput` or the focused
`EditableText`'s controller is the typing; `WidgetsBinding.instance.addPostFrameCallback` and `pumpEventQueue` are idle.
It dials the driver through `dart:io`'s WebSocket. The alternative is **B** over the Flutter driver (`flutter_driver`,
`integration_test`), which already speaks a VM-service protocol but needs the app built with the driver extension and a
Dart-side adapter for every call; the in-app agent is closer to lynkeus-agent and is the plan. A **C** host (a Flutter
engine host in FastSim, Impeller or Skia) is the long way and waits for a reason.

### Native Android (next)

An **A** agent in Kotlin: a library the app starts in `Application.onCreate`. For Views, walk the root view's hierarchy and
`AccessibilityNodeInfo`; for Compose, the semantics tree through `SemanticsOwner` (`SemanticsNodeInteraction` internals) or
an `AccessibilityNodeProvider`. `performClick`/`performAction` is the press, `InputConnection.commitText` is typing, and the
test id is the `testTag` (Compose) or the view's id name. Dial `10.0.2.2:8123` from an emulator, as lynkeus-agent does. A **B**
route through UiAutomator or Espresso needs an instrumentation APK beside the app and is slower per call.

## What FastSim would need for a native runtime

Nothing for the agents above: they run on the Simulator or emulator, which FastSim does not replace. FastSim only comes
into play when a team wants **no device** (CI, a laptop without a Simulator, a server):

- **Exact**: the Linux host is already headless and fast; FastSim has nothing to add except the clock and launch-fact
  conventions it shares (epoch, seed, settle, held requests, #55). Run the Exact host and `lynkeus-exact` there.
- **Flutter**: a Flutter engine host with a software rasterizer (Skia's CPU backend), the embedder API for input and
  semantics, and a Dart AOT or kernel build of the app: a host the size of FastSim's iOS one.
- **Native iOS or Android**: no. The code runs against the platform's frameworks, which only exist on the platform (the
  Simulator is the host). Robolectric-style and Paparazzi-style Android hosts exist but are not the app.

So the order is: agents (A) for native and Flutter first, because they work on today's Simulators and emulators and give
cases and reports at once; FastSim-style hosts (C) only where the runtime makes a device-free run cheap (Exact today).

## Keeping the protocol free of one runtime's words

Where the spike met a React word, it was in the protocol's documentation, not its shape: `commit` is "React commits since
the agent started" (an agent reports a count of screen changes), `tag` is "React native tag" (optional), `lynkeus-agent`
and `qa.register` name the React Native agent and its command registry (a native agent registers commands too, by whatever
means its language has). None of them needs a protocol change.

# Protocol

Version 1. JSON messages over a WebSocket. The **app** is the client: in
development it dials the **driver** (`ws://localhost:8123` on iOS, `ws://10.0.2.2:8123`
on the Android emulator). While nothing answers it dials again every 100 ms
for the first 3 s after the app starts or a link drops, then waits twice as
long each time, up to 1.5 s (`reconnectMs`).
The driver is any process that can hold a socket: a Node test runner, a CLI,
an MCP server, an LLM harness.

## Handshake

Driver → app, always the first message on a new socket:

```json
{ "event": "auth", "session": "b7e1…", "token": "…" }
```

- `session`: random per driver process. A driver that reconnects resends the
  requests it had in flight; the app answers one it already ran from the
  reply it kept (the last 64), so a press is not done twice. A new `session`
  means a new driver whose request ids start over, and the kept replies are
  dropped.
- `token`: present when the driver has one. An app configured with a `token`
  answers every request with `{"error": {"code": "unauthenticated"}}` until an
  `auth` carrying the same value arrives.

App → driver, in answer to an `auth` it accepts:

```json
{ "event": "hello", "protocolVersion": 1, "agentVersion": "0.6.0", "platform": "ios", "native": true,
  "commands": ["busy", "reset"], "route": "Settings.Main", "app": { "name": "example" } }
```

- `agentVersion`: the `lynkeus-agent` release in the app; agents older than
  the field do not send it.

- `native`: whether touch synthesis is compiled in (debug builds only).
- `commands`: the names the app registered with `qa.register`. The driver
  may call them like any method.

App → driver, whenever the focused route may have changed:

```json
{ "event": "navigation", "route": "Auth.Login" }
```

## Requests

```json
{ "id": 7, "method": "press", "params": { "testId": "next-button" } }
{ "id": 7, "result": { "x": 201, "y": 812, "mode": "native", "element": { … } } }
{ "id": 8, "error": { "message": "No element matches {\"testId\":\"nope\"}" } }
```

`id` is chosen by the driver and echoed back. Requests may be in flight
concurrently; the app answers each when its work is done.

## Targets

```ts
type Scope = { testId: string } | { text: string }
type Target =
  | { testId: string; nth?: number; within?: Scope }
  | { text: string; nth?: number; within?: Scope }
  | { i: number }
  | { x: number; y: number }
```

`within` narrows a target to a scope: the element the scope names, then each
listed container up from it, nearest first; among the matches in the first
container that has any, the one closest to the scope in tree order wins. It is
how a feed of five rows with the same `like` button says which one. `nth`
counts the matches (in the scope, when there is one) from 0.

`text` matches a control (button or input) by exact label first, then by
substring; a paragraph matches only by exact text — a substring inside
running copy is never a target, because tapping its centre lands on
whatever link or word sits there. Covered elements are never matched.
Ties go to the later element: it draws on top.

## Methods

| Method | Params | Result |
|---|---|---|
| `ping` | — | `{ pong, native, commands }` |
| `screen` | — | `Screen` (below) |
| `find` | `Target` | `Element \| null` |
| `press` | `Target & { holdMs?, mode?: 'native' \| 'js' }` | `{ x, y, element?, mode }` |
| `type` | `{ text, target?, clear?, paste?, submit? }` | `{ typed, element? }` |
| `swipe` | `{ direction?, target?, distance? } \| { from, to }`, `durationMs?` | `{ from, to }` |
| `navigate` | `{ name, params? }` | `{ route }` |
| `back` | — | `{ route? }` |
| `waitFor` | `{ route?, target?, anyOf?, gone?, scroll?, since?, timeoutMs? }` | `{ route?, matched?, waitedMs, passed? }` |
| `idle` | `{ quietMs?, timeoutMs?, after? }` | `{ commit, idle }` |
| `deepLink` | `{ url }` | `{ opened }` |
| `requests` | `{ since? }` | `{ inFlight, requests: RequestRecord[] }` |
| `trace` | `{ since? }` | `{ last, events: TraceEvent[] }` — what the app did, in order: `route`, `request`, `store`, `event`, `command`, `stall`, `touch` and `crash` events |
| `dismissKeyboard` | — | `true` |
| `batch` | `{ calls: [{ method, params? }] }` | `{ results }` — in order, stops at the first error |
| `debug` | — | what the tree walker can see |
| *app command* | anything | anything — whatever `qa.register` returned |

A request a `netmock` rule answered (or whose answer it lost) instead of the server has `mocked: true`, in `requests`
and in its `trace` event. Who marks it: the agent marks what its own rules answer (on a simulator or an emulator); a
layer below the app (the headless host's network fence, a host's own netmock) answers with the `x-lynkeus-mocked`
header, and the agent, which sees every response, reads the header and sets `mocked`. `lynkeus requests` and `lynkeus
trace` print `(mocked)`, a failed case's evidence says it, and the backend diagnoses (5xx, 401, 403, 429) read only what
the server answered. A rule's `lost` loses the answer after the request was sent.

### Commands a host registers

A host registers commands beside the app's, called like any method (`lynkeus call <name>`). Two matter to a run:

- `memory` (headless): the heap after a collection: `{ heapUsedMb, heapTotalMb, heapLimitMb, rssMb, resets, roots,
  listeners, commands }`. `heapLimitMb` is where V8 stops; `case run --host` starts the host again past `--host-heap`
  percent of it.
- `record` (a host that films, named in `hello`): `{ path, fps, scale? }` starts a film at `path`; `{ stop: true }` ends the film and answers `{ bytes }`, how big it is.
  When the host is on another machine its path is not this machine's, so `{ read: offset }` hands the film over a piece
  at a time, `{ data, done }` with `data` base64, until `bytes` have arrived; `case run --video` reassembles it.

### `Screen`

```ts
{
  route?: string            // focused route name, when a navigation adapter is configured
  params?: unknown
  path: string[]            // root navigator down to the focused screen
  elements: Element[]       // tree order; later draws on top
  commit: number            // React commits since the agent started
  busy: boolean             // requests in flight, or the app's `busy` command said so
  window: { w, h }          // points
  presenting?: { i, modal, testId? }   // the layer on top, when the app presents one
  costMs: number            // time spent building the snapshot
}
```

### `Element`

```ts
{
  i: number                 // index in tree order
  kind: 'button' | 'input' | 'text' | 'scroll' | 'switch' | 'image' | 'view'
  frame: { x, y, w, h }     // window points, transforms included
  enabled: boolean
  depth: number             // nesting among listed elements
  testId?: string
  text?: string             // rendered text, or a control's label
  accessibilityLabel?: string
  value?: string            // inputs; masked with • when secureTextEntry
  placeholder?: string
  font?: { size, bold? }    // points; what makes text "large" for contrast
  focused?: boolean
  parent?: number           // index of the nearest listed ancestor
  tag?: number              // React native tag
  covered?: boolean         // a touch at its centre would not reach it
  hidden?: HiddenReason     // not presented at all, and why
  offscreen?: boolean       // its rect is outside the window: on screen only after scrolling
}
```

`covered` comes from a native hit test at the element's centre (UIKit
`hitTest:` / Android view tree) when the native module is available.

`hidden` is the structural answer, and it is the stronger one: the element is
mounted but the app is not presenting it. The reasons are `a11y` (hidden from
assistive technology), `inert` (`pointerEvents: 'none'` on it or an ancestor),
`behind-modal` and `behind-overlay` (outside the layer on top). They are read
from the tree — `display: 'none'`, `aria-hidden`,
`accessibilityViewIsModal`, an absolute full-window view mounted at the root —
so a host with no layout answers the same as a device. Full-window is read two
ways, because apps write it two ways: four insets at or below zero, or both
extents at `'100%'` with no inset pushing the view off its corner (an inset a
style leaves out is where the view was going to sit anyway). A lock screen is
usually the second kind. A screen that is
presenting a layer says which one in `presenting`.

Both flags are reported and they mean different things: `covered` is "a finger
would land on something else", `hidden` is "this is not on screen". `press`
refuses a hidden element; `find` and `waitFor` still match an `inert` one,
because a label inside a pressable is readable even though no touch reaches
it.

### Semantics worth knowing

- `press` (native) waits until the element stops moving (two identical
  measurements 40 ms apart, up to 600 ms), closes the keyboard first if a tap
  outside the focused field would only dismiss it, measures again, then puts a
  finger down for `holdMs` (50 by default; ~600 is a long press). Consecutive
  taps let the run loop turn between them.
- `press` with `mode: 'js'` calls the element's `onPress` directly. It needs a
  `testId`, refuses disabled or covered controls, and skips gestures and
  animations entirely. Use it when you want the outcome, not the gesture.
- `type` goes through the platform's key input, so formatters and `onChange`
  behave as with a keyboard; keys are paced 25 ms apart unless `paste`.
- `waitFor` (`since`: a trace mark, so a route reached after it counts even if the app has already left it, and `passed` says so; `scroll` swipes the nearest scroller towards the target) polls inside the app every 40 ms and returns the moment the
  condition holds; `idle` resolves after `quietMs` without commits or
  requests, or reports `idle: false` at `timeoutMs` (a ticking screen never
  settles, and that is information).
- `requests` includes headers and bodies only after `networkBodies` turns them
  on (a case run that keeps evidence does), with secrets replaced; query values under keys such
  as `token`, `key`, `secret`, `code`, `otp`, `password`, `pin`, `session`, `auth` are redacted.

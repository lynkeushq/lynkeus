---
title: Protocol
description: The wire protocol between the app and its driver — handshake, requests, targets, every method and the data types — for people writing their own driver.
---

The agent inside the app and the driver outside it talk over a small JSON protocol. The `lynkeus` CLI is one driver; this page is for people who want to write another: a test runner in a language other than JavaScript, a custom harness, a bridge to another tool.

If you work in Node, you do not need this page to get started: the `lynkeus-client` package implements the driver's side, and `lynkeus-protocol` exports every type below. Read on when you need to know exactly what goes over the wire.

## The shape of the connection

The protocol is version 1. Messages are JSON, one per WebSocket message.

The roles are the reverse of what you might expect. The **driver** is the WebSocket server, and the **app** is the client: the app dials out, and nothing listens inside the app. The driver is therefore the stable side. Start it once, and every launch of the app attaches again.

| | |
|---|---|
| Where the app dials | `ws://localhost:8123` on iOS, `ws://10.0.2.2:8123` on the Android emulator. The app can be given another host and port. |
| When nobody answers | The app retries quietly: every 100 ms for the first 3 seconds after it starts or loses a connection, then with a wait that doubles each time, up to 1.5 seconds. |
| When the app does not dial at all | An app that was given a `token` option whose value is empty keeps its agent off and logs why. It never opens a socket, so a driver sees the same thing as with no app running. |
| When the app connects again | A relaunched app reconnects before its old socket notices it is gone. `lynkeus-client` therefore keeps the newest connection and closes the older one; a driver of your own should do the same. |

There are three kinds of message:

- **Events** have an `event` field. The driver sends `auth`; the app sends `hello` and `navigation`.
- **Requests** go from the driver to the app and have an `id` and a `method`.
- **Responses** go from the app to the driver and carry the same `id`.

## Handshake

### 1. The driver sends `auth`

The driver's first message on every new connection is always `auth`, and it always carries a `session`. Send it even when no token is configured: the app says nothing until it has received it, and `hello` is its answer.

```json
{ "event": "auth", "session": "k3j9x0q1mfz8", "token": "…" }
```

| Field | Type | Meaning |
|---|---|---|
| `session` | string | A value that is random per driver process and the same on every connection that process accepts. The app uses it to tell a reconnect from a new driver. |
| `token` | string | The shared secret. Omit it when the app was mounted without a token. |

If the app has a token and the driver's does not match, the app does not answer `auth`, and it answers every request with:

```json
{ "id": 1, "error": { "message": "Not authenticated", "code": "unauthenticated" } }
```

### 2. The app answers `hello`

```json
{
  "event": "hello",
  "protocolVersion": 1,
  "agentVersion": "0.2.1",
  "platform": "ios",
  "native": true,
  "commands": ["busy", "events", "profile", "reset", "stores", "traceContext"],
  "route": "Settings.Main",
  "app": { "name": "example" }
}
```

| Field | Type | Meaning |
|---|---|---|
| `protocolVersion` | number | The protocol version the agent speaks. |
| `agentVersion` | string | The release of `lynkeus-agent` in the app. Absent from older agents. |
| `platform` | string | `ios`, `android`, or whatever the host reports. |
| `native` | boolean | Whether touch synthesis is compiled in, so that presses are real touches. Debug builds only. |
| `commands` | string[] | The commands the app answers beyond the core methods: the ones it registered with `qa.register`, and the built-in ones. The driver calls them like any method. |
| `route` | string | The focused route, when a navigation adapter is configured. |
| `app` | object | Whatever the app passed as its `app` option. |

The app is attached once `hello` has arrived. Do not send requests before it.

### 3. The app sends `navigation` as it moves

Whenever the focused route may have changed, the app sends:

```json
{ "event": "navigation", "route": "Auth.Login" }
```

## Requests and responses

```json
{ "id": 7, "method": "press", "params": { "testId": "next-button" } }
```

```json
{ "id": 7, "result": { "x": 201, "y": 812, "mode": "native", "element": { "i": 4, "kind": "button" } } }
```

```json
{ "id": 8, "error": { "message": "No element matches {\"testId\":\"nope\"}" } }
```

- `id` is a number the driver chooses. The app echoes it back.
- Requests can be in flight at the same time. The app answers each one when its work is done, so answers can arrive out of order.
- A method with nothing to return answers `"result": null`.
- An error has a `message` and sometimes a `code`.
- A method the app does not have answers the error `Unknown method <name>`.

### Reconnects

A development build reconnects often: on a reload, on a relaunch. A driver that wants to survive that should do what `lynkeus-client` does:

1. Keep requests that were in flight when the connection dropped.
2. When the app connects again, send `auth` with the **same** `session`.
3. After the new `hello`, send those requests again, unchanged, with their original `id`.

The app remembers its last 64 answers per session. A resent request it had already run is answered from that memory instead of being run again, which matters because a press is not something to repeat. A new `session` clears that memory, so a new driver can number its requests from 1.

## Targets

A **target** names one element. Methods that touch or look for an element take one.

```ts
type Scope = { testId: string } | { text: string };

type Target =
  | { testId: string; nth?: number; within?: Scope }
  | { text: string; nth?: number; within?: Scope }
  | { i: number }
  | { x: number; y: number };
```

| Form | Matches |
|---|---|
| `{ testId }` | The element with that `testID`. |
| `{ text }` | A control (button or input) by exact label first, then by substring. A paragraph matches only by its exact text. Matching ignores case and surrounding spaces, and looks at both the text and the accessibility label. |
| `{ i }` | The element at that index in the last `screen`. |
| `{ x, y }` | A point, in window points. |

A substring inside running copy is never a target, because tapping the center of a paragraph lands on whatever link or word sits there.

On the wire a target is always one of these objects. The spellings the CLI accepts (`#next-button`, `12`, a text in quotes of its own) are the CLI's way of writing them: it sends `'"12"'` as `{ "text": "12" }` and `12` as `{ "i": 12 }`. A driver of your own has no such ambiguity to resolve.

When several elements match:

- An element a touch can reach wins over a covered one. A covered element is returned only when nothing reachable matches.
- Ties go to the later element in the tree, because it draws on top.
- `nth` picks among the matches, counted from 0.
- `within` narrows the search to a scope: the element the scope names, then each container up from it, nearest first. Among the matches in the first container that has any, the one closest to the scope in tree order wins. This is how a feed of five rows with the same `like` button says which one.

Elements that are hidden are never matched, with one exception: an `inert` element still matches, because a label inside a pressable is readable even though no touch reaches it.

## Methods

| Method | Params | Result |
|---|---|---|
| [`ping`](#ping) | none | `{ pong, native, commands }` |
| [`screen`](#screen) | none | `Screen` |
| [`find`](#find) | `Target` | `Element` or `null` |
| [`press`](#press) | `Target` plus `{ holdMs?, mode? }` | `{ x, y, element?, mode }` |
| [`type`](#type) | `{ text, target?, clear?, paste?, submit? }` | `{ typed, element? }` |
| [`swipe`](#swipe) | `{ direction?, target?, distance?, from?, to?, durationMs? }` | `{ from, to }` |
| [`navigate`](#navigate-and-back) | `{ name, params? }` | `{ route }` |
| [`back`](#navigate-and-back) | none | `{ route? }` |
| [`waitFor`](#waitfor) | `{ route?, target?, anyOf?, gone?, scroll?, timeoutMs? }` | `{ route?, matched?, waitedMs }` |
| [`idle`](#idle) | `{ quietMs?, timeoutMs?, after? }` | `{ commit, idle }` |
| [`deepLink`](#deeplink) | `{ url }` | `{ opened }` |
| [`requests`](#requests) | `{ since? }` | `{ inFlight, requests }` |
| [`trace`](#trace) | `{ since? }` | `{ last, events }` |
| [`dismissKeyboard`](#dismisskeyboard) | none | `true` |
| [`batch`](#batch) | `{ calls }` | `{ results }` |
| [`debug`](#debug) | any | what the tree walker can see |
| [An app command](#app-commands) | anything | anything |

### `ping`

Answers `{ "pong": true, "native": boolean, "commands": string[] }`. `commands` is current, so use `ping` to see commands the app registered after `hello`.

### `screen`

Answers a [`Screen`](#screen-1): the route, every element, and whether the app is busy. The whole snapshot is taken in one JavaScript tick.

### `find`

Takes a target and answers the best matching [`Element`](#element), or `null`. It also answers elements that are `covered` or `inert`, so check those fields before acting on the answer.

### `press`

Takes a target, plus:

| Param | Type | Default | Meaning |
|---|---|---|---|
| `holdMs` | number | `50` | How long the finger stays down. About 600 is a long press. |
| `mode` | `"native"` or `"js"` | `"native"` | How to press. |

It answers the point pressed, the element when the target named one, and the mode used.

In `native` mode the app:

1. Scrolls the element into the window first, if it is known but outside it (only where touches are real).
2. Waits until the element stops moving: two identical measurements 40 ms apart, for up to 600 ms.
3. Closes the keyboard first if the target is not an input and an input has focus, since a tap outside the field would only dismiss the keyboard. Then it measures again.
4. Puts a finger down for `holdMs`.

In `js` mode the app calls the element's `onPress` directly. There is no touch, no gesture and no wait for animations. It refuses a control that is disabled or covered, so the app's own gates still mean something. Use it when you want the outcome, not the gesture.

`press` refuses a hidden element with `<target> is not presented (<reason>)`, and a target that matches nothing with `No element matches <target>`.

### `type`

| Param | Type | Default | Meaning |
|---|---|---|---|
| `text` | string | required | What to type. |
| `target` | `Target` | | A field to tap first. Without it, the text goes to the focused input. |
| `clear` | boolean | `false` | Delete the field's current value first. |
| `paste` | boolean | `false` | Insert the whole text at once. |
| `submit` | boolean | `false` | Press the return key afterwards. |

Typing goes through the platform's key input, so formatters and `onChange` behave as with a keyboard. Keys are sent 25 ms apart unless `paste` is set, because a controlled input formats on every change and keys sent faster than a render race the formatter.

### `swipe`

| Param | Type | Default | Meaning |
|---|---|---|---|
| `direction` | `"up"`, `"down"`, `"left"`, `"right"` | `"up"` with a target | Which way the finger moves. |
| `target` | `Target` | | Swipe on this element, from its center, instead of across the window. |
| `distance` | number (points) | 60% of the window that way | With a target: how far to move. |
| `from`, `to` | `{ x, y }` | | Both ends of the drag, instead of a direction. |
| `durationMs` | number | `250` | How long the drag takes. |

Give a direction, a target, or both `from` and `to`. Otherwise the method fails with `swipe needs a direction, a target, or from/to points`.

Without a target, a direction swipes across the middle of the window: from 70% to 30% of its height for `up`, from 80% to 20% of its width for `left`, and the reverse for `down` and `right`.

With a target, a drag that would leave the window is moved back inside it rather than cut short, because a touch that leaves the window is canceled.

It answers the two points actually used.

### `navigate` and `back`

`navigate` takes `{ name, params? }` and goes straight to that route through the navigation adapter. It answers `{ route }`.

`back` pops the current route and answers the route it landed on. With nothing to go back to, it fails with `Nothing to go back to`.

Both fail with `No navigation adapter configured` when the app was mounted without one.

### `waitFor`

Waits until every condition given holds.

| Param | Type | Default | Meaning |
|---|---|---|---|
| `route` | string | | The focused route must be this one. |
| `target` | `Target` | | An element must match. |
| `anyOf` | `Target[]` | | At least one of these must match. The answer says which in `matched`. |
| `gone` | boolean | `false` | Turn `target` around: wait until nothing matches it. |
| `scroll` | boolean | `false` | Swipe the nearest scrolling container toward the target until it is in the window. |
| `timeoutMs` | number | `5000` | Give up after this long. |

The app checks every 40 ms, inside the app, and answers the moment the conditions hold with `{ route, matched, waitedMs }`. On timeout it fails with `Timed out waiting for …`, naming the route the app was on.

With `scroll`, a target that is not mounted yet gives no direction, so the app scrolls down until the list stops moving, then back up, and gives up when that stops moving too. It swipes at most 30 times.

### `idle`

Waits until the app is quiet: no React commit and no request in flight.

| Param | Type | Default | Meaning |
|---|---|---|---|
| `quietMs` | number | `150` | No commit and no request for this long counts as settled. |
| `timeoutMs` | number | `3000` | Stop waiting after this long. |
| `after` | number | | A commit count from before the change you are waiting for. Quiet only counts once the app has committed past it. |

It answers `{ commit, idle }`. On timeout it does not fail: it answers `idle: false`. A screen with a ticking clock never settles, and that is information, not an error.

A screen that has not started looks exactly like one that has finished. Read `commit` from `screen` before the action, then pass it as `after`.

### `deepLink`

Takes `{ url }` and opens it in the app as the OS would hand it over. It answers `{ opened: url }`.

### `requests`

Answers `{ inFlight, requests }`: how many HTTP requests are in flight, and the recent ones as [`RequestRecord`](#requestrecord)s. With `since`, only requests whose `id` is greater.

The app keeps the last 200 requests. It never records headers or bodies. In the URL, the values of query parameters whose name ends with `token`, `key`, `secret`, `code`, `otp`, `password`, `pin`, `session` or `auth` are replaced with `…`.

### `trace`

Answers `{ last, events }`: the sequence number of the newest entry, and the recent entries as [`TraceEvent`](#traceevent)s. With `since`, only entries whose `seq` is greater. The app keeps the last 500.

Pass the `last` you got as the next `since` to read only what is new.

### `dismissKeyboard`

Closes the keyboard and answers `true`.

### `batch`

Takes `{ calls: [{ method, params? }] }` and runs the calls in order, in one round trip. It answers `{ results }`, one per call. It stops at the first error, and the whole request then answers that error.

```json
{ "id": 12, "method": "batch", "params": { "calls": [
  { "method": "press", "params": { "testId": "next-button" } },
  { "method": "waitFor", "params": { "route": "Settings.Main" } },
  { "method": "screen" }
] } }
```

### `debug`

Answers what the agent's tree walker can see. It is for diagnosing the agent itself, and its shape is not part of the contract.

### App commands

Any method name that is not a core method is looked up among the app's commands: the ones it registered with `qa.register`, and four built-in ones (`events`, `stores`, `profile`, `traceContext`). See the [Agent API](/reference/agent-api/#qa).

`reset` is special. The app runs its own `reset` command if it registered one, and then the agent returns the navigation to its initial route. `reset` therefore never answers `Unknown method`.

## Data types

### `Screen`

```ts
type Screen = {
  route?: string;
  params?: unknown;
  path: string[];
  elements: Element[];
  commit: number;
  busy: boolean;
  window: { w: number; h: number };
  presenting?: { i: number; modal: boolean; testId?: string };
  costMs: number;
};
```

| Field | Meaning |
|---|---|
| `route`, `params` | The focused route and its params, when a navigation adapter is configured. |
| `path` | Route names from the root navigator down to the focused screen. |
| `elements` | Every element, in tree order. A later element draws on top of an earlier one. |
| `commit` | React commits since the agent started. A change means the UI rendered again. |
| `busy` | True while requests are in flight, or while the app's `busy` command says so. |
| `window` | The window's size, in points. |
| `presenting` | The layer on top, when the app is presenting one over its screen: a sheet, a dialog. |
| `costMs` | Milliseconds the app spent building this snapshot. |

### `Element`

```ts
type Element = {
  i: number;
  kind: 'button' | 'input' | 'text' | 'scroll' | 'switch' | 'image' | 'view';
  frame: { x: number; y: number; w: number; h: number };
  enabled: boolean;
  depth: number;
  testId?: string;
  text?: string;
  accessibilityLabel?: string;
  value?: string;
  placeholder?: string;
  focused?: boolean;
  parent?: number;
  tag?: number;
  covered?: boolean;
  hidden?: 'a11y' | 'inert' | 'behind-modal' | 'behind-overlay';
  offscreen?: boolean;
};
```

| Field | Meaning |
|---|---|
| `i` | The element's index in tree order. |
| `kind` | What it is. |
| `frame` | Where it is, in window points, transforms included. |
| `enabled` | False for a disabled control. |
| `depth` | Its nesting among the listed elements. |
| `text` | The rendered text of a `text` element, or the label of a button or input. |
| `value` | An input's value: what its native field holds. Masked with `•` when the field is a secure entry. |
| `parent` | The index of the nearest listed ancestor. |
| `tag` | The React native tag of the host view. |
| `covered` | A touch at its center would not reach it: something is on top. |
| `hidden` | It is mounted but the app is not presenting it, and why. |
| `offscreen` | Its frame lies outside the window: it is on screen only after scrolling. |

`covered` and `hidden` mean different things, and both are reported.

`covered` answers "would a finger land on something else?". It comes from a native hit test at the element's center, when the native module is available. On Android the test asks React Native what a touch at that point would stop at, so a view that is drawn over the control but takes no touches, such as the invisible debugging overlay of a development build, does not cover it.

:::note[Since 0.3.0]
Two reads moved to the native module in 0.3.0, and both need the app rebuilt after `lynkeus-agent` is updated. `value` was read from React's props, so a field with no `value` prop read as empty after typing and one with a `defaultValue` kept reading as that; an app that has not been rebuilt still answers that way. On Android, `covered` was true for any visible view over the point, which in a development build was every control.
:::

`hidden` answers "is this on screen at all?", and it is the stronger of the two. It is read from the structure of the tree, so a host with no layout answers the same as a device.

| `hidden` | Meaning |
|---|---|
| `a11y` | Hidden from assistive technology, so presented to no one. |
| `inert` | `pointerEvents: 'none'` on it or on an ancestor: no touch can reach it. |
| `behind-modal` | Outside the subtree that declared itself modal. |
| `behind-overlay` | Outside the last full-window layer the app mounted at its root. |

A view counts as full-window in either of two ways, because apps write it both ways: four insets at or below zero, or both extents at `'100%'` with no inset pushing the view off its corner.

### `RequestRecord`

```ts
type RequestRecord = {
  id: number;
  method: string;
  url: string;
  status?: number;
  startedAt: number;
  ms?: number;
  error?: string;
};
```

`id` counts up from 1 as requests start, and starts again at 1 when the app restarts. `status` and `ms` are absent while the request is in flight. A request that failed before it got an answer has `status: 0` and an `error`.

### `TraceEvent`

Every entry has `seq` (a sequence number) and `t` (a timestamp in milliseconds), plus the fields of its `kind`.

| `kind` | Fields | Recorded when |
|---|---|---|
| `route` | `route?`, `path` | The focused route changed. |
| `request` | `method`, `url`, `status?`, `ms?`, `error?` | A request finished. |
| `store` | `store`, `changed` | A store observed with `qa.observe` changed. `changed` maps each top-level key that changed to `{ from, to }`. The two values are kept short: an object as its number of keys (`{3}`), an array as its length (`[12]`), a string over 80 characters cut, and the value of a key named like a secret (`token`, `password`, `session`, …) as `…`. The `stores` command returns the state in full. |
| `event` | `name`, `props?`, `route?` | The app reported an analytics event through `qa.event`. |
| `command` | `method`, `ms`, `error?` | The driver ran a method that acts. Reads such as `screen`, `find` and `waitFor` are left out, unless they fail. |
| `touch` | `x`, `y`, `testId?`, `text?`, `route?` | A person touched the screen, on a device build mounted with `auto()`. |
| `stall` | `renders`, `windowMs`, `component?` | The headless host broke a runaway render loop. |
| `crash` | `message`, `stack?`, `route?` | Something threw where nothing caught it, and the screen may be gone. |

## The run directory

The protocol package also defines what `lynkeus case run --out <dir>` writes, so that a report, a dashboard or a script can read a run without knowing how it was made.

| File | Content |
|---|---|
| `run.json` | A `RunManifest`: when the run started and ended, what the app ran on, the git branch and commit, the totals. |
| `cases.jsonl` | One `RunCase` per line, one line per attempt, in the order they ran. |
| `<case id>/…` | What a case's steps point at: frames and a film. |

The types are `RunManifest`, `RunCase`, `RunStep`, `RunEvent` and `RunBackendSpan`, exported by `lynkeus-protocol` together with `RUN_SCHEMA`, which is `1` and is written to `run.json` as `schema`.

Two rules protect readers:

- A field is only ever added. Anything that would change the meaning of an existing field raises `RUN_SCHEMA`. A reader should refuse a schema it does not know.
- `run.json` is written when the run starts and again when it ends. A run that was cut short has no `finishedAt` and no `totals`.

See [Reports](/guides/reports/) for what each file is used for.

## A driver in Node

`lynkeus-client` is the driver the CLI is built on.

```ts
import { AgentServer } from 'lynkeus-client';

const server = new AgentServer({ port: 8123, token: process.env.LYNKEUS_TOKEN });
await server.listen();
await server.waitForApp();
await server.call('press', { testId: 'get-started-button' });
const screen = await server.call('screen');
await server.close();
```

| Option | Default | Meaning |
|---|---|---|
| `port` | `8123` | The port to listen on. |
| `host` | `127.0.0.1` | The address to listen on. |
| `token` | none | Must match the app's token. |
| `reconnectGraceMs` | `2500` | How long requests in flight wait for the app to reconnect before they fail. |

| Member | Meaning |
|---|---|
| `listen()` | Starts listening. Fails with code `port-in-use` when the port is taken. |
| `waitForApp(timeoutMs = 15000)` | Resolves with the app's `hello`. |
| `call(method, params?, timeoutMs = 20000)` | Sends a request and resolves with its result. Rejects with an `AgentError`, whose `code` is `timeout`, `disconnected`, or the code the app sent. |
| `connected`, `hello` | Whether an app is attached, and what it said. |
| `close()` | Stops listening and fails the requests in flight. |
| Events | `hello`, `navigation` and `disconnected`. |

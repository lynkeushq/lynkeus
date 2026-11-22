# lynkeus-exact

A Lynkeus host for apps built with [Expo Exact](https://github.com/expo/exact). The cases, the CLI and the MCP tools
stay the same: this package is the process that answers them from Exact's agent driver instead of from a React Native
app.

```
lynkeus (CLI, MCP, case run)  ──ws, protocol v2──▶  lynkeus-exact-host  ──JSON lines on stdio──▶  Exact host (linux, macos, ios)
```

`lynkeus-exact-host <port>` is what `lynkeus case run --host-command "lynkeus-exact-host {port}"` starts for each case.
It starts an Exact host binary (`EXACT_HOST_COMMAND`, or `EXACT_LINUX_BIN` / `EXACT_MAC_BIN`; `EXACT_HOST_ARGS` for its
arguments), dials the driver on `<port>` like an app does, proves the project token (`LYNKEUS_TOKEN`) and serves the
requests. `LYNKEUS_EPOCH` and `LYNKEUS_SEED` are the launch facts: the epoch is what `Date` starts at, the seed goes to
Exact as `EXACT_AGENT_SEED`.

The protocol has no React in it, and neither does this package: an element is a kind, a frame, a test id and a text, and
"commit" is a counter of how many times the screen changed.

## What each request becomes

| Lynkeus | Exact driver |
|---|---|
| `screen`, `find` | `tree` and `layout`: nodes become elements (a control's texts are its label; plain wrappers are left out), `commit` counts changes of the tree |
| `press` | `tap {id}` (a hold is `tap` down, `clock` forward, `tap` up), then `clock settle` |
| `type` | `tap {id}` on the target, then `type {id, text}`; `clear`, `submit` (`key: Enter`) |
| `waitFor`, `idle` | `clock settle`, then the app's own clock forward 100 ms at a time: nothing sleeps, a three second countdown costs milliseconds |
| `back` | `tap {back: true}` |
| `clock` (`lynkeus os clock`) | `clock {to}` for `--advance`, `clock {settle}` for `--settle`; `now` and `reset` are refused: Exact's date is a launch fact |
| `requests` | `inFlight` and `held` from the last `clock settle` |
| `batch`, `ping`, `trace` | answered here; `trace` is empty |

Not mapped yet: `swipe`, `navigate`, `deepLink`, `dismissKeyboard` (answers true), `requests` records, `trace` events.

## Try it without Exact

`example/fake-exact.mjs` stands in for an Exact host (a counter, a field, a resend countdown on the app's own clock) so
the adapter can be tested and shown without building Exact:

```sh
cd packages/exact/example
EXACT_HOST_COMMAND=node EXACT_HOST_ARGS=./fake-exact.mjs LYNKEUS_TOKEN=any-token \
  lynkeus case run --ports 8464 --host-command "node ../lib/bin.js {port}"
```

## What is verified, and what is not

Verified: the adapter, the handshake and the CLI (a case, and one `lynkeus` process per command) against the stand-in.
Not verified: a real Exact host. The shapes of `tree`, `layout`, `tap`, `type` and `clock` replies are read from Exact's
`scripts/agent*.mjs` and Rust tests (commit `28f071ca`), not captured from a running host, and Exact's macOS and iOS hosts
need Swift 6.4 and Xcode 27.1. The first thing to do with a real host is compare its `tree` reply with `elements.ts`.

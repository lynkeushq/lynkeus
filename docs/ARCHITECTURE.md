# Architecture

How Lynkeus is put together, the contracts between its parts, and where a new piece goes. Read it before adding a
command, a package or a service feature. [CONCEPTS.md](CONCEPTS.md) defines the words; this page says how they fit.

## The rule

Lynkeus knows React Native, the screen, cases, runs and git. It knows nothing about any product: no screens, no
users, no backend. Everything product-specific lives with the product and reaches Lynkeus through a contract.
A piece that would only work for one app does not belong in this repository.

## Layers

```
 ┌──────────────────────────── the product's repositories ────────────────────────────┐
 │  app repo: cases, flows, lynkeus.config.json, its CI workflow                       │
 │  backend side: a fixtures server (creates and reads state in a local backend),      │
 │                and how to bring that backend up                                     │
 └──────────────▲───────────────────────────────▲─────────────────────────────────────┘
                │ case format, config           │ fixtures protocol (JSON lines)
 ┌──────────────┴───────────────────────────────┴─────────────────────────────────────┐
 │  Lynkeus CLI / MCP: drive, cases, runs, knowledge (routes, graph), CI orchestration │
 └──────▲────────────────────────────▲──────────────────────────────▲─────────────────┘
        │ agent protocol (WebSocket) │ host protocol (same wire)    │ reports API (HTTPS)
 ┌──────┴──────────┐   ┌─────────────┴─────────────┐   ┌────────────┴─────────────────┐
 │ lynkeus-agent   │   │ hosts: simulator/emulator, │   │ lynkeus cloud: reports,      │
 │ inside the app  │   │ FastSim, headless          │   │ history, search, team, forge │
 └─────────────────┘   └────────────────────────────┘   └──────────────────────────────┘
```

| Layer | Knows | Lives in |
|---|---|---|
| Agent | The running React Native app: its tree, touches, keys, requests, SDK calls, console | `packages/agent` |
| Hosts | How to run the app: a simulator, an emulator or an Android phone on USB, Lynkeus FastSim (native drawing without a simulator), headless (Node, no drawing) | the OS tools, the fastsim repository, `packages/headless` |
| CLI and MCP | Driving, cases, runs, routes and paths, coverage, CI orchestration | `packages/cli` |
| Cloud | Runs over time, reports, people, the forge (GitHub) | lynkeus-cloud |
| Product | Its cases and flows, what its screens mean, its backend's state | the product's repositories |

## Contracts

Every arrow above is a contract with a spec, types and a version. A change that breaks one raises its version; a
reader refuses a version it does not know.

| Contract | Between | Spec | Types |
|---|---|---|---|
| Agent protocol | driver ↔ agent or host | [PROTOCOL.md](PROTOCOL.md) | `lynkeus-protocol` |
| Case format and config | product ↔ CLI | [CASES.md](CASES.md), [CONCEPTS.md](CONCEPTS.md) | the CLI's `CasesConfig` |
| Fixtures protocol | CLI ↔ the product's backend side | [FIXTURES.md](FIXTURES.md) | `FIXTURES_PROTOCOL` and the command types in `lynkeus-protocol` |
| Run format | CLI → anything that reads a run | [CASES.md](CASES.md), "What a run leaves" | `RunManifest`, `RunCase`, `RunStep`, `RunEvent` |
| Progress events | a running `case run` → `case status`, the live line, MCP | [CASES.md](CASES.md), "Following a long run" | the CLI's `ProgressEvent`; `progress.ndjson` |
| Reports API | CLI → cloud | the service's `/v1` routes | the CLI's `pushRun` |
| MCP | an LLM ↔ the CLI | the server's instructions and tool schemas | generated from the commands |

## Runtimes

Lynkeus drives React Native apps today and is built to drive apps of other runtimes. Adding one must not change or
slow what exists, nor make every change re-test every runtime.

**The rule.** The core never asks which runtime a folder is. Each runtime lives in its own directory and implements
one adapter; the core calls the adapter.

| Path | What it is |
|---|---|
| `packages/cli/src/runtimes/api.ts` | The adapter a runtime implements and the only core module a runtime imports |
| `packages/cli/src/runtimes/index.ts` | `loadRuntime(id)`, the one place that loads a runtime, lazily |
| `packages/cli/src/runtimes/detect.ts` | Which runtime a folder is, from its files, with no runtime code loaded |
| `packages/cli/src/runtimes/<id>/` | One runtime's CLI side (`react-native`) |
| `packages/agent`, `packages/headless`, `example/` | React Native's agent, headless host and example app |

**The shared core** is everything a runtime runs through: `packages/cli/**` outside `src/runtimes/<id>/`,
`packages/protocol`, `packages/client`, the root `package.json` and lockfile, `.github/actions` and `hack/ci`. A
change there can affect every runtime.

**The gate.** On every pull request:

- `packages/cli/scripts/check-runtime-boundary.mjs` (lint job): the core imports from `runtimes/` only `index`,
  `detect` and `api`; only `index.ts` imports a runtime's directory, with a lazy `import()`; a runtime imports only
  its own files and `../api.js`; and the core holds no runtime check by name (`=== '<id>'`, `is<Runtime>(...)`) for
  any id `detect.ts` lists, apart from the exceptions the script lists, which can only shrink.
- `packages/cli/src/__tests__/rnInvariance.test.ts` (test job): React Native as on main, from goldens made by running
  main's CLI. Case parsing and step resolution; the protocol messages and report of scripted runs against a fake app
  on a virtual clock; every command's help, the MCP instructions and tool schemas, failure exit codes and texts; what
  `status`, `init`, `headless start` and `map build` do in each kind of folder; which simulator, emulator or phone a
  run picks and the `xcrun` and `adb` commands it sends; the run folder a scripted `case run --out` writes for a
  report; how `lynkeus.config.json` resolves; and the runner's cost per step, at most twice main's. Every probe runs
  on a fresh machine (empty home, no Lynkeus or CI variables, UTC, no network), so the goldens hold on any machine.
- `src/cases/__tests__/rnWire.test.ts`: what a case run sends a React Native app over a real socket, with frames
  and without. `runtimeBoundary.test.ts`: `lynkeus --help` loads no runtime and a project loads only its own.
- `packages/headless/src/__tests__/host.golden.test.tsx`: the real headless host driven through a scripted sequence,
  every answer of the agent's handlers in a snapshot. `packages/protocol/src/__tests__/api.test.ts`: every
  declaration the protocol package exports, compared with `api.golden.d.ts.txt`.
- `hack/ci/changed-areas.mjs` decides the heavy suites: React Native's native builds run when the agent, the
  protocol, the example app, the root manifest or lockfile, or the workflow change, and on every push to main.

A pull request that touches only one runtime's paths cannot change another runtime: no shared file changed, and
nothing outside that runtime's directory imports it except the loader, which loads it only for a folder detected as
that runtime. The gate is advisory until main's branch protection requires the `lint` and `test` checks.

**Regenerating the goldens.** `pnpm --filter lynkeus goldens:rn` checks out `origin/main` (or `-- --ref <ref>`) in a
temporary worktree and runs the probes there; nobody edits a golden by hand. A difference from main fails until
`goldens/rn/allowed.json` names its key, says why React Native should now behave that way, and pins its hash; the
failure prints the entry to add. Add one only for a deliberate React Native change whose diff a reviewer has read,
and once that change is on main, regenerate and drop its entries (the test says which entry is no longer needed). `UPDATE_RN_WIRE=1`, `UPDATE_PROTOCOL_API=1` and `jest -u` in
`packages/headless` record the other three, under the same rule.

**Adding a runtime.** Add its id to `RUNTIMES` in `detect.ts` with how its folder is recognized (a folder that is
also a React Native app stays React Native); implement the adapter in `runtimes/<id>/index.ts` and add it to
`loadRuntime`; give its sample app a suite and a workflow of its own; add its paths to `hack/ci/changed-areas.mjs`.
Nothing in the React Native goldens changes; a key that does is a React Native change and goes through
`allowed.json`.

**Still on the core's side.** React Native's own code predates the directories: `init`'s agent mount and setup
checks (`commands/init.ts`), the TypeScript route reader (`knowledge/extract.ts`, a public export), the params
reader (`knowledge/route-params.ts`, a public export) and the jest headless host (`commands/headless.ts`) live in the
core and reach the React Native adapter through `runtimes/api.ts`. `fastsimVariant` still checks the platform itself
as well as the adapter. The adapter's `hostCommandEnv` and `runner` answers are not asked yet: React Native is the
runtime the core's defaults were written for. `devBuild` and `bundler` are the project's own commands that `setup`
runs (a development build installed and opened on a device, and Metro); a runtime without them gets `init` and the
device from `setup`, and builds the app itself.

## Where a new piece goes

Ask, in order:

1. Does it need to know a product's screens, users or backend? It goes to the product (its cases, its config, its
   fixtures server), and Lynkeus offers the contract it plugs into.
2. Does it run inside the app? The agent.
3. Does it make the app run somewhere new? A host.
4. Does it read or change one run, a case, the routes, or a working copy? The CLI, with an MCP tool if a model
   should call it.
5. Does it need runs over time, people, permissions or the forge? The cloud.

Examples from the work so far:

| Piece | Goes to | Why |
|---|---|---|
| "Which cases does this diff touch" | CLI (`case impact`) | Cases, routes and git; any app |
| "What do the cases cover" | CLI (`case coverage`), shown by the cloud | Same |
| A draft case for a route | CLI (`case new`), using `fixtures describe` for the setup | The path is Lynkeus's; the setup is the product's, read through the contract |
| Running the suite over N hosts, only affected cases | CLI (`ci`) | Orchestration of hosts and cases |
| Bringing a product's backend, its database and Redis up | the product's backend side | Only that backend knows how |
| Screens changed on a pull request, with approval | cloud, through a GitHub App | Needs a baseline over time and the forge |
| Turning Mixpanel on in one app's dev bundle | That app's docs | A fact about one app |

## Getting a backend into a case

A case prepares state through fixtures. A team picks the cheapest way that reaches the states it needs:

| Way | What the team writes | Reaches |
|---|---|---|
| Through the UI | macros of real screens (sign up, enter the code) | whatever a person can do, slowly |
| App commands | `qa.register` in the app (reset, log in through a dev link) | client-side state |
| Record and replay | nothing: one recorded run against the real backend | anything the backend answered once, offline and exact; edited answers reach rare states |
| HTTP fixtures | a map from fixture to a request on the backend's own API | what that API can create |
| SQL fixtures | a local database URL and statements | anything in the database, guarded to local only |
| A fixtures server | a server speaking the fixtures protocol (qa-tools is one, for Rails) | everything, by name, with `describe` for authors and models |

`lynkeus case init` writes a small fixtures server to start from, and `lynkeus fixtures check` tells whether a server
keeps the protocol. `lynkeus fixtures init` (planned) would write the skeleton for the backend's stack (the JSON-lines
loop, `describe`, and a guard that refuses any database that is not local), and the MCP would tell a model how to fill
it from the backend's models.

## Reaching a loopback backend from another device

A simulator, an emulator and the headless host reach a backend on the developer's machine directly. An app that runs
elsewhere (a cloud device, a runner on another network) does not. `lynkeus relay` (`packages/cli/src/commands/relay.ts`,
client in `packages/client/src/relay.ts`) covers that: the CLI opens one outbound WSS connection to the report service
and forwards the app's `/api/mobile/` requests to the loopback backend, with a per-run token in the app's URL and a
separate socket secret that only the CLI holds. Nothing listens inbound. Service side: `docs/RELAY.md` in lynkeus-cloud;
user side: the website guide `guides/backend-relay`.

## Plan

Done: the fixtures protocol as a contract (its own page, types in `lynkeus-protocol`, a version, `describe`, and
`fixtures check`); `case impact` and `case coverage`; `case new <route>`; `ci`.

Next, in order:

1. `fixtures init` and its MCP tool; HTTP and SQL fixtures built in.
2. Cloud: a GitHub App, screens changed on a pull request with approval, coverage over time.

Later, when a team needs it: record and replay, an optional mode for running a case with no backend. A recording
holds what the app received (each step's responses and the fixtures' answers), never what it produced, and is kept
next to its case. Running against the real backend stays the default.

Alongside, as before: pixel parity on FastSim (Android first, then iOS on Linux) and the headless cases that still
fail.

## Open questions

- Whether `ci` is a CLI command, a GitHub Action, or both.
- How the cloud stores the screens baseline per branch, and who may approve a change.

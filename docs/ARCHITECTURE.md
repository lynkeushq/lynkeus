# Architecture

How lynkeus is put together, the contracts between its parts, and where a new piece goes. Read it before adding a
command, a package or a service feature. [CONCEPTS.md](CONCEPTS.md) defines the words; this page says how they fit.

## The rule

lynkeus knows React Native, the screen, cases, runs and git. It knows nothing about any product: no screens, no
users, no backend. Everything product-specific lives with the product and reaches lynkeus through a contract.
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
 │  lynkeus CLI / MCP: drive, cases, runs, knowledge (routes, graph), CI orchestration │
 └──────▲────────────────────────────▲──────────────────────────────▲─────────────────┘
        │ agent protocol (WebSocket) │ host protocol (same wire)    │ reports API (HTTPS)
 ┌──────┴──────────┐   ┌─────────────┴─────────────┐   ┌────────────┴─────────────────┐
 │ lynkeus-agent   │   │ hosts: simulator/emulator, │   │ lynkeus cloud: reports,      │
 │ inside the app  │   │ fastsim, headless          │   │ history, search, team, forge │
 └─────────────────┘   └────────────────────────────┘   └──────────────────────────────┘
```

| Layer | Knows | Lives in |
|---|---|---|
| Agent | The running React Native app: its tree, touches, keys, requests, SDK calls, console | `packages/agent` |
| Hosts | How to run the app: a simulator or emulator, fastsim (native drawing without a simulator), headless (Node, no drawing) | the OS tools, the fastsim repository, `packages/headless` |
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
| Fixtures protocol | CLI ↔ the product's backend side | [CASES.md](CASES.md) (to move into its own page) | to add to `lynkeus-protocol` |
| Run format | CLI → anything that reads a run | [CASES.md](CASES.md), "What a run leaves" | `RunManifest`, `RunCase`, `RunStep` |
| Reports API | CLI → cloud | the service's `/v1` routes | the CLI's `pushRun` |
| MCP | an LLM ↔ the CLI | the server's instructions and tool schemas | generated from the commands |

## Where a new piece goes

Ask, in order:

1. Does it need to know a product's screens, users or backend? It goes to the product (its cases, its config, its
   fixtures server), and lynkeus offers the contract it plugs into.
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
| A draft case for a route | CLI (`case new`), using `fixtures describe` for the setup | The path is lynkeus's; the setup is the product's, read through the contract |
| Running the suite over N hosts, only affected cases | CLI (`ci`) | Orchestration of hosts and cases |
| Bringing Olympus, its database and Redis up | the product's backend side | Only that backend knows how |
| Screens changed on a pull request, with approval | cloud, through a GitHub App | Needs a baseline over time and the forge |
| Turning Mixpanel on in Hermes's dev bundle | Hermes's docs | A fact about one app |

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

`lynkeus fixtures init` (planned) writes the server's skeleton for the backend's stack (the JSON-lines loop,
`describe`, and a guard that refuses any database that is not local) and the MCP tells a model how to fill it from
the backend's models. `lynkeus fixtures check` (planned) tells whether any server keeps the protocol.

## Plan

In order, each step leaning on the ones before:

0. The fixtures protocol as a contract: its own page, types in `lynkeus-protocol`, a version, `describe` with a
   summary, parameters and an example per command (older servers that answer names only still work), and
   `fixtures check`.
1. `case impact` and `case coverage` in the CLI.
2. `case new <route>`: the path from the route map, the setup offered from `fixtures describe`.
3. Record and replay: a run that records keeps each case's answers as its mocks; a case can then run with no backend.
4. `fixtures init` and its MCP tool; HTTP and SQL fixtures built in.
5. `ci`: run a suite over N hosts and only the cases a diff touches, with the product's command to bring its backend
   up.
6. Cloud: a GitHub App, screens changed on a pull request with approval, coverage over time.

Alongside, as before: pixel parity on fastsim (Android first, then iOS on Linux) and the headless cases that still
fail.

## Open questions

- Where a recorded case keeps its answers: next to the case (reviewable in a pull request) or in `.lynkeus/`.
- Whether `ci` is a CLI command, a GitHub Action, or both.
- How the cloud stores the screens baseline per branch, and who may approve a change.

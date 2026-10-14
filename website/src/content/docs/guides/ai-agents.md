---
title: AI agents
description: Let an AI agent drive your app through lynkeus mcp, and tell it how to read a screen, move around and diagnose a failure.
---

An AI agent that tests an app from screenshots pays twice: each picture costs many tokens, and the answer it extracts is a guess. Through lynkeus the agent reads the screen as structured text (routes, testIDs, labels, states) and acts on facts.

`lynkeus mcp` serves the lynkeus commands as tools over MCP, the Model Context Protocol that Claude, Cursor and other AI clients use to call tools. The agent can set lynkeus up in your app, drive it, write cases and run them. This guide shows how to connect it, which tools it serves, and what to put in the agent's instructions.

## Before you start

- A React Native app, bare or Expo, that you can build and open in a simulator or emulator.
- An AI client that supports MCP servers over stdio.

:::note[Since 0.4.0]
The server sets the app up itself (`init`, `status`) and runs cases (`case_run`). With an earlier version, install the agent as [Installation](/getting-started/installation-react-native/) explains, set `LYNKEUS_TOKEN` in the environment the client starts the server in, and run cases from a terminal.
:::

## Step 1: Connect the server

`lynkeus mcp` is a stdio server: the AI client starts it as a child process and talks to it over standard input and output. In Claude Code, from the app's folder:

```bash
claude mcp add lynkeus -- npx -y lynkeus mcp
```

In Cursor, in `.cursor/mcp.json`:

```json
{ "mcpServers": { "lynkeus": { "command": "npx", "args": ["-y", "lynkeus", "mcp"] } } }
```

The server works in the folder the client starts it in, or the one `--root <dir>` names. To let the agent push runs to lynkeus.io, add `LYNKEUS_REPORTS_KEY` with an API key of your organization to the server's environment (`-e LYNKEUS_REPORTS_KEY=lk_…` in Claude Code); the API keys page there shows the line with the key in it.

You should see the client list the lynkeus tools.

## Step 2: Let the agent set lynkeus up

Ask the agent, in plain words:

```text
Set lynkeus up in this app.
```

The server tells the model the order to follow when it connects. The agent calls `status`, which lists what the project has and what each missing piece needs, then `init`, which installs `lynkeus-agent`, mounts it from the app's entry and makes the project's token in `.lynkeus/token` (kept out of git). Nobody sets a variable: the app's bundle, the CLI and the server all read that file.

The agent has native code, so the app is built again (`npx react-native run-ios`, or `npx expo run:ios` for Expo) and Metro restarted with `--reset-cache`. An agent with a shell does that itself; otherwise it asks you to. Then `status` shows the app attached, and the agent can read the screen.

To run without a simulator, ask it to set the app up headless: `headless_init` installs jest, Testing Library and `lynkeus-headless` and writes the entry, `headless_doctor` names any native module still to mock, and cases then run in Node with `case_run` and `host`. The app's backend must be local; `apiUrl` in `lynkeus.config.json` gives it to the host.

## Step 3: Ask for a test

```text
Write a test for the sign-in screen, run it and push the run.
```

The agent calls `case_init` the first time, which writes an example case and the format beside it, drives the app to the screen with `press`, `type` and `wait`, writes the case as a markdown file and runs it with `case_run`. A case that fails comes back with the screen it failed on and the reason, so the agent fixes the case or reports the app's bug. With `push`, the run goes to lynkeus.io and the agent prints its address.

## Step 4: Choose the tool set

The server comes in two sizes. The size matters because tool definitions are sent to the model on every turn.

| Command | Tools | Cost per turn |
|---|---|---|
| `npx lynkeus mcp` | The 15 core tools | About 1,750 tokens |
| `npx lynkeus mcp --full` | All 48 commands | About 5,400 tokens |

Start with the core. Add `--full` for an agent whose job is crawling, recording or snapshots.

### The core tools

| Tool | What it does |
|---|---|
| `status` | What the project has of lynkeus and what is missing, each with its fix, and whether an app is attached. |
| `init` | Installs the agent, mounts it from the app's entry, makes the project's token. |
| `headless_init` | Prepares the app to run in Node with no simulator. An Expo Router app works too. |
| `headless_doctor` | Lists the native modules the app uses that nothing mocks yet, and can write stubs for them. |
| `case_init` | Writes an example case and the reference of the format. |
| `case_run` | Runs cases; a failure comes back with its screen and reason. |
| `screen` | The route, the navigator path and every element on screen. |
| `press` | A finger on an element. |
| `type` | Types into the focused input, or taps a target first. |
| `wait` | Waits until a route or element appears, or leaves. |
| `why` | Says why the last step failed. |
| `call` | Runs a command the app registered with `qa.register`. |
| `os_deeplink` | Opens a URL in the app, as the operating system would hand it over. |
| `map_show` | The testIDs and navigations a screen is likely to have, read from source. |
| `map_plan` | Directions from one route to another: which buttons to press, screen by screen. |

A tool takes its command's arguments and most of its flags. A few that a model rarely needs, such as `--nth` and `--hold` on `press`, are left out of the core tools to keep their definitions small. Tool names are the command names with spaces replaced by underscores.

When `lynkeus.config.json` sets `language` or `locale`, the server adds one more tool, `app_locale`, which tells the model the language and region the app is built for.

## Step 5: Build the map

`map_show` and `map_plan` answer from a map of the app that lynkeus builds by reading the source. Build it once, and again when navigation changes:

```bash
npx lynkeus map build
```

You should see `.lynkeus/graph.json` written. The map lists every route, the testIDs each screen is likely to have, and the navigations it can perform.

The static map only knows the navigations it can read from source. If `map_plan` has no directions, run `npx lynkeus crawl` from the starting screen: it presses the controls it finds and records where each one actually leads.

## Step 6: Give the agent its instructions

The tools work without instructions. The agent works better, and cheaper, when its system prompt explains the following. Adapt this text to your client.

```md
You test a mobile app through the lynkeus tools.

Reading a screen
- `screen` prints a header (route, navigator path, the layer on top if any) and
  one line per element: index, kind, #testId, label, state.
- States: !disabled (will not answer a touch), ~covered (something is drawn
  over it), ~inert (readable, not touchable).
- Elements that are not presented (another tab, the screen under a sheet) are
  left out and counted in the header. They cannot be touched.
- There are no coordinates. Point at controls by #testId. An icon inside a
  button is part of the button.

Moving around
- Call `map_show <route>` before exploring a screen: it lists its buttons and
  where they lead, without opening it.
- Call `map_plan` with `from` and `to` for directions between two routes.
- When rows repeat a control, scope the press: target `#like-button` with
  `in` set to a text of that row.
- For something further down a list, `wait` with `scroll`.
- When a field acts on the return key, `type` with `submit`.

When something fails
- Call `why` instead of reading the screen again. It says whether the target is
  covered, hidden behind a layer, disabled or not there (and the nearest
  match), and whether the session is gone, the backend failed, or requests are
  still in flight.
```

Two points from that text deserve an explanation.

**Why `screen` and not `screen --json`.** An average screen reads in about 250 tokens in the text form. The JSON form is several times larger and carries nothing a model needs; it is for programs. With a sheet open, what the sheet covers is not in the listing at all.

**Why `why` and not `screen` after a failure.** Reading the screen again costs as much and says less. `why` reads the screen, the last requests and the trace as rules, and returns the conclusion. When a tool call fails over MCP, the error already carries that diagnosis.

## A sample exchange

As an illustration, here is one way an agent with the core tools can carry out the task "turn on dark mode":

1. `map_plan` from the current route to `Settings.Main`, to get the presses.
2. `press` on `#settings-button`, then `wait` for `Settings.Main`.
3. `screen`, to read the options.
4. `press` on the `Dark` option.
5. `screen`, to confirm the selected state.

## The cycle for a pull request

An agent that reviews a branch can use lynkeus to decide what to test, not only to run it.

1. `npx lynkeus map check --base main` on the branch lists the screens the diff reaches.
2. Crossed with which cases touch which routes, that gives the cases to run.
3. Run them. For each failure, call `why`.
4. Fix the case when the app changed on purpose, or the code when it did not.
5. The pull request carries the fix, the case and the screens the run recorded (`LYNKEUS_RECORD_SCREENS=1`), so the reviewer reads one diff.

`map check` is not one of the core tools. An agent with a shell can run it as a command.

## Reading reports from an AI client

This is a separate server from `lynkeus mcp`. The hosted service at lynkeus.io has its own MCP endpoint, which lets an AI client read your organization's runs, cases and what the backend did. It is read-only, and the client is signed in as you.

| Client | How to add it |
|---|---|
| Claude | Settings → Connectors → Add custom connector → `https://lynkeus.io/mcp` |
| Claude Code | `claude mcp add --transport http lynkeus https://lynkeus.io/mcp` |
| Cursor | `"mcpServers": { "lynkeus": { "url": "https://lynkeus.io/mcp" } }` |

Its tools are `list_runs`, `get_run`, `get_case`, `get_frame`, `case_history` and `flaky_cases`. `get_frame` returns the screen a step left as an image, by default the step that failed, so the client can see what the app showed. A run keeps frames when it was made with `--screenshots`.

The first time, the client opens lynkeus to ask for your approval and which organization it may read. You can disconnect it at any time under **Members**. See [Reports](/guides/reports/).

## How it works

The MCP server and the command line share one runtime. A tool call is turned back into the arguments of its command and executed the same way, so a tool behaves exactly as the command does in a terminal.

The server keeps one connection to the app, as `lynkeus session` does, so a tool call does not pay for a new process and a new connection each time.

Some commands are never served over MCP, in either size: `record` and the `report` commands, among others. They need a person or talk to the hosted service.

## Common problems

**The client shows no tools, or the server exits.** Run `npx lynkeus mcp` in the client's working directory by hand. It should start and wait. Check that the folder is the app's, or pass `--root`.

**Every tool call fails to attach.** The app is not running, is not a debug build, received an empty token (its log then says `lynkeus: the app passed a token and it is empty`), or has another token than the server: the one in `.lynkeus/token`, or `LYNKEUS_TOKEN` when the server's environment sets it. Call `status`: it says which piece is missing. After `init` made a token, the bundle needs Metro restarted with `--reset-cache` to carry it.

**`map_plan` has no directions.** Build the map with `npx lynkeus map build`, then add observed edges with `npx lynkeus crawl`.

**The agent keeps calling `screen`.** Tell it, in its instructions, to call `why` after a failure and `map_show` before exploring.

**The agent presses a tab that is not listed.** A tab bar drawn by the operating system, not by React Native, has no elements to list. Have the agent use `--full` and the `nav` tool to change routes. See [Expo](/platforms/expo/).

## Next steps

- [Driving the app](/guides/driving-the-app/): the commands behind the tools.
- [Writing cases](/guides/writing-cases/): turn what the agent explored into a test that runs without it.
- [CLI reference](/reference/cli/): every command and flag.

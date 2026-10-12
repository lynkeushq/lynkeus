---
title: AI agents
description: Let an AI agent drive your app through lynkeus mcp, and tell it how to read a screen, move around and diagnose a failure.
---

An AI agent that tests an app from screenshots pays twice: each picture costs many tokens, and the answer it extracts is a guess. Through lynkeus the agent reads the screen as structured text (routes, testIDs, labels, states) and acts on facts.

`lynkeus mcp` serves the lynkeus commands as tools over MCP, the Model Context Protocol that Claude, Cursor and other AI clients use to call tools. This guide shows how to connect it, which tools it serves, and what to put in the agent's instructions.

## Before you start

- The app is running with the agent and you can drive it from a terminal. See [Driving the app](/guides/driving-the-app/).
- You have an AI client that supports MCP servers over stdio.
- `LYNKEUS_TOKEN` is set in the environment the client starts the server in.

## Step 1: Start the server

`lynkeus mcp` is a stdio server: the AI client starts it as a child process and talks to it over standard input and output. The command to register in your client is:

```bash
npx lynkeus mcp
```

Run it from the app's folder, or pass `--root <dir>`, so that it finds `lynkeus.config.json` and the map of the app. How you register a stdio server depends on the client; follow its instructions for adding an MCP server with a command.

You should see the client list the lynkeus tools. Ask the agent what is on screen: it should call `screen` and describe the app's current screen.

## Step 2: Choose the tool set

The server comes in two sizes. The size matters because tool definitions are sent to the model on every turn.

| Command | Tools | Cost per turn |
|---|---|---|
| `npx lynkeus mcp` | The 9 core tools | About 750 tokens |
| `npx lynkeus mcp --full` | All 42 commands | About 4,200 tokens |

Start with the core. Add `--full` for an agent whose job is crawling, recording or snapshots.

### The core tools

| Tool | What it does |
|---|---|
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

## Step 3: Build the map

`map_show` and `map_plan` answer from a map of the app that lynkeus builds by reading the source. Build it once, and again when navigation changes:

```bash
npx lynkeus map build
```

You should see `.lynkeus/graph.json` written. The map lists every route, the testIDs each screen is likely to have, and the navigations it can perform.

The static map only knows the navigations it can read from source. If `map_plan` has no directions, run `npx lynkeus crawl` from the starting screen: it presses the controls it finds and records where each one actually leads.

## Step 4: Give the agent its instructions

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

`map check` is not one of the nine core tools. An agent with a shell can run it as a command.

## Reading reports from an AI client

This is a separate server from `lynkeus mcp`. The hosted service at lynkeus.io has its own MCP endpoint, which lets an AI client read your organization's runs, cases and what the backend did. It is read-only, and the client is signed in as you.

| Client | How to add it |
|---|---|
| Claude | Settings → Connectors → Add custom connector → `https://lynkeus.io/mcp` |
| Claude Code | `claude mcp add --transport http lynkeus https://lynkeus.io/mcp` |
| Cursor | `"mcpServers": { "lynkeus": { "url": "https://lynkeus.io/mcp" } }` |

The first time, the client opens lynkeus to ask for your approval and which organization it may read. You can disconnect it at any time under **Members**. See [Reports](/guides/reports/).

## How it works

The MCP server and the command line share one runtime. A tool call is turned back into the arguments of its command and executed the same way, so a tool behaves exactly as the command does in a terminal.

The server keeps one connection to the app, as `lynkeus session` does, so a tool call does not pay for a new process and a new connection each time.

Some commands are never served over MCP, in either size: `case run`, `record` and the `report` commands, among others. They run a whole suite, need a person, or talk to the hosted service.

## Common problems

**The client shows no tools, or the server exits.** Run `npx lynkeus mcp` in the client's working directory by hand. It should start and wait. Check that the folder is the app's, or pass `--root`.

**Every tool call fails to attach.** The app is not running, is not a debug build, or was built with a different token than the `LYNKEUS_TOKEN` in the server's environment. Set the variable in the environment the client gives the server.

**`map_plan` has no directions.** Build the map with `npx lynkeus map build`, then add observed edges with `npx lynkeus crawl`.

**The agent keeps calling `screen`.** Tell it, in its instructions, to call `why` after a failure and `map_show` before exploring.

**The agent presses a tab that is not listed.** A tab bar drawn by the operating system, not by React Native, has no elements to list. Have the agent use `--full` and the `nav` tool to change routes. See [Expo](/platforms/expo/).

## Next steps

- [Driving the app](/guides/driving-the-app/): the commands behind the tools.
- [Writing cases](/guides/writing-cases/): turn what the agent explored into a test that runs without it.
- [CLI reference](/reference/cli/): every command and flag.

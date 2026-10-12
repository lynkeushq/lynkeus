---
title: CLI reference
description: Every lynkeus command, argument and flag, with its default and what it does.
---

This page lists every command of the `lynkeus` CLI, in the groups the CLI itself uses: Drive, os, map, Runs and headless. Use it to look up a flag or copy an invocation. For how the commands fit together, start with [Driving the app](/guides/driving-the-app/) and [Writing cases](/guides/writing-cases/).

The CLI prints the same information: `lynkeus help` lists the commands, `lynkeus help <command>` prints one, and `lynkeus help --markdown` prints the whole reference.

## Conventions

### How to read a signature

`<name>` is a required argument, `[name]` is optional, and `…` means the argument repeats. A flag with a value is written `--flag <value>`; a flag without one is a switch.

- A value can follow the flag or be joined to it: `--timeout 5000` and `--timeout=5000` are the same.
- A switch never takes the next word as its value. `--no-<flag>` turns a switch off.
- A flag described as repeatable collects every value: `--var a=1 --var b=2`.
- Everything after a bare `--` is passed through untouched (only `headless start` uses it, for jest).

### Targets

Every command that touches or looks for an element takes a **target**: the way you name one element on screen.

| Spelling | Matches |
|---|---|
| `#next-button` | The element with that `testID`. |
| `Continue` or `Log in` | Any other text. A control (button or input) matches by exact label, then by substring. A paragraph matches only by its exact text. |
| `12` | The element at that index in the last `lynkeus screen` listing. |
| `100,200` | A point, in window points. |
| `#row[2]` or `Continue[2]` | The third match of a `testID` or a text (counted from 0). The same as `--nth 2`. |

Covered elements are never matched. When two elements tie, the later one wins, because it draws on top.

The CLI's own help writes a text target as `"text"`. The quotes there are for your shell, so that a label with spaces arrives as one argument; they are not part of the target. Quote targets that start with `#` too, since `#` starts a comment in most shells.

```bash
lynkeus press '#next-button'
lynkeus press 'Log in'
```

Where a command accepts a route or a target (`wait`, `see`, `why`), a word that looks like a route name is read as a route: words that start with a capital letter, joined by dots, such as `Settings.Main` or `Home`.

:::caution
This rule also catches a one-word label that starts with a capital letter. `lynkeus wait Continue` waits for a route named `Continue`, not for a button. Wait for such a control by its `testID`.
:::

### Exit codes

| Code | Meaning |
|---|---|
| `0` | The command did what it was asked. |
| `1` | It failed: an element was not found, an assertion did not hold, a case failed. |
| `2` | It was called wrongly: an unknown command or flag, a missing argument, a missing prerequisite such as `--out`. |
| `130` | `case run` was interrupted (Ctrl-C or SIGTERM). |

A failed `press`, `wait`, `type`, `swipe`, `see` or `nav` prints the error and then `why:` with what lynkeus read from the screen, the requests and the trace. See [Troubleshooting](/troubleshooting/).

## Drive

Commands that act on the app that is running, through the agent inside it. All of them need the app running with the agent mounted.

### `lynkeus screen`

```bash
lynkeus screen [--tree] [--record] [--all] [--frames] [--verbose]
```

Prints the route, the path and every element on screen. One line per element: index, kind, `#testId`, label, value and state (`!disabled`, `~covered`, `~inert`). Elements the platform is not presenting are left out and counted in the header.

| Flag | Meaning |
|---|---|
| `--tree` | Print the screen as nested lines with no geometry. This is the form to diff. |
| `--record` | Keep the structure under `.lynkeus/screens/` and report what changed since the last read. `LYNKEUS_RECORD_SCREENS=1` does the same. |
| `--all` | Also list the elements that are not presented. |
| `--frames` | Add the center of each element, in points. |
| `--verbose` | Add the commit count and the cost of the read to the header. |

### `lynkeus press`

```bash
lynkeus press <target> [--in <target>] [--nth <n>] [--hold <ms>] [--js] [--settle]
```

Puts a finger on an element.

| Argument | Meaning |
|---|---|
| `target` | What to press. See [Targets](#targets). |

| Flag | Meaning |
|---|---|
| `--in <target>` | Among several matches, take the one nearest this target (a `#testId` or a text). |
| `--nth <n>` | Take the nth match, counted from 0. |
| `--hold <ms>` | Keep the finger down this long. About 600 is a long press. |
| `--js` | Call the element's `onPress` directly instead of synthesizing a touch. |
| `--settle` | Wait for the app to stop committing, then print the screen. |

```bash
lynkeus press '#like-message-button' --in 'hi from Ana'
```

### `lynkeus type`

```bash
lynkeus type <text> [target] [--in <target>] [--nth <n>] [--paste] [--submit] [--clear]
```

Types into the focused input. With a target, taps it first.

| Argument | Meaning |
|---|---|
| `text` | What to type. |
| `target` | Optional. The field to tap before typing. |

| Flag | Meaning |
|---|---|
| `--in <target>` | Among several matches, take the one nearest this target. |
| `--nth <n>` | Take the nth match, counted from 0. |
| `--paste` | Insert the whole text at once instead of key by key. |
| `--submit` | Press the return key afterwards (fires `onSubmitEditing`). |
| `--clear` | Clear the field first. |

```bash
lynkeus type "1124888418" '#phone-input' --clear --submit
```

### `lynkeus swipe`

```bash
lynkeus swipe [direction] [target] [--distance <pt>] [--from <x,y>] [--to <x,y>] [--duration <ms>]
```

Drags a finger. On a target, it drives that element's own gesture (a slider, a sheet).

On a target the drag starts at its center, which a wide control cannot always afford: a slider that needs 80% of its width would end off-screen, and a touch that leaves the screen is canceled. `--from` and `--to` place both ends by hand.

| Argument | Meaning |
|---|---|
| `direction` | Optional. `up`, `down`, `left` or `right`. Omit it when you give `--from` and `--to`. |
| `target` | Optional. The element to swipe on. |

| Flag | Meaning |
|---|---|
| `--distance <pt>` | How far to drag, in points. |
| `--from <x,y>` | Where the finger lands. |
| `--to <x,y>` | Where it lifts. |
| `--duration <ms>` | How long the drag takes. |

```bash
lynkeus swipe up
lynkeus swipe right '#volume-slider' --distance 120
lynkeus swipe --from 40,400 --to 340,400
```

### `lynkeus back`

```bash
lynkeus back
```

Pops the current route.

### `lynkeus nav`

```bash
lynkeus nav <route> [params]
```

Jumps straight to a route. This is a teleport, not something a user does: use it to get to where a test starts.

| Argument | Meaning |
|---|---|
| `route` | The route name, such as `Settings.Main`. |
| `params` | Optional. The route's params, as JSON. |

```bash
lynkeus nav Checkout.Confirm '{"id":"abc"}'
```

### `lynkeus wait`

```bash
lynkeus wait <what> [--in <target>] [--nth <n>] [--gone] [--scroll] [--timeout <ms>]
```

Waits until a route or an element appears (or leaves), or for a number of milliseconds.

| Argument | Meaning |
|---|---|
| `what` | A route, a target, or a number of milliseconds such as `800`. |

| Flag | Default | Meaning |
|---|---|---|
| `--in <target>` | | Among several matches, take the one nearest this target. |
| `--nth <n>` | | Take the nth match, counted from 0. |
| `--gone` | | Wait until it leaves the screen. |
| `--scroll` | | Scroll until the target is in the window. |
| `--timeout <ms>` | `10000` | Give up after this long. |

```bash
lynkeus wait Settings.Main
lynkeus wait '#spinner' --gone
lynkeus wait '#row-25' --scroll
```

### `lynkeus screenshot`

```bash
lynkeus screenshot <file>
```

Writes what the screen looks like right now to a PNG file. It needs a device or a simulator: the headless host renders nothing to capture.

| Argument | Meaning |
|---|---|
| `file` | Where to write the PNG. |

### `lynkeus see`

```bash
lynkeus see <what> [--absent] [--within <ms>]
```

Asserts that a route or an element is on screen now. Exits with 1 if it is not.

| Argument | Meaning |
|---|---|
| `what` | A route or a target. |

| Flag | Default | Meaning |
|---|---|---|
| `--absent` | | Assert that it is not there. |
| `--within <ms>` | `0` | Allow it this long to appear. |

### `lynkeus idle`

```bash
lynkeus idle [--quiet <ms>] [--timeout <ms>] [--after <commit>]
```

Waits until the app stops committing: the data has arrived and the animations are done.

A screen that has not started looks exactly like one that has finished, because both are quiet. `--after <commit>` takes the commit count from before the thing you are waiting for, and waits for the app to commit past it first.

| Flag | Default | Meaning |
|---|---|---|
| `--quiet <ms>` | `300` | No commit for this long counts as settled. |
| `--timeout <ms>` | `5000` | Give up after this long. The answer says whether the app settled. |
| `--after <commit>` | | A commit count from before. Quiet only counts once the app has committed past it. |

### `lynkeus requests`

```bash
lynkeus requests [--last <n>]
```

Lists the HTTP requests the app made: method, path, status and duration. Headers and bodies are never recorded.

| Flag | Default | Meaning |
|---|---|---|
| `--last <n>` | `30` | How many requests to list. |

### `lynkeus trace`

```bash
lynkeus trace [--since <seq>] [--last <n>]
```

Lists what happened in the app, in order: routes, requests, store changes, touches and commands.

| Flag | Default | Meaning |
|---|---|---|
| `--since <seq>` | | Only events after this sequence number (taken from an earlier trace). |
| `--last <n>` | `60` | How many events to list. |

### `lynkeus call`

```bash
lynkeus call <command> [params]
```

Runs a command the app registered with `qa.register`. See the [Agent API](/reference/agent-api/).

| Argument | Meaning |
|---|---|
| `command` | The command's name. |
| `params` | Optional. Its params, as JSON. |

```bash
lynkeus call reset
lynkeus call stores '{"name":"session"}'
lynkeus call events '{"clear":true}'
```

### `lynkeus hello`

```bash
lynkeus hello
```

Prints what the app said about itself when it attached: its platform, whether native touches are available, and the commands it registered.

### `lynkeus launch`

```bash
lynkeus launch [bundleId] [--clean]
```

Relaunches the app and waits for the agent.

| Argument | Meaning |
|---|---|
| `bundleId` | Optional. The app to launch. Without it, `--app` or `app` in `lynkeus.config.json`. |

| Flag | Meaning |
|---|---|
| `--clean` | Run the app's `reset` command first, if the app is attached. |

### `lynkeus why`

```bash
lynkeus why [target] [--route <Route>]
```

Explains why the last thing failed, by reading the screen, the requests and the trace as rules. It runs by itself after a failed `press`, `wait`, `type`, `swipe` or `nav`. Give it what you were looking for to sharpen the answer.

| Argument | Meaning |
|---|---|
| `target` | Optional. What was expected: a route or a target. |

| Flag | Meaning |
|---|---|
| `--route <Route>` | The route that was expected. |

```bash
lynkeus why 'Log in'
lynkeus why --route Settings.Main
```

### `lynkeus lint`

```bash
lynkeus lint [--strict] [--no-contrast] [--save <file>] [--baseline <file>]
```

Reads the current screen and reports controls with no label, small touch targets, low-contrast text, text that is an untranslated key, controls a touch cannot reach, elements cut by the window, and duplicate `testID`s. See [Lint and contrast](/guides/lint-and-contrast/).

| Flag | Meaning |
|---|---|
| `--strict` | Exit with 1 on any warning. |
| `--no-contrast` | Skip the contrast check for this run. The check takes a screenshot. |
| `--save <file>` | Keep this screen's findings in a baseline file. |
| `--baseline <file>` | Print only what is new against a baseline file. Without it, `lintBaseline` in `lynkeus.config.json`. |

:::note
The contrast check and `--no-contrast` are new and not yet in a published release.
:::

```bash
lynkeus lint --save .lynkeus/lint/home.json        # on main
lynkeus lint --baseline .lynkeus/lint/home.json    # on the branch
```

### `lynkeus perf`

```bash
lynkeus perf [--since <seq>] [--last <n>]
```

Reports, per screen: the requests made on arrival, the time to quiet, errors, stalls and the slowest call.

| Flag | Meaning |
|---|---|
| `--since <seq>` | Only events after this trace sequence number. |
| `--last <n>` | Only the last n trace events. |

### `lynkeus profile`

```bash
lynkeus profile [action]
```

Reports what React spent rendering, per route, as measured by the Profiler that `auto()` mounts. Recording is off until started, so an app that never asks pays nothing.

| Argument | Meaning |
|---|---|
| `action` | Optional. `start` clears and starts recording. `stop` reports and stops. Omit it to report what was recorded so far. |

## os

Commands for what the outside world hands the app: links, the clock, sensors, the network and the simulator.

Commands marked **Headless** work only when the app runs under the headless host. Commands marked **Simulator** reach a simulator from outside. `os deeplink` works on both.

Most of these commands also answer to a short alias without `os`; the grouped names are the documented ones.

### `lynkeus os deeplink`

```bash
lynkeus os deeplink <url>
```

Opens a URL in the app, as the OS would hand it over. Alias: `deeplink`.

| Argument | Meaning |
|---|---|
| `url` | The link, such as `myapp://pay/abc` or an `https://` URL. |

### `lynkeus os appstate`

```bash
lynkeus os appstate <state>
```

**Headless.** Makes `AppState` listeners see a change. Send `background` and then `active` to test what refetches or locks again on return. Alias: `appstate`.

| Argument | Meaning |
|---|---|
| `state` | `active`, `background` or `inactive`. |

### `lynkeus os network`

```bash
lynkeus os network <state>
```

**Headless.** Airplane mode: requests fail, open sockets drop and NetInfo listeners hear it. Alias: `network`.

| Argument | Meaning |
|---|---|
| `state` | `off` or `on`. |

### `lynkeus os clock`

```bash
lynkeus os clock [--now <iso>] [--advance <ms>] [--reset]
```

**Headless.** Sets what `Date` answers. Timers stay real. Alias: `clock`.

| Flag | Meaning |
|---|---|
| `--now <iso>` | Set the time, as an ISO 8601 date. |
| `--advance <ms>` | Move the clock forward. |
| `--reset` | Go back to the real clock. |

```bash
lynkeus os clock --now 2027-01-01T00:00:00Z
```

### `lynkeus os biometrics`

```bash
lynkeus os biometrics [--available <kind>] [--next <success,fail,cancel>] [--fallback <outcome>]
```

**Headless.** Sets the biometric sensor and what the next prompts answer. Alias: `biometrics`.

| Flag | Meaning |
|---|---|
| `--available <kind>` | `FaceID`, `TouchID` or `none`. |
| `--next <success,fail,cancel>` | The outcomes of the next prompts, in order, comma-separated. |
| `--fallback <outcome>` | What a fallback prompt answers. |

```bash
lynkeus os biometrics --available FaceID --next fail,success
```

### `lynkeus os scan`

```bash
lynkeus os scan <value> [--type <qr|ean13|…>]
```

**Headless.** Hands a value to the code scanner of the open camera. Alias: `scan`.

| Argument | Meaning |
|---|---|
| `value` | What the code carries. |

| Flag | Default | Meaning |
|---|---|---|
| `--type <qr\|ean13\|…>` | `qr` | The code type. |

### `lynkeus os gallery`

```bash
lynkeus os gallery [uri] [--cancel] [--name <name>] [--mime <type>]
```

**Headless.** Sets what the next image picker answers. Alias: `gallery`.

| Argument | Meaning |
|---|---|
| `uri` | Optional. The file the picker returns. |

| Flag | Meaning |
|---|---|
| `--cancel` | The user canceled the picker. |
| `--name <name>` | The file name reported. |
| `--mime <type>` | The MIME type reported. |

```bash
lynkeus os gallery ./fixtures/id.jpg --name id.jpg --mime image/jpeg
```

### `lynkeus mock`

```bash
lynkeus mock [route] [--status <code>] [--body <json>] [--delay <ms>] [--times <n>] [--sticky] [--lost] [--clear] [--list]
```

**Headless.** Answers a request before it reaches the network. A rule without `--sticky` is dropped by the app's `reset` command.

| Argument | Meaning |
|---|---|
| `route` | Optional. `'GET /path'`. A bare path matches any method. |

| Flag | Default | Meaning |
|---|---|---|
| `--status <code>` | `200` | The HTTP status to answer. |
| `--body <json>` | | The JSON body to answer. |
| `--delay <ms>` | | Answer after this long. |
| `--times <n>` | | Apply the rule only this many times. |
| `--sticky` | | Keep the rule across an app reset. |
| `--lost` | | Let the request reach the server, then fail it on the way back. |
| `--clear` | | Drop every rule. |
| `--list` | | Show the rules. |

```bash
lynkeus mock 'GET /v3/accounts' --status 500 --delay 3000
lynkeus mock '/v3/accounts' --body '[]' --times 1
lynkeus mock --clear
```

### `lynkeus os permissions`

```bash
lynkeus os permissions <action> <service>
```

**Simulator.** Grants, revokes or resets a permission for the app.

| Argument | Meaning |
|---|---|
| `action` | `grant`, `revoke` or `reset`. |
| `service` | `camera`, `photos`, `location`, `microphone`, `contacts`, and so on. |

### `lynkeus os push`

```bash
lynkeus os push <payload>
```

**Simulator.** Delivers a push notification to the app.

| Argument | Meaning |
|---|---|
| `payload` | The notification as JSON, such as `'{"alert":"…"}'`, or a `.json` file. |

### `lynkeus os appearance`

```bash
lynkeus os appearance <mode>
```

**Simulator.** Switches between light and dark.

| Argument | Meaning |
|---|---|
| `mode` | `light` or `dark`. |

### `lynkeus os location`

```bash
lynkeus os location <where>
```

**Simulator.** Sets where the device is.

| Argument | Meaning |
|---|---|
| `where` | `<lat>,<lon>`, or `clear`. |

### `lynkeus os language`

```bash
lynkeus os language [tag]
```

**Simulator.** Relaunches the app in a locale.

| Argument | Meaning |
|---|---|
| `tag` | Optional. A language tag such as `de-DE` or `en-US`. Without it, the locale in `lynkeus.config.json`. |

## map

Commands for what lynkeus knows before it touches anything, read from the app's source and learned from walking the app. Everything they write lives under `.lynkeus/` in the app's folder.

### `lynkeus map build`

```bash
lynkeus map build [--as-base]
```

Reads the source once and writes routes, `testID`s and navigations to `.lynkeus/graph.json`. Most other `map` commands need this file.

| Flag | Meaning |
|---|---|
| `--as-base` | Also keep it as `graph.base.json`, for `map check` to diff against. |

### `lynkeus map screens`

```bash
lynkeus map screens
```

Lists every route in the graph, and every route a run has actually opened.

### `lynkeus map show`

```bash
lynkeus map show <route>
```

Lists the `testID`s and navigations a screen is likely to have, as read from source.

| Argument | Meaning |
|---|---|
| `route` | The route, such as `Settings.Main`. |

### `lynkeus map paths`

```bash
lynkeus map paths <route>
```

Lists what leads to a route: edges observed in runs first, then edges read from source.

| Argument | Meaning |
|---|---|
| `route` | The route, such as `Checkout.Confirm`. |

### `lynkeus map plan`

```bash
lynkeus map plan [--from <Route>] [--to <Route>]
```

Gives directions from one route to another: which buttons to press, screen by screen. Alias: `plan`.

| Flag | Meaning |
|---|---|
| `--from <Route>` | The starting route. |
| `--to <Route>` | The destination route. |

```bash
lynkeus map plan --from Settings.Main --to Settings.Profile
```

### `lynkeus map impact`

```bash
lynkeus map impact <file>… [--depth <n>] [--direct]
```

Lists the screens a change can reach, nearest first.

| Argument | Meaning |
|---|---|
| `file` | The changed source files. |

| Flag | Default | Meaning |
|---|---|---|
| `--depth <n>` | `4` | How many imports away to look. |
| `--direct` | | Only the screen and the files that import it. |

### `lynkeus map ci`

```bash
lynkeus map ci [--force] [--depth <n>]
```

Writes `.github/workflows/lynkeus-map-check.yml` in the app. On every pull request the workflow builds the map from the sources (no app and no device), runs `map check` against the base branch and keeps one comment on the pull request up to date with the screens its diff reaches.

| Flag | Default | Meaning |
|---|---|---|
| `--force` | | Overwrite the workflow if it exists. |
| `--depth <n>` | `2` | How many imports away the check looks. |

### `lynkeus map check`

```bash
lynkeus map check [--base <ref>] [--graph-base <file>] [--depth <n>]
```

Describes a branch from the app's side: the screens its diff reaches, and the routes, navigations and `testID`s that changed.

| Flag | Default | Meaning |
|---|---|---|
| `--base <ref>` | `main` | The git ref to diff against. |
| `--graph-base <file>` | `.lynkeus/graph.base.json` | The graph to diff against. |
| `--depth <n>` | `4` | How many imports away to look. |

### `lynkeus map changes`

```bash
lynkeus map changes [--last <n>]
```

Lists the `testID`s that appeared, disappeared or moved on a recorded screen since it was last read. It reads what `lynkeus screen --record` keeps.

| Flag | Default | Meaning |
|---|---|---|
| `--last <n>` | `30` | How many changes to list. |

## Runs

Commands that run something from start to end: flows, cases, smokes, crawls and recordings, and the commands that send a run to the hosted report service.

### `lynkeus run`

```bash
lynkeus run <flow.json> [--var <k=v>] [--screenshots] [--diff] [--events]
```

Replays a flow (a JSON file of steps) with variables, and reports per-step timing, route and errors.

| Argument | Meaning |
|---|---|
| `flow.json` | The flow file. |

| Flag | Meaning |
|---|---|
| `--var <k=v>` | A flow variable. Repeatable. |
| `--screenshots` | Take one screenshot per step. |
| `--diff` | Print what changed on screen after each step. |
| `--events` | Keep the app's analytics events per step, in `events.jsonl` in the run folder. This empties the app's event buffer. |

```bash
lynkeus run flows/login.json --var phone=1124888418 --diff --screenshots
```

### `lynkeus events`

```bash
lynkeus events [--run <dir>] [--name <regex>]
```

Shows what the app told its analytics. Without `--run`, it shows what the app has recorded so far and leaves the buffer as it is. With `--run`, it shows the events a `run --events` kept, each with the step and the route it happened on.

| Flag | Meaning |
|---|---|
| `--run <dir>` | A run folder, or `last`. |
| `--name <regex>` | Only events whose name matches. |

### `lynkeus events diff`

```bash
lynkeus events diff <before> <after>
```

Compares the same flow on two builds: the events that appeared, disappeared or changed shape.

| Argument | Meaning |
|---|---|
| `before` | A run folder (from main). |
| `after` | A run folder (from the branch), or `last`. |

### `lynkeus funnel check`

```bash
lynkeus funnel check <name> [--run <dir>]
```

Checks that a run produced a funnel: every step, in order, with the properties it needs. Exits with 1 when a step is missing, out of order, or has the wrong shape.

A funnel is the file `.lynkeus/funnels/<name>.json`:

```json title=".lynkeus/funnels/signup.json"
{
  "steps": [
    { "event": "signup_started", "props": { "source": "string", "step": "number" } },
    { "event": "signup_completed" }
  ]
}
```

A property names a type the dashboard needs, or a value it filters on.

| Argument | Meaning |
|---|---|
| `name` | The funnel's name. |

| Flag | Default | Meaning |
|---|---|---|
| `--run <dir>` | `last` | A run folder, or `last`. |

### `lynkeus funnel report`

```bash
lynkeus funnel report [--last <n>]
```

Shows, across the recorded runs, which funnel steps some run produces and which none does.

| Flag | Default | Meaning |
|---|---|---|
| `--last <n>` | `50` | How many recent runs to read. |

### `lynkeus flake`

```bash
lynkeus flake <flow.json> [--times <n>] [--var <k=v>]
```

Runs the same flow n times and reports how often it passes, and the step and error it fails on.

| Argument | Meaning |
|---|---|
| `flow.json` | The flow file. |

| Flag | Default | Meaning |
|---|---|---|
| `--times <n>` | `5` | How many runs. |
| `--var <k=v>` | | A flow variable. Repeatable. |

```bash
lynkeus flake flows/login.json --times 10
```

### `lynkeus smoke`

```bash
lynkeus smoke [Route.Prefix]… [--params <file>] [--screenshots] [--overlay-when <target>] [--overlay-flow <flow.json>]
```

Opens every route that needs no params (or only the routes under the prefixes given) and records what renders.

| Argument | Meaning |
|---|---|
| `Route.Prefix` | Optional. Only routes under these prefixes. |

| Flag | Meaning |
|---|---|
| `--params <file>` | A route params type map, relative to the app. |
| `--screenshots` | Take one screenshot per screen. |
| `--overlay-when <target>` | A target the app raises on its own, such as a lock screen or a rating prompt. |
| `--overlay-flow <flow.json>` | The flow that clears it. |

### `lynkeus crawl`

```bash
lynkeus crawl [Route] [--depth <n>] [--max <n>] [--to <Route>] [--fresh] [--overlay-when <target>] [--overlay-flow <flow.json>] [--login-flow <a.json,b.json>] [--var <k=v>] [--var-cmd <name='cmd'>] [--press-anything] [--verbose]
```

Presses every control it finds and learns where each one leads. What it learns feeds `map paths` and `map plan`.

The crawl finishes a screen before it goes anywhere, and remembers in `.lynkeus/frontier.jsonl` what it did not get to, so a second run continues instead of repeating.

It is read-only by default. Every press happens, but the moment one makes the app write (a `POST`, `PUT`, `PATCH` or `DELETE`) the crawl reports it, stops exploring past it, and never presses that control again. Controls that must not be pressed at all go under `crawl.never` in `lynkeus.config.json`. lynkeus ships no list of its own, because which controls are irreversible depends on the app.

| Argument | Meaning |
|---|---|
| `Route` | Optional. Where to start. Without it, the current screen. |

| Flag | Default | Meaning |
|---|---|---|
| `--depth <n>` | `1` | How many screens deep to go. |
| `--max <n>` | `80` | At most this many presses. |
| `--to <Route>` | | Walk toward this route and stop on arrival, instead of exploring everything. |
| `--fresh` | | Ignore what earlier runs already pressed. |
| `--overlay-when <target>` | | A target the app raises on its own, such as a lock screen or a rating prompt. |
| `--overlay-flow <flow.json>` | | The flow that clears it. |
| `--login-flow <a.json,b.json>` | | Flows that log in again after a reset, comma-separated. |
| `--var <k=v>` | | A flow variable. Repeatable. |
| `--var-cmd <name='cmd'>` | | A variable produced by a shell command when it is needed. Repeatable. |
| `--press-anything` | | Keep exploring past a press that wrote. For a disposable environment only. |
| `--verbose` | | Print every recovery and decision. |

:::caution
`--press-anything` lets the crawl submit forms and delete things. Use it only against a backend you can throw away.
:::

### `lynkeus record`

```bash
lynkeus record [--out <flow.json>] [--so-far] [--screenshots]
```

Watches what a person does in the app. Ctrl-C writes a flow with each step and what it caused.

Touches are traced on device builds mounted with `auto()`. A headless host records routes and requests only. Lines typed on stdin run as commands meanwhile.

| Flag | Meaning |
|---|---|
| `--out <flow.json>` | Where to write the flow. |
| `--so-far` | Draft a flow from the trace as it stands, and stop. |
| `--screenshots` | Take one screenshot per touch, listed in `<out>.strip.md`. |

### `lynkeus snapshot`

```bash
lynkeus snapshot <name> [--update] [--pixels] [--tolerance <ratio>] [--no-freeze]
```

Keeps a baseline for a screen and compares against it: its tree, diffed like code, and on a simulator its pixels.

The tree is the screen as nested lines: kinds, labels, `testID`s, values and states, with no geometry. Baselines live under `.lynkeus/snapshots/`; what differs goes under `.lynkeus/runs/`.

| Argument | Meaning |
|---|---|
| `name` | The baseline's name, such as `onboarding-hero`. |

| Flag | Default | Meaning |
|---|---|---|
| `--update` | | The change is intended: overwrite the baseline. |
| `--pixels` | | Also compare a screenshot. Needs a simulator. |
| `--tolerance <ratio>` | `0.001` | The fraction of pixels allowed to differ. |
| `--no-freeze` | | Do not pin the status bar before the screenshot. |

### `lynkeus case run`

```bash
lynkeus case run [files]… [--host] [--once] [--continue] [--seen <dir>] [--report <file>] [--events <dir>] [--out <dir>] [--screenshots] [--video] [--traces] [--traces-port <port>] [--push] [--project <name>] [--video-fps <n>] [--flakes <file>] [--prepared <dir>] [--jobs <n>] [--ports <list>] [--host-command <command>] [--in-order] [--ahead <n>] [--idle <share>] [--dry-run]
```

Runs cases: the setup through fixtures, the steps against the app, and the evidence when one fails. The file format is in the [Case format reference](/reference/case-format/).

Without files, it runs every case in `cases.dir`. A failed case runs once more before it counts as failed, unless `--once`. The command exits with 1 when any case failed. A case that cannot run on this host is not a failure.

| Argument | Meaning |
|---|---|
| `files` | Optional. The case files. Without them, every `.md` under `cases.dir`. |

| Flag | Default | Meaning |
|---|---|---|
| `--host` | | Start `lynkeus headless start` for the run and stop it afterwards. |
| `--once` | | No second chance for a case that fails. |
| `--continue` | | Keep running a case's steps after one fails. A failed setup still stops the case. |
| `--seen <dir>` | | Write `<dir>/<case id>.json` with the screens each passing case went through, for a coverage map. |
| `--report <file>` | | Append one JSON line per case to this file. |
| `--events <dir>` | | Keep what the app told its analytics, per case, as `<dir>/<case id>/events.jsonl`. |
| `--out <dir>` | | Write the run as a directory a report can read: `run.json` and `cases.jsonl`, one line per attempt. |
| `--screenshots` | | With `--out`: a frame of the screen after every app step. |
| `--video` | | With `--out`: film each case, where the host can film. Each step says at what second it began. |
| `--traces` | | Listen for the backend's OpenTelemetry traces (OTLP over HTTP) and keep, under each step, what the backend did for it. Point the backend's `OTEL_EXPORTER_OTLP_ENDPOINT` at `http://localhost:<traces-port>`. |
| `--traces-port <port>` | `4318` | Where `--traces` listens. |
| `--push` | | With `--out`: upload the run to the report service when it ends and print the report's address. |
| `--project <name>` | the app's folder name | With `--push`: the project the run is filed under. |
| `--video-fps <n>` | `30` | Frames per second of the film. |
| `--flakes <file>` | `.lynkeus/flakes.json` | The ledger of how each case did across runs. |
| `--prepared <dir>` | | Where `case prepare` leaves setups made ahead. A case found there skips its setup. |
| `--jobs <n>` | `1` | How many cases run at once, each on its own host. Needs `--ports`. |
| `--ports <list>` | | The driver port of each job, comma-separated: where its host dials in. |
| `--host-command <command>` | | A command that starts a fresh host for every case; lynkeus stops it afterwards. `{port}` is replaced by the port the host must dial, `{job}` by the job's number. |
| `--in-order` | | With `--jobs`: take the cases in the order given, not the longest first. |
| `--ahead <n>` | `0` | Make up to this many setups ahead of their cases while others run. `0` makes none. |
| `--idle <share>` | `0.25` | With `--ahead`: start a setup only while this share of the CPU is idle. |
| `--dry-run` | | Parse the cases and list their steps without running them. |

`--screenshots`, `--video` and `--push` all need `--out`. `--jobs` above 1 and `--host-command` need one port per job in `--ports`.

```bash
lynkeus case run cases/gift.md --host
lynkeus case run --out run --screenshots --video --push
lynkeus case run --jobs 2 --ports 8123,8124 --host-command 'LYNKEUS_PORT={port} npx lynkeus headless start'
```

### `lynkeus case prepare`

```bash
lynkeus case prepare [files]… [--prepared <dir>] [--jobs <n>] [--ahead <n>] [--idle <share>]
```

Runs the setup of cases ahead of them, so each case starts at its first step.

It is for a suite that starts `case run --prepared <dir>` once per case. Start `case prepare` first, with the same cases in the order they will run, and leave it running. It runs every setup made only of the project's fixtures and leaves what each produced in the directory. A case that starts before its setup is ready runs its own setup, and `case prepare` skips it. It tells the fixtures server that it works ahead (`lynkeus.ahead`), so the server can give it a lower priority.

| Argument | Meaning |
|---|---|
| `files` | Optional. The case files, in the order they will run. Without them, every `.md` under `cases.dir`. |

| Flag | Default | Meaning |
|---|---|---|
| `--prepared <dir>` | `.lynkeus/prepared` | Where to leave the setups. The directory is emptied first. |
| `--jobs <n>` | `1` | How many setups are made at once. |
| `--ahead <n>` | `4` | At most this many setups kept ready and not yet taken. |
| `--idle <share>` | `0.25` | Start a setup only while at least this share of the CPU is idle (0 to 1). |

### `lynkeus case init`

```bash
lynkeus case init [--force]
```

Writes an example case (`example.md`), the reference of the format (`README.md`) and a fixtures server to start from (`fixtures.mjs`) into the cases folder, and adds a `cases` section to `lynkeus.config.json`.

| Flag | Meaning |
|---|---|
| `--force` | Overwrite what is there. |

### `lynkeus report push`

```bash
lynkeus report push <dir> [--project <name>]
```

Uploads a run to the report service and prints the report's address. It uploads what `case run --out <dir>` wrote: the run, its cases, and every frame and film they name.

The service's address and the organization's key come from `LYNKEUS_REPORTS_URL` and `LYNKEUS_REPORTS_KEY`. A film the organization's plan does not keep is left out, and the command says so.

| Argument | Meaning |
|---|---|
| `dir` | The run directory that `case run --out` wrote. |

| Flag | Default | Meaning |
|---|---|---|
| `--project <name>` | the app's folder name | The project the run is filed under. |

### `lynkeus report list`

```bash
lynkeus report list [--limit <n>]
```

Lists the organization's reports, newest first. Each line shows when the run started, its project and platform, how many cases passed, and the report's address.

| Flag | Default | Meaning |
|---|---|---|
| `--limit <n>` | `20` | How many runs to list. At most 100. |

### `lynkeus report plan`

```bash
lynkeus report plan [--upgrade] [--manage]
```

Shows the organization's plan. Free keeps frames for 7 days and one project. Team keeps films too, for 90 days, and any number of projects.

| Flag | Meaning |
|---|---|
| `--upgrade` | Print the Stripe checkout address for the Team plan. |
| `--manage` | Print the Stripe portal address for a paying organization: the card, the invoices and canceling. |

### `lynkeus report flakes`

```bash
lynkeus report flakes [--project <name>] [--runs <n>]
```

Lists the cases that do not always pass at the first try, across the project's last runs, the least reliable first. Each line shows the recent runs newest first (✓ passed, ↻ passed on a retry, ✗ failed) and the last report where the case went wrong. A case that failed its last three runs is reported as broken rather than flaky. Needs the Team plan.

| Flag | Default | Meaning |
|---|---|---|
| `--project <name>` | the app's folder name | The project. |
| `--runs <n>` | `30` | How many of the latest runs to read. |

### `lynkeus report history`

```bash
lynkeus report history <case> [--project <name>] [--runs <n>]
```

Shows how one case came out in each of the project's last runs, newest first: ✓ passed, ↻ passed on a retry, ✗ failed, with how long it took, the branch and commit the run was made from, and the report to open. This is what tells a case that fails now and then from one a commit broke.

| Argument | Meaning |
|---|---|
| `case` | The case id. |

| Flag | Default | Meaning |
|---|---|---|
| `--project <name>` | the app's folder name | The project. |
| `--runs <n>` | `50` | How many of the latest runs to read. |

## headless

Commands for the headless host: the app hosted in Node under jest, with no simulator. See [Headless](/platforms/headless/).

### `lynkeus headless start`

```bash
lynkeus headless start [--entry <file>] [-- <jest arguments>]
```

Hosts the app in Node (jest and React Native Testing Library) and waits for a driver. It speaks the same protocol as a device. Alias: `headless`.

It needs `LYNKEUS_TOKEN` in the environment, with the value the app reads for its token, and refuses to start without it. `LYNKEUS_PORT` moves the host and its driver together. `LYNKEUS_HOST` says where the driver is listening, for a host that does not run in the same place as its driver. Arguments after `--` go to jest. When the host crashes, the last lines printed say what the error usually means.

| Flag | Default | Meaning |
|---|---|---|
| `--entry <file>` | `entry` in `lynkeus.config.json`, else `qa/headless.tsx` | The headless entry file. |

```bash
LYNKEUS_TOKEN=secret lynkeus headless start
```

### `lynkeus headless init`

```bash
lynkeus headless init [--entry <file>] [--component <App.tsx>] [--api-env <NAME>] [--auto] [--force]
```

Writes the headless entry: the default mocks, a guard that refuses a backend that is not local, and your `App`.

| Flag | Default | Meaning |
|---|---|---|
| `--entry <file>` | `entry` in `lynkeus.config.json`, else `qa/headless.tsx` | The headless entry file. |
| `--component <App.tsx>` | | The file of the `App` component. It is found by itself when it sits in a standard place. |
| `--api-env <NAME>` | `apiEnv` in `lynkeus.config.json`, else `API_URL` | The environment variable the app reads its API base from. |
| `--auto` | | Also mount the agent from `index.js` with `auto()`. |
| `--force` | | Overwrite an existing entry. |

### `lynkeus headless doctor`

```bash
lynkeus headless doctor [--entry <file>] [--fix] [--explain <text>]
```

Lists what lynkeus mocks, and which native modules of the app still need a mock.

| Flag | Default | Meaning |
|---|---|---|
| `--entry <file>` | `entry` in `lynkeus.config.json`, else `qa/headless.tsx` | The headless entry file. |
| `--fix` | | Write stubs for the uncovered modules into the entry. |
| `--explain <text>` | | Turn a jest error into its usual cause and fix. Paste the first line of the error, not the stack. |

```bash
lynkeus headless doctor --explain "Cannot find module '~hooks' from 'src/App.tsx'"
```

## Modes

Three invocations are not commands in a group. They change how the other commands are reached.

### `lynkeus session`

```bash
lynkeus session
```

Keeps one connection open and reads commands on stdin, one per line, each a JSON array of arguments. It answers one JSON object per line. A command on its own pays for a process and a connection; a step in a session costs about 50 ms.

```bash
printf '%s\n' '["press","#next-button"]' '["wait","Settings.Main"]' '["screen"]' | lynkeus session
```

| Line | Meaning |
|---|---|
| `{"ok": true, "out": "…", "json": …}` | The command succeeded. `out` is what the terminal would print. `json` is present when the command has machine-readable output. |
| `{"ok": false, "error": "…", "why": "…"}` | The command failed. `why` is present when lynkeus could read a reason from the app. |

The first line it prints is `{"ok": true, "out": "attached (<name>)"}`, once the app has attached. The line `["exit"]` ends the session. Some commands are not available in a session, among them `case run`, the `report` commands and `headless start`; `lynkeus help <command>` says whether one is.

### `lynkeus mcp`

```bash
lynkeus mcp [--full]
```

Serves commands as MCP tools over stdio, for an AI agent. Without flags it serves the core: `screen`, `press`, `type`, `wait`, `why`, `call`, `os deeplink`, `map show` and `map plan`. See [AI agents](/guides/ai-agents/).

| Flag | Meaning |
|---|---|
| `--full` | Serve every command that needs the app or the graph, at about five times the tokens per turn. |

When `language` or `locale` is set in `lynkeus.config.json`, the server also offers an `app_locale` tool that reports them.

### `lynkeus help` and `lynkeus commands`

```bash
lynkeus help [command] [--markdown]
lynkeus commands
```

`lynkeus help` prints the usage. `lynkeus help <command>` prints one command, including what it needs (the app, the graph, or nothing) and whether it is available in a session or over MCP. `lynkeus help --markdown` prints the full reference as Markdown. `lynkeus commands` prints the name of every command, one per line.

## Global flags

Every command accepts these.

| Flag | Default | Meaning |
|---|---|---|
| `--root <dir>` | the current folder | The app's folder: where `lynkeus.config.json` and `.lynkeus/` live. |
| `--device <udid\|name>` | | The simulator to use, by udid or by name. |
| `--app <bundleId>` | | The app's bundle id, for launching and for simulator commands. |
| `--launch` | | Relaunch the app before attaching. Needs `--app`. |
| `--attach-timeout <ms>` | `15000` | How long to wait for the app to attach. |
| `--json` | | Print machine-readable output, when the command has one. |
| `--help` | | Print the command's help. |

`--device`, `--app` and `--attach-timeout` can also come from the environment or from `lynkeus.config.json`. Flags win over the environment, and the environment wins over the file. See [Configuration](/reference/configuration/) and [Environment variables](/reference/environment-variables/).

---
title: Concepts
description: The vocabulary of lynkeus, defined once. Agent, driver, host, screen, element, target, route, case, step, run, fixtures and report.
---

The rest of the documentation uses a small set of terms, always with the same meaning. This page defines each one in a few sentences, in the order they build on each other. Read it once after [your first test](/getting-started/first-test/); come back to it when a guide uses a word you are not sure of.

The terms fall into three groups: the programs involved (agent, driver, host), what the app shows (screen, element, target, route), and what a test is made of (case, step, fixtures, run, report).

## The programs

### Agent

The **agent** is the code mounted inside your app, from the `lynkeus-agent` package. In a debug build it opens a WebSocket to your machine and answers requests: what is on screen, press this, type that, wait for a route.

The agent is what makes lynkeus different from tools that drive an app through the operating system. It reads the tree React rendered, measures each element, and asks the platform which element a touch would reach. It synthesizes touches and keystrokes inside the app's process.

Nothing listens inside the app. The app dials out; if nobody answers, it stays quiet and tries again. The agent runs only when it is enabled, which by default means in development (`__DEV__`).

### Driver

The **driver** is whatever holds the other end of that socket and tells the agent what to do. The `lynkeus` CLI is a driver. So is `lynkeus mcp`, which serves the same commands to an AI agent, and so is a Node script of your own built on `lynkeus-client`.

A driver listens on a port (8123 unless you change it) and waits for the app to dial in. Only one driver can hold a port at a time.

The agent and the driver share a **token**: a secret the app is given when it is bundled and the driver presents. The CLI reads it from `LYNKEUS_TOKEN`. An agent with a token ignores a driver that does not present the same one. An app that passes a token whose value turns out to be empty keeps its agent off and says so in its log; it does not serve without one.

### Host

The **host** is where the app runs during a test. There are two kinds, and they differ in what is real.

On a **device** (an iOS simulator, an Android emulator) the native layer is real: gestures, the keyboard, the camera, push delivery, WebViews, native crashes and pixels. In this documentation "device" always means a simulator or an emulator. Physical phones are not supported.

On the **headless host** the app runs in Node, with no simulator. `lynkeus headless start` renders the app under Jest and React Native Testing Library, with the native modules mocked, and the agent inside dials out exactly as it does on a device. It starts in about 40 seconds with no build, and several can run at once, which is what makes it suited to CI. What the operating system would hand the app (a deep link, the clock, a biometric prompt, a network failure) becomes a command instead.

Both speak the same protocol, so every command and every case works on either. Where a case needs a step on only one kind of host, it says so with `on: device` or `on: headless`. See [Headless](/platforms/headless/) for what the headless host cannot tell you.

:::note
The source documentation and the CLI's messages often say "host" for the headless host alone, and "device" for a simulator or emulator. When a message says `cannot run on this host`, it means wherever the app is running at that moment.
:::

## What the app shows

### Screen

The **screen** is the app as React rendered it, read at one moment. `lynkeus screen` prints it:

```text
Settings.Main (Tabs > Settings.Main) +overlay#account-sheet · 12 hidden: 12 behind-overlay
4 button #close-sheet "Close"
5 button #delete-account-button "Delete account" !disabled
6 text "Are you sure?"
7 button #slide-to-confirm ~inert
```

The first line is the header: the route, the path of navigators that leads to it, the layer on top if there is one (here a sheet), and a count of what is mounted but not presented. The lines after it are the elements.

An app keeps far more mounted than it shows: the other tabs, the screen under a sheet. The screen lists only what the platform is presenting, because only that can be seen or touched. `lynkeus screen --all` lists the rest.

`lynkeus screen --tree` prints the same screen as nested lines with no positions. That form is meant for comparing a screen against an earlier version of itself.

### Element

An **element** is one thing on the screen that a user could see or touch. Each has:

- A **kind**: `button`, `input`, `text`, `scroll`, `switch`, `image` or `view`.
- What identifies it: a `testID` (printed as `#name`), a text or accessibility label, and an index in the listing.
- What it carries: an input's **value** (what its native field holds, masked for password fields), its placeholder, whether it has focus.
- Its **state**, which says whether a touch would work.

Three states matter:

| State | In the listing | Meaning |
|---|---|---|
| disabled | `!disabled` | The control will not answer a touch. |
| covered | `~covered` | A touch at its center would land on something else, as the platform's own hit test reports. |
| hidden | counted in the header | The app is not presenting it at all: it belongs to another tab, or to the screen a sheet is covering. |

A fourth marker, `~inert`, is for an element that can be read but not touched.

### Target

A **target** is how a command or a step points at an element. There are five spellings:

| Spelling | Matches |
|---|---|
| `#next-button` | The element with that `testID`. |
| a text, such as `Continue` | A control (a button or an input) by its exact label, then by part of it. A paragraph only by its exact text. |
| `12` | The element at that index in the last screen listing. |
| `100,200` | A point, in window points. |
| `"Continue"`, in quotes of its own | That text and nothing else. Quoted, a word is never read as a route, an index or a `testID`. |

The quoted spelling exists because the others overlap. `12` is an index, so a label that reads 12 is written `"12"`. To `wait` and `see`, a capitalized word such as `Next` is a route, so a button labeled Next is written `"Next"`: `lynkeus wait '"Next"'` in a shell, where the outer quotes belong to the shell, and `app.wait: '"Next"'` in a case.

Two rules decide ties. A covered element is matched only when nothing reachable matches. When two elements match equally, the later one wins, because it is drawn on top.

A target can be narrowed. `--in` picks the match nearest another target, for rows that repeat a control: `lynkeus press '#like-button' --in 'hi from Ana'` presses the like button that belongs to that message. `--nth` picks a match by position, counting from 0.

Prefer `testID`s. A text target breaks when the copy changes or the app runs in another language.

### Route

A **route** is a screen's name, as your navigation library reports it: `Settings.Main`, `Checkout.Confirm`, or `index` in an expo-router app. The **path** is the chain of navigators from the root down to the focused screen.

Routes come from a navigation adapter. One for React Navigation ships with the agent, and `auto()` finds the navigation container by itself. Without an adapter lynkeus still sees elements, but no routes, so a wait for `Settings.Main` has nothing to wait for.

Routes are how a test says where it is. `lynkeus wait Settings.Main` blocks until that screen is focused. `lynkeus nav Settings.Main` jumps there directly, which is a teleport and not something a user does: use it to reach the place where a test starts, not to test navigation.

A sheet or a dialog presented over a screen is not a route of its own. It is a state of the route under it, and the screen header names it as a layer.

## What a test is made of

### Case

A **case** is one test, written as a markdown file that a person can read. It has frontmatter that names it (`id`, `title`) and a body in YAML with up to three parts:

```yaml title="cases/settings-dark-mode.md"
---
id: settings-dark-mode
title: "Settings: switching to dark mode"
---
setup:
  - app.nav: Settings.Main

steps:
  - app.press: "Dark"
  - app.see: { testId: theme-dark-selected }

expected: |
  The dark theme is selected.
```

`setup` is what has to exist before the test starts. `steps` is what the person does and what must be true after. `expected` says in words what the case proves.

The documentation says "test" when speaking generally and "case" for the file and the `lynkeus case` commands. One case runs unchanged on a device and on the headless host.

### Step

A **step** is one line of a case: a verb and its value. There are three families.

- **App steps** start with `app.` and drive the app: `app.press`, `app.type`, `app.swipe`, `app.wait`, `app.see`, `app.nav`, `app.back`, and others. They are the terminal commands with `app.` in front, plus waiting: `app.press` waits for its control to be there and enabled.
- **Fixture steps** are any other name: `create_user`, `give_points`. They go to your backend tooling (see below).
- **Built-in backend steps**: `assert` reads the backend and checks one value of the answer, and `exec` runs a shell command.

A step that fails stops the case. A step the current host has no way to perform, such as a mocked network response on a simulator or an emulator, is reported as **unsupported** rather than failed: the case stops there and does not fail the run.

### Fixtures

**Fixtures** are the backend data a case needs before it can run: a user that exists, a balance, a feature flag. lynkeus does not know your backend, so it does not create that data. It asks a program of yours to.

You declare a fixtures command in `lynkeus.config.json`. lynkeus starts it once per run and exchanges one line of JSON per step with it: the step's name and parameters go in, the result comes back.

```text
→ {"command": "create_user", "params": {"name": "Ana"}, "env": {"NAME": "Ana"}}
← {"ok": true, "user_id": "u_1", "name": "Ana"}
```

The command can be anything that reads a line and writes a line: a Node script, a Rails runner, a container. A step can keep the answer under a name with `as: u`, and later steps read it as `{{u.user_id}}`. See [Fixtures](/guides/fixtures/).

### Run

A **run** is one execution of `lynkeus case run`: a set of cases, on one host, at one time. Each case in a run has one or two **attempts**, because a failed case runs once more before it counts as failed. A case that passes on the second attempt is reported as passed on retry.

Each case ends with one of three results: passed, failed, or unsupported on this host. Only a failed case fails the run.

With `--out <dir>`, the run is written as a directory that any program can read: `run.json` (when it started and ended, what the app ran on, the totals) and `cases.jsonl` (one line per attempt, with every step, its duration, its error and its evidence). `--screenshots` adds a screenshot after every app step to that directory. `--video` adds a video of each case where the host offers a `record` command; the headless host and a simulator or emulator session offer none.

### Report

A **report** is a run presented for people: each case step by step, the video in step with the steps, the analytics events each step sent, and why a failed case failed.

`lynkeus case run --out <dir> --push` uploads the run directory to the hosted reports service at [lynkeus.io](https://lynkeus.io) and prints the report's address. The service is paid, with a free plan, and it is optional: the run directory holds the same information and belongs to you. See [Reports](/guides/reports/).

## Two more words you will meet

**Flow.** A JSON file of steps that `lynkeus run` replays and `lynkeus record` writes from what a person does in the app. Flows came before cases; a case can run one with `app.run`.

**`.lynkeus/`.** The folder in your app where lynkeus keeps what it produces: runs, recorded screens, snapshots, the map of your app's routes. All of it can be deleted and regenerated.

## Next steps

- [Driving the app](/guides/driving-the-app/): the commands behind every app step.
- [Writing cases](/guides/writing-cases/): the case format in practice.
- [Case format reference](/reference/case-format/): every step and its parameters.
- [Configuration](/reference/configuration/): every key of `lynkeus.config.json`.

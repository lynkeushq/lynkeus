---
title: FAQ
description: Short answers to the questions people ask first about lynkeus, with links to the page that covers each in full.
---

Short answers to what people ask before adopting lynkeus and in their first days with it. Each one links to the page that covers the subject in full.

## Deciding whether to use it

### What is lynkeus, in one paragraph?

A tool that runs automated end-to-end tests on React Native apps. A small agent is mounted inside a debug build of your app; a command-line program drives it. Tests are readable files of steps, and every run can be kept as a report with each step, its screenshot and, when it fails, the reason. See the [introduction](/).

### How does it compare to Detox, Maestro or Appium?

It covers the same ground: driving a real build end to end. The difference is where it stands. Those tools drive the app from outside, through the operating system. lynkeus runs inside the app and reads the tree React rendered.

That has a benefit and a cost. The benefit is speed and precision: a step takes milliseconds, a wait ends on the render that satisfies it, and a test can assert on facts a screenshot cannot show, such as the current route, an input's value, or a network request. The cost is that lynkeus needs a debug build with the agent in it, and it does not see what React Native does not draw, such as system dialogs.

### Does anything ship in my release build?

No. The agent's native module compiles to no-ops outside debug builds, and the agent's JavaScript is never evaluated when `enabled` is false, which is the default whenever `__DEV__` is false. On iOS the touch-synthesis code is inside `#if DEBUG`, so its symbols do not exist in a release binary. On Android the module refuses to run unless the app is debuggable. See [Security](/security/).

### Can it test a release build, or the app from the store?

No. The agent runs only in debug builds, by design. lynkeus tests your app's behavior in a development build; it is not a tool for testing a signed binary.

### Which versions of React Native does it support?

React Native 0.76 or newer, with the New Architecture. On iOS the New Architecture is required: the agent measures elements through Fabric and its native module is a Turbo Module.

### Does it work with Expo?

Yes, in a development build. It does not work in Expo Go, because the agent has native code. No config plugin is needed. There are three Expo-specific points: an entry file that mounts the agent before expo-router loads, the token under the name `EXPO_PUBLIC_LYNKEUS_TOKEN`, and native tab bars, which cannot be pressed by name. See [Install in an Expo app](/getting-started/installation-expo/) and [Expo](/platforms/expo/).

### Is it free?

The tool is open source under the MIT license: the agent, the CLI, the headless host and the protocol. Running tests and keeping their results as files on your own machine or CI costs nothing.

The hosted reports service at [lynkeus.io](https://lynkeus.io) is a separate, paid product with a free plan. The Free plan keeps screenshots for 7 days and covers one project. The Team plan also keeps video, for 90 days, across any number of projects. Using it is optional. See [Reports](/guides/reports/).

### Does it know anything about my app?

No, and that is deliberate. lynkeus has no list of your screens and no notion of a user or a session. Everything it reports was read from the running app or from your source. Where a test needs product knowledge (which user exists, how to log in, which controls are irreversible), you supply it in `lynkeus.config.json` and in your own fixtures. See [Configuration](/reference/configuration/).

## Setting up

### Do I need a simulator?

Not necessarily. The **headless host** runs the app in Node under Jest, with no simulator and no native build, and the same tests run on it. It is the usual choice for CI. The native layer is mocked there, so things like the real camera, WebView contents, push delivery and pixels need a simulator or emulator.  See [Headless](/platforms/headless/).

### Do I need a Mac?

For the iOS simulator, yes, because it needs Xcode. The CLI and the headless host need only Node 22 or newer.

### Which navigation libraries does it understand?

An adapter for React Navigation ships with the agent, and `auto()` finds the navigation container without being handed a ref. expo-router's routes are recognized. For another router, you write a small adapter and pass it to the `<Lynkeus>` component. Without any adapter lynkeus still reads the screen, presses and types; it only lacks route names. See the [agent API](/reference/agent-api/).

### Do I have to add `testID`s everywhere?

No. An element can be targeted by its `testID`, by its text, by its index in the screen listing, or by a point. `testID`s are recommended because they survive a change of copy or language, and `lynkeus screen` shows which elements already have one. See [Driving the app](/guides/driving-the-app/).

### What is the token for?

It keeps other processes on your machine from driving the app. The app is built with a value and the driver must present the same one before the agent serves it. The CLI reads it from `LYNKEUS_TOKEN`. If the app has no token at all, the agent serves any driver, so check that the value reaches your bundle. The headless host refuses to start without one.

### Why does the CLI say "No app attached"?

The CLI listened and no app dialed in with the right token within 15 seconds. The usual causes, in order: the app is not a debug build or is not running; `enabled` is false for this environment; the token in the app and `LYNKEUS_TOKEN` differ; the app and the CLI are on different ports. See [Troubleshooting](/troubleshooting/).

### Can I drive several apps at once on one machine?

Yes. An app and its driver are a pair on one port, 8123 by default. Give each pair its own port: the `port` option in the app, and `LYNKEUS_PORT` for the CLI and the headless host.

## Writing and running tests

### What does a test look like?

A markdown file with a short YAML body: `setup` for what must exist, `steps` for what the person does and what must be true, and `expected` for what it proves in words.

```yaml
---
id: settings-dark-mode
title: "Settings: switching to dark mode"
---
steps:
  - app.press: "#settings-button"
  - app.wait: Settings.Main
  - app.press: "Dark"
  - app.see: { testId: theme-dark-selected }
```

See [Your first test](/getting-started/first-test/) and [Writing cases](/guides/writing-cases/).

### Do I have to write sleeps or retries into my tests?

No. A press waits for its control to be there and enabled. An assertion gives a missing element time to arrive and scrolls to find it. A wait returns the moment the route or element appears. On a device, the runner also waits out what only a device does, such as a screen still sliding in.

### How do tests get their data: users, balances, flags?

Through **fixtures**. Any step in a case that is not an `app.` step is sent to a program you declare, as one line of JSON, and the answer comes back as one line. That program can be a Node script, a Rails runner or a container; it creates the user or sets the flag in your backend. lynkeus never fabricates state itself. See [Fixtures](/guides/fixtures/).

### Can the same test run on iOS, Android and headless?

Yes. That is the normal case. Where one step applies to only one of them, wrap it in `on: ios`, `on: android`, `on: device` or `on: headless`. A step the current host cannot perform, such as a mocked network response on a real device, is reported as unsupported there and does not fail the run.

### What happens when a test fails?

The case stops at the failed step and prints the evidence: the screen as it was, the requests the app had made, and why the target could not be used (covered, hidden behind a layer, disabled, or not there, with the nearest match). The case then runs once more; if it passes the second time it is reported as passed on retry. `lynkeus why` asks for the same diagnosis at any moment.

### How do I tell a flaky test from a broken one?

Every run records how each case did in a ledger (`.lynkeus/flakes.json` by default). When some of a case's recent runs failed or needed the second attempt, and others did not, the run's summary says the case is flaky and gives the count. `lynkeus flake <flow> --times 10` repeats one flow and reports how often it passed and at which step it died. With hosted reports on the Team plan, `lynkeus report flakes` ranks cases by how often they pass at the first try across recent runs; a case that failed its last three runs is treated as broken, not flaky. See [Flaky tests](/guides/flaky-tests/).

### Can I test error states, such as a 500 from the backend?

On the headless host, yes, in one line: `lynkeus mock 'GET /v3/accounts' --status 500` answers the request before it reaches the network. The same host can move the clock, send the app to the background and turn the network off. On a device those are the real thing and are not mocked. See [Headless](/platforms/headless/).

### Does it run on CI?

Yes. `lynkeus case run` exits with code 0 when no case failed and 1 otherwise. The headless host needs only Node, so a job needs no device farm; simulators and emulators work too where the runner provides them. `--report <file>` appends one JSON line per case, and `--out <dir>` writes the whole run as a directory. See [Running on CI](/guides/ci/).

### Can an AI agent drive the app?

Yes. `lynkeus mcp` serves the commands as MCP tools over stdio. The model receives the screen as structured elements instead of pixels, so it decides the next step from facts. See [AI agents](/guides/ai-agents/).

### Can it check accessibility?

Partly. `lynkeus lint` reads the current screen and flags controls with no label, touch targets under 44 points, text that is an untranslated key, interactive elements a touch cannot reach, and duplicate `testID`s. On a host that can take a screenshot, it also measures text contrast. See [Lint and contrast](/guides/lint-and-contrast/).

## Security and privacy

### What does the agent expose?

To a driver that presents the token: the screen as React rendered it, the ability to press and type, the app's recent requests, and whatever commands your app registered. The app dials out to the loopback address (or the emulator's alias for it); nothing listens inside the app and nothing in it is reachable from the network.

### Does it record sensitive data?

Values of password fields (`secureTextEntry`) are masked in the screen. The request log keeps the method, path, status and duration of each request; it never keeps headers or bodies, and sensitive query values are redacted.

### Should the agent run against production?

No. Gate `enabled` on your environment as well as on `__DEV__`. A debug build that talks to a real backend with real accounts should not run the agent. The headless host goes further and refuses any backend that is not on a local address. See [Security](/security/).

## The project

### Can I contribute or open an issue?

The repository is published for anyone to use, but it does not take contributions: issues are disabled and pull requests are closed automatically. You are welcome to fork it under the terms of the license.

### Where is the complete list of commands?

In the [CLI reference](/reference/cli/). In a terminal, `npx lynkeus help` lists the commands and `npx lynkeus help <command>` prints one.

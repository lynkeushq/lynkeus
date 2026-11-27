---
name: lynkeus
description: Lynkeus end-to-end testing for React Native apps (bare or Expo). Use when writing, running or fixing Lynkeus cases (markdown e2e tests in the cases folder), choosing where they run (Simulator or emulator, Lynkeus FastSim, the headless Node host), keeping evidence and reports, running cases in CI, making runs repeatable, or calling lynkeus commands or MCP tools, or editing lynkeus.config.json.
---

# Lynkeus

Lynkeus drives a React Native app by what is on its screen, through `lynkeus-agent` inside the app, and runs cases: markdown files of readable steps. Every command works in a terminal (`npx lynkeus <command>`, `--help` on each) and as a tool of `lynkeus mcp`: spaces become underscores and flags become arguments, so `case run --on targets` is `case_run` with `on: "targets"`.

## The cheap path

Spend in this order and stop as soon as you know enough:

1. `status` in a project you do not know: what is set up, where cases can run, the one fix for each gap. `setup` connects the app in one call: `init`, the device, Metro, the development build (never Expo Go), launch and attach.
2. `case coverage`: the app's screens and which no case reaches yet.
3. `case new <id> --to <Route>`: a draft with the way there (an existing case's steps when one reaches it), the backend setup to pick from and the checks left to write. Keep the way it offers. On the screen already, `case here` drafts from what is shown.
4. No known way to the screen: `crawl` from the nearest screen. The route map rebuilds itself when the source changes, and every press a case or you make teaches it.
5. Only then drive the app (`press`, `type`, `wait`, `screen`) to fill what the draft could not know. Read the app's source only for what the screen cannot tell (validation rules, the shape of a response to mock).
6. Write the case in the cases folder, `case run <file>` until it passes, then `case run <file> --on targets`: a case is done when it passes on the project's targets (`cases.targets`), and nowhere else needs checking. No targets declared: ask the person which matter (`status` proposes a value).

A failed step answers with its error and the screen it failed on (`--verbose` for all of it); `why` explains the last failure. Fix the case or report the app's bug; never weaken the check.

## Sections

Read a section when the task reaches it, not up front: each answers one question in a few lines.

- cases: [format](cases/format.md), [targets](cases/targets.md) (testIDs, text matching), [steps](cases/steps.md), [commands](cases/commands.md) (`qa.register`, `app.call`), [relaunch](cases/relaunch.md), [on-blocks](cases/on-blocks.md), [macros](cases/macros.md), [interruptions](cases/interruptions.md), [mocks](cases/mocks.md)
- targets: [overview](targets/overview.md) (which target for a case), [project-targets](targets/project-targets.md) (`cases.targets`, `--on targets`), [on-all](targets/on-all.md), [headless](targets/headless.md), [device](targets/device.md), [fastsim](targets/fastsim.md), [one-run](targets/one-run.md) (`case status`, `case stop`)
- evidence: [keep](evidence/keep.md) (`--out`, frames, film, traces), [share](evidence/share.md), [failure](evidence/failure.md), [slow-step](evidence/slow-step.md)
- ci: [impact](ci/impact.md), [ci-job](ci/ci-job.md), [map-check](ci/map-check.md)
- determinism: [launch-facts](determinism/launch-facts.md) (seed, locale, zone, epoch), [randomness](determinism/randomness.md), [frames](determinism/frames.md)
- troubleshooting: [press](troubleshooting/press.md), [system-view](troubleshooting/system-view.md), [background](troubleshooting/background.md), [text-match](troubleshooting/text-match.md), [port](troubleshooting/port.md), [native-values](troubleshooting/native-values.md), [headless-start](troubleshooting/headless-start.md), [shared-state](troubleshooting/shared-state.md)

## One-call jobs

Prefer them to driving builds, Metro and devices through the shell: `setup` connects an app, `case run --on targets --brief` runs a suite on the project's targets, `evidence` runs it with frames, film and report.html. Each answers a few lines and keeps its logs in files: open one only when the answer points at it. If your client can run a task in a separate context (a subagent, a background task), give it these jobs and keep only their summaries. They are routine and run well on a smaller model or at lower effort; writing and debugging cases gains from a stronger one. Clients with subagents also get `lynkeus-setup` and `lynkeus-runner`, from the next session on. A suggestion: you and the person decide.

## Rules

- Lynkeus boots only a device the project names (`setup` says when it does) and never closes one. Shut down the Simulators and emulators you or `setup` booted when you are done (`xcrun simctl shutdown <udid>`, `adb -s <serial> emu kill`), never one that was already running.
- On FastSim and headless, a run lists the native modules and values the app read that nobody provides (answered empty, or guessed). Tell the person; when the guess changes what the app shows, giving it a real answer in `cases.nativeMocks` is their decision.

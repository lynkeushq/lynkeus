---
name: lynkeus
description: Lynkeus end-to-end testing for React Native apps (bare or Expo). Use when writing, running or fixing Lynkeus cases (markdown e2e tests in the cases folder), choosing where they run (Simulator or emulator, Lynkeus FastSim, the headless Node host), keeping evidence and reports, running cases in CI, making runs repeatable, or calling lynkeus commands or MCP tools, or editing lynkeus.config.json.
---

# Lynkeus

Lynkeus drives a React Native app by what is on its screen, through `lynkeus-agent` inside the app, and runs cases: markdown files of readable steps. Every command works in a terminal (`npx lynkeus <command>`, `--help` on each) and as a tool of `lynkeus mcp`: spaces become underscores and flags become arguments, so `case run --on targets` is `case_run` with `on: "targets"`.

## The cheap path

Spend in this order and stop as soon as you know enough:

1. `status` in a project you do not know: what is set up, where cases can run, the one fix for each gap. `init` sets Lynkeus up; the app is then built again (a development build, never Expo Go) and Metro restarted with `--reset-cache`.
2. `case coverage`: the app's screens and which no case reaches yet.
3. `case new <id> --to <Route>`: a draft with the way there (an existing case's steps when one reaches it), the backend setup to pick from and the checks left to write. Keep the way it offers. On the screen already, `case here` drafts from what is shown.
4. No known way to the screen: `crawl` from the nearest screen. The route map rebuilds itself when the source changes, and every press a case or you make teaches it.
5. Only then drive the app (`press`, `type`, `wait`, `screen`) to fill what the draft could not know. Read the app's source only for what the screen cannot tell (validation rules, the shape of a response to mock).
6. Write the case in the cases folder, `case run <file>` until it passes, then `case run <file> --on targets`: a case is done when it passes on the project's targets (`cases.targets`), and nowhere else needs checking. No targets declared: ask the person which matter (`status` proposes a value).

A failed step answers with its error and the screen it failed on (`--verbose` for all of it); `why` explains the last failure. Fix the case or report the app's bug; never weaken the check.

## Topics

Read the one the task needs:

- [cases.md](cases.md): the format, targets and text matching, app commands, macros, `on:` blocks, interruptions, mocks, `app.relaunch`, teardown.
- [targets.md](targets.md): Simulator or emulator, FastSim, headless; `cases.targets` and `--on targets`; hosts, `--host-command` and `--jobs`.
- [evidence.md](evidence.md): frames, film, `report.html`, sharing a run, backend traces.
- [ci.md](ci.md): `case impact`, `lynkeus ci --affected`, `map ci`.
- [determinism.md](determinism.md): seed, locale, time zone and epoch; frames two runs can be compared by.
- [troubleshooting.md](troubleshooting.md): a press that does nothing, system prompts, a held port, the app gone to another app, headless native values.

## Rules

- Lynkeus never boots or closes a device. Shut down the Simulators and emulators you booted when you are done (`xcrun simctl shutdown <udid>`, `adb -s <serial> emu kill`), never one that was already running.
- On FastSim and headless, a run lists the native modules and values the app read that nobody provides (answered empty, or guessed). Tell the person; when the guess changes what the app shows, giving it a real answer in `cases.nativeMocks` is their decision.

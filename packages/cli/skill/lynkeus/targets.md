# Where cases run

| Target | What it is | Needs |
|---|---|---|
| Simulator or emulator | a development build attached on the driver port (8123 unless `LYNKEUS_PORT`) | `init`, a build, Metro |
| Headless | the app in Node under jest, native side mocked; no device, seconds per case | `lynkeus headless init`, a local backend (`apiUrl` in `lynkeus.config.json`) |
| Lynkeus FastSim | a simulator that runs a bundle of the app on a Mac or Linux without Xcode or an emulator; pixel-stable | the organization's Team plan, `fastsim install` |

`status` lists which of these this machine has and the one fix for each that is missing. Write a case where it is cheapest and most reliable (FastSim when the organization has it, else headless), and on a Simulator or emulator when it needs something only a device has: real native views, system prompts, pixels, a camera.

## Every target at once

```sh
npx lynkeus case run cases/sign-out.md --on all      # or --on simulator,headless
```

One line per case per target. A target this machine lacks is named with why and fails nothing. `--on` starts its own hosts, so it refuses `--host`, `--host-command`, `--keep-hosts` and `--ports`; `--jobs` gives each target that many.

## Headless

`headless init` installs jest, Testing Library and `lynkeus-headless` and writes the entry (an Expo Router app too); `headless doctor` lists native modules still to mock. Then:

- `case run --host`: starts a host for the run and stops it after; with `--jobs N`, one host per job.
- `case run --jobs 4 --host-command 'LYNKEUS_PORT={port} npx lynkeus headless start'`: a fresh host for every case (`{port}` is where it dials, `{job}` the job). Add `--keep-hosts` to start each job's host once (faster; it is reset before each case, but state the app keeps at module scope survives: drop `--keep-hosts` if cases see each other).
- A host that dies or passes `--host-heap` percent of its heap is started again before the next case.

What headless cannot tell you: real native views and gestures, a WebView's content, native crashes, pixels. Run those cases on a device.

## Simulator or emulator

The app attached on the port is the target. `os language <tag>` relaunches it in a language. On Android, `status` runs `adb reverse` for the port. Lynkeus never boots or closes a device: shut down what you booted, never what was already running.

## FastSim

Optional and paid (Team plan, https://lynkeus.io/pricing); use it when the person asks or the organization has it. `fastsim install --platform ios|android` needs the sign-in a member saved with `lynkeus login` in a terminal (you cannot do it for them: ask) or, in CI, `LYNKEUS_CLOUD_KEY`. Then read the README in the folder it answers:

- `bin/fastsim-bundle` makes a release bundle (`__DEV__` false, so `qa.register` must not sit inside `if (__DEV__)`).
- `case run --host-command '<kit>/bin/fastsim-run <bundle folder> {port}'` runs each case on its own FastSim host; `case run --on fastsim` finds the kit and the last bundle itself. A bundle older than the app's code is bundled again first (with this environment: `EXPO_PUBLIC_` variables must be set), or the run is refused with the command to run: never report on old code.
- `fastsim start <bundle folder>` attaches a host to look around before writing a case; `fastsim stop` ends it.
- iOS matches the simulator only on a Mac.

When the service refuses (no FastSim in the plan, no seat, a key without "May download Lynkeus FastSim"), tell the person what it said and carry on with headless or a device; never retry with other credentials.

## One run at a time

One `case run` drives an app per port; a second on the same port is refused until the first ends or `case stop` stops it. `case status` says where a run is (cases done, what each job runs, the time left), from any terminal or as an MCP tool. Over MCP, a client that passes a progress token hears the same as progress notifications; a `case_run` moved to the background is followed with `case_status` and stopped with `case_stop` (cancelling the call stops it too).

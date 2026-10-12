---
title: Recording and snapshots
description: Record a flow from what a person does in the app, keep a screen as a baseline with snapshot, and track how screens change with screen --record.
---

Three commands capture what the app is doing so you can keep it: `record` turns a session in the app into a file of steps, `snapshot` keeps one screen as a baseline to compare against later, and `screen --record` keeps the structure of every screen a suite visits.

They answer different questions. `record`: what did I do a moment ago, written down? `snapshot`: is this screen still the same? `screen --record`: what changed anywhere, since the last run?

## Before you start

- The app is running with the agent. See [Driving the app](/guides/driving-the-app/).
- For `record`: a build on a simulator, an emulator or a device, with the agent mounted through `auto()`. Touches are traced only there.
- For `snapshot --pixels`: a simulator or an emulator.

## Record a flow

Writing a test by reading testIDs off the screen is slow. `record` watches the app while a person uses it and writes the steps for you.

### Step 1: Start recording

```bash
npx lynkeus record --out flows/login.json
```

You should see:

```text
recording; use the app, then Ctrl-C to write flows/login.json
```

### Step 2: Use the app

Go through the flow by hand, at the pace of a user. Each thing the agent traces is printed as it happens:

```text
  touch  #phone-input  on Login.Phone
  touch  #next-button  on Login.Phone
  req    200 POST /v1/session 412ms
  route  Settings.Main
  store  session: token, user
```

A `touch` line is your finger, resolved to the element under it. The lines after it are what that touch caused: the route it led to, the requests it fired, the stores it changed. A `store` line appears for stores the app exposed with `qa.observe`.

### Step 3: Stop and read the flow

Press Ctrl-C. You should see `5 steps → flows/login.json`, and the file:

```json title="flows/login.json"
{
  "name": "login",
  "steps": [
    { "press": { "testId": "phone-input" } },
    { "press": { "testId": "next-button" } },
    { "waitFor": { "route": "Settings.Main", "timeoutMs": 10000 } },
    { "note": "requests: POST /v1/session 200" },
    { "note": "stores changed: session.token,user" }
  ]
}
```

This file is a **flow**: a JSON list of steps that `lynkeus run` replays. Each touch became a `press`. After each one comes what it caused: a `waitFor` on the route it led to, and notes with the requests and store changes. Those are the assertions a test needs, not only the steps.

A touch on an element with a testID is recorded by testID. Without one, it is recorded by its text. A touch on something lynkeus cannot name becomes a note with the coordinates, for you to resolve by hand.

:::note
A recording holds touches, not keystrokes. After recording, add `type` steps where you typed.
:::

### Step 4: Replay it

```bash
npx lynkeus run flows/login.json
```

You should see each step with its duration and the route it ended on, then `PASSED`. Add `--diff` to print what changed on screen after each step.

### Recording options

| Flag | What it does |
|---|---|
| `--out <flow.json>` | Where to write the flow. Without it, the flow goes under `.lynkeus/runs/record/`. |
| `--screenshots` | One screenshot per touch, taken once the screen settles. |
| `--so-far` | Do not wait: draft a flow from the trace as it stands, and stop. |

With `--screenshots`, the screenshots are listed in a strip file next to the flow (`flows/login.strip.md`), so a person can review what was recorded before keeping it.

`--so-far` is for when you already did the thing and want it written down. The agent has been tracing all along; this drafts a flow from what it holds.

Lines typed into the terminal while recording run as lynkeus commands, for example `press '#next-button'`. A script can drive part of a recording that way.

### From a flow to a case

A flow replays with `lynkeus run`. A case can call it as one step, from the folder named by `cases.flows` (`flows` by default):

```yaml
steps:
  - app.run: { flow: login.json, vars: { phone: "1124888418" } }
  - app.see: { route: Settings.Main }
```

Or use the recording as a draft and write the same steps in the case format. See [Writing cases](/guides/writing-cases/).

## Keep a screen as a baseline: snapshot

A **snapshot** is a named baseline of one screen. The first run writes it. Later runs compare the screen to it and fail when it differs.

### The tree

By default a snapshot keeps the screen's **tree**: the screen as nested lines of meaning, with kinds, labels, testIDs, values and states, and no geometry.

```bash
npx lynkeus nav Onboarding.Hero
npx lynkeus snapshot onboarding-hero
```

The first time, you should see:

```text
onboarding-hero: tree baseline written → .lynkeus/snapshots/onboarding-hero.tree.txt
```

Run the same command later. When nothing changed:

```text
onboarding-hero: tree matches the baseline (23 lines)
```

When something changed, the command prints the lines that are gone and the lines that are new, says where it kept the actual tree, and exits with code 1:

```text
onboarding-hero: the tree differs from the baseline (1 line(s) gone, 1 new):
  …
  actual: .lynkeus/runs/snapshots/…
  accept with --update if the change is intended
```

If the change was intended, accept it:

```bash
npx lynkeus snapshot onboarding-hero --update
```

Because the tree has no geometry, a renamed heading or a lost button is a changed line, and a font hint is nothing. Tree snapshots work on every host, the headless host included.

You can read a screen's tree at any time with `npx lynkeus screen --tree`.

### Pixels, deliberately few

`--pixels` also compares a screenshot.

```bash
npx lynkeus snapshot onboarding-hero --pixels
```

The first run writes `.lynkeus/snapshots/onboarding-hero.png`. A later run that matches says so with the count:

```text
onboarding-hero: matches the baseline (12 of 3110400 pixels differ, 0.000%)
```

One that differs writes a diff image and exits with code 1:

```text
onboarding-hero: differs from the baseline: 48210 of 3110400 pixels (1.55%)
  diff: .lynkeus/runs/snapshots/…/onboarding-hero.diff.png
  accept with --update if the change is intended
```

The diff image is the baseline faded to gray, with the differing pixels in red. The actual screenshot is kept next to it.

| Flag | Default | Meaning |
|---|---|---|
| `--tolerance <ratio>` | `0.001` | The fraction of pixels allowed to differ. |
| `--no-freeze` | off | Do not pin the status bar before the screenshot. |
| `--update` | off | Overwrite the baseline: the change is intended. |

Before the screenshot, the status bar is frozen (9:41, full battery) so the clock does not count as a difference.

Keep pixel snapshots for the screens where the visual is the product: an illustration, a chart, a map. Everything else is better served by the tree.

## Track every screen: `screen --record`

A snapshot watches the screens you named. To notice changes on screens no test asserts on, record the structure of every screen as it is read.

```bash
npx lynkeus screen --record
```

This keeps the screen's structure under `.lynkeus/screens/`, by route. When the same route is read again and its structure differs, the command says what changed since the last read.

To record during a whole run without changing any command, set the variable instead:

```bash
LYNKEUS_RECORD_SCREENS=1 npx lynkeus case run
```

Then list what changed:

```bash
npx lynkeus map changes
```

`map changes` lists the testIDs that appeared, disappeared or moved on a recorded screen since it was last read (the last 30 changes; `--last <n>` changes that).

The result is that a suite which never asserts on `#mute-toggle` still tells you the day it vanished.

### Recorded screens travel with the code

Everything under `.lynkeus/screens/` is text, so it can change the way code does: in a pull request.

- When a branch changes a screen, commit what the run recorded in the same pull request. The reviewer sees the new controls next to the code that added them.
- When a nightly run over the main branch finds the app changed on its own (a flag flipped, a backend answer changed), open that as its own pull request, with the output of `npx lynkeus map changes` as its description.

## How it works

The agent keeps a **trace**: an ordered log of routes, requests, store changes, touches and commands. `record` polls the trace while you use the app and, on Ctrl-C, groups it: one press per touch, followed by what happened before the next touch.

`snapshot` waits for the app to go quiet, reads the screen, and compares it to the baseline file as text. With `--pixels` it also takes a screenshot through the simulator or emulator and compares it pixel by pixel.

`screen --record` stores each route's structure and appends every difference to a log of changes, which `map changes` reads.

## Common problems

**`(no touches were traced: touches are recorded on device builds mounted with auto(); a host records routes and requests only)`.** Either the app runs on the headless host, where there are no touches to trace, or the agent is mounted with the explicit `<Lynkeus>` component and not with `auto()`. The recording then holds routes and requests only.

**A recorded step is a note about coordinates.** The touch landed on an element with no testID and no text. Add a `testID` to that control and record again, or write the press by hand.

**`size changed 1170×2532 → 1290×2796 (a different device or orientation?)`.** A pixel baseline belongs to one device size. Compare on the same simulator model, or keep one baseline per device under different names.

**A pixel snapshot fails with nothing visibly different.** Open the diff image: the differing pixels are red. If the difference is one you accept, raise `--tolerance`. If the screen is not one where the visual is the product, use the tree alone.

**A tree snapshot fails on every run.** The screen shows a value that changes, such as a time or a balance. The tree includes values, so snapshot a screen whose data is fixed by the test's setup.

**`(no recorded screen changes; record with lynkeus screen --record or LYNKEUS_RECORD_SCREENS=1)`.** Nothing has been recorded yet, or nothing changed between reads.

## Next steps

- [Writing cases](/guides/writing-cases/): turn a recording into a case.
- [Flaky tests](/guides/flaky-tests/): replay a recorded flow many times with `flake`.
- [Lint and contrast](/guides/lint-and-contrast/): the other per-screen check.
- [CLI reference](/reference/cli/): every flag of `record`, `snapshot` and `screen`.

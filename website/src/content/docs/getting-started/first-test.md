---
title: Your first test
description: Drive the app by hand from the terminal, write a first case file, run it, and read what the run prints.
---

This page goes from an app with the agent installed to a passing test. It has two halves, in the order you will work in practice. First you drive the app by hand, one command at a time, to learn what is on each screen and how to point at it. Then you write those same actions into a file, called a **case**, and run it.

Driving by hand first is not a detour. A case is made of the same commands, so anything you can do in the terminal you can write as a step, and you find the right `testID`s and route names by looking instead of guessing.

## Before you start

- The agent is installed and `npx lynkeus screen` prints your app's screen. If not, follow [Install in a React Native app](/getting-started/installation-react-native/) or [Install in an Expo app](/getting-started/installation-expo/).
- The app is running on a simulator or emulator.
- `LYNKEUS_TOKEN` is exported in your shell, with the value the app was built with.

The examples use a small app with two screens. `Home` has a title, a text input and a button; the button opens `Details`. Substitute your own `testID`s and routes as you go.

## Part 1: Drive the app by hand

Run every command from the app's folder.

### 1. Read the screen

```bash
npx lynkeus screen
```

You should see a listing like this one:

```text
Home
text #title "Hello, agent"
input #name-input value="" placeholder="Your name"
button #next-button "Next"
```

The first line is the **route**: the name of the current screen, as your navigation library reports it. When the screen sits inside nested navigators, the chain follows in parentheses, for example `Settings.Main (Tabs > Settings.Main)`.

Each following line is one **element**: something a user could see or touch. From left to right it gives the kind (`text`, `input`, `button`, and also `switch`, `scroll`, `image`, `view`), the `testID` after a `#`, the label in quotes, and then a value or state. Three states matter:

| Marker | Meaning |
|---|---|
| `!disabled` | The control will not answer a touch. |
| `~covered` | Something is drawn on top of it; a touch at its center would land on something else. |
| `~inert` | It can be read but not touched. |

An element that has neither a `testID` nor a label of its own, or shares its name with another element, gets a number in front of it. That number is its index, and you can point at the element with it.

### 2. Point at an element

Every command that touches or looks for an element takes a **target**. There are four ways to write one:

| You write | It matches |
|---|---|
| `'#next-button'` | The element with that `testID`. |
| `'Next'` | A button or input by its exact label, then by part of it. A paragraph of text matches only by its exact, full text. |
| `12` | The element with that index in the last screen listing. |
| `100,200` | A point on the screen, in points. |

Prefer the `testID`. It does not change when the copy changes or the app is translated. Quote targets in the shell: `#` starts a comment in most shells when it is unquoted.

### 3. Type and press

```bash
npx lynkeus type 'Ana' '#name-input'
```

`type` taps the input first, so it is focused the way a person focuses it, and then sends the text key by key. The command prints what it typed and the element it typed into, as JSON.

Read the screen again and you should see the value:

```text
input #name-input value="Ana" placeholder="Your name" *focused
```

Now press the button. With `--settle`, the command waits for the app to stop rendering and prints the screen that results:

```bash
npx lynkeus press '#next-button' --settle
```

You should see the next screen:

```text
Details
text #details "Details"
```

Without `--settle`, `press` prints the point it touched and the element it found, as JSON, and returns immediately.

### 4. Wait and assert

A test needs two more things: a way to wait until the app has arrived somewhere, and a way to state what must be true.

`wait` blocks until a route or an element appears, and fails if it has not after 10 seconds (`--timeout <ms>` changes that):

```bash
npx lynkeus wait Details
```

```text
{"route":"Details","waitedMs":3}
```

`see` asserts that a route or element is on screen now. It exits with code 1 if it is not, which is what makes it usable in a script:

```bash
npx lynkeus see '#details'
```

```text
on screen: #details
```

`see --absent` asserts the opposite, and `see --within <ms>` allows the element some time to appear.

:::note
`wait` and `see` accept either a route or a target in the same position. They read the argument as a route when it starts with a capital letter and contains only letters, digits, underscores and dots (`Details`, `Settings.Main`). So `npx lynkeus wait Next` waits for a *route* called `Next`, not for a button labeled "Next". To wait for an element, use its `testID`.

A lowercase word alone is read as a text. A router that names routes in lowercase, as expo-router does (`index`, `explore`), needs the `route:` prefix to say that a route is meant: `npx lynkeus wait route:index`, or `app.wait: "route:index"` in a case. The prefix is new and not yet released.
:::

### 5. Go back to where you started

```bash
npx lynkeus back
```

`back` pops the current route. `npx lynkeus nav Home` jumps straight to a route by name; it is a teleport, not something a user does, and it is the usual way to get a test to its starting screen.

### 6. See what a failure looks like

Ask for something that is not there:

```bash
npx lynkeus press '#nxt-button'
```

```text
✗ No element matches {"testId":"nxt-button"}
why:
  • …
```

After a failed `press`, `type`, `wait`, `swipe` or `nav`, lynkeus reads its own evidence (the screen, the latest requests, the trace of what happened) and prints what it found under `why:`. The usual answers are that the target is not on screen and which element is a near match, that it is there but covered or disabled, or that requests were still in flight. `npx lynkeus why '#next-button'` asks the same question at any moment.

## Part 2: Write a case and run it

### 1. Write the case file

A case is a markdown file with two parts: frontmatter that names it, and a body of steps in YAML. Create a `cases` folder in the app and add a file:

```yaml title="cases/home-to-details.md"
---
id: home-to-details
title: "Home: Next opens Details"
---
setup:
  - app.nav: Home

steps:
  - app.see: "#title"
  - app.type: { text: "Ana", target: "#name-input" }
  - app.press: "#next-button"
  - app.wait: Details
  - app.see: { testId: details }

expected: |
  Pressing Next on Home opens Details.
```

What each part does:

- **`id`** names the case in every output and report. If you leave it out, the file name is used.
- **`title`** is the sentence a person reads in the run's output.
- **`setup`** holds the steps that put the app, and usually the backend, in the state the case starts from. Here it is one step: `app.nav` teleports to `Home`, so the case starts on the same screen whether the app was launched a moment ago or a previous run left it on `Details`.
- **`steps`** is the test itself. Each step is one line: a verb and its value. `app.type`, `app.press`, `app.wait` and `app.see` are the commands from Part 1 with `app.` in front.
- **`expected`** states in words what the case proves. It is for the person reading the file and the report.

Three details about the syntax:

- The file must begin with `---`. A case without frontmatter is refused with `no frontmatter (a case starts with --- and its id)`.
- Quote targets that start with `#`. In YAML, an unquoted `#` starts a comment, and the step would lose its value.
- A value is either a bare target (`app.press: "#next-button"`) or a set of named parameters in braces (`app.see: { testId: details }`). The braces form is how you add options, such as `timeoutMs`.

Steps in a case wait on their own. `app.press` waits for the control to be there and enabled before it touches it. `app.see` gives a missing element a short wait, then scrolls down the page in case it is below the fold, then waits longer in case the content arrives late, as a carousel does. Only after that does its own deadline count (3 seconds unless you set `timeoutMs`). You do not write sleeps, and on a device you do not write a swipe before every element that is further down.

### 2. Run it

```bash
npx lynkeus case run cases/home-to-details.md
```

You should see one line per step as it runs, then a verdict for the case and a total for the run:

```text
▶ home-to-details — Home: Next opens Details
  ✅ app.nav Home  (352ms)
  ✅ app.see #title  (21ms)
  ✅ app.type text: Ana, target: #name-input  (164ms)
  ✅ app.press #next-button  (98ms)
  ✅ app.wait Details  (742ms)
  ✅ app.see testId: details  (18ms)
✅ PASSED  ✅ 6  — 1.4s
✅ home-to-details
1/1 passed
```

Your timings will differ. The command exits with code 0 when no case failed, and 1 otherwise, so a CI job can use it directly.

Without a file argument, `npx lynkeus case run` runs every `.md` file in the `cases` folder.

### 3. Make it fail, and read the failure

Change the last step to look for something that does not exist:

```yaml
  - app.see: { testId: detials }
```

Run it again. The failing step is marked, and the case prints its evidence:

```text
  ❌ app.see testId: detials  — not on screen: {"testId":"detials"}  (24630ms)
❌ FAILED  ✅ 5  ❌ 1  — 26.0s
— screen at the failure:
    Details
    text #details "Details"
  retrying home-to-details once
```

Four things happen that are worth knowing:

- **A failing `app.see` is slow on a device.** Before it gives up, the step tries the short wait, the scroll and the long wait described above, which together can take more than 20 seconds. A passing step pays none of that.
- **The case stops at the first failed step.** Later steps are reported as skipped. `--continue` keeps going after a failed step, which is useful when you want to see every assertion that breaks.
- **The evidence is printed with the failure.** The screen as it was, the requests the app had made, and, when the step was on a target, why: covered, hidden behind a layer, disabled, or gone. In this example the screen shows `#details`, which makes the typo plain.
- **A failed case runs once more before it counts as failed.** One that passes the second time is reported as `⚠ passed on retry`: it passed, but it is not reliable, and you should look at it. `--once` turns the second attempt off, which is what you want while you are writing a case.

Fix the typo and run it again before moving on.

### 4. Check the file without running it

```bash
npx lynkeus case run cases/home-to-details.md --dry-run
```

`--dry-run` parses the cases and lists any step it does not recognize, without performing the steps. It catches a misspelled verb before a long run does.

## How it works

`case run` is a driver, like the commands in Part 1. It listens for the app, reads the file, and sends each `app.*` step to the agent as the matching command, adding the waiting described above. Each step's outcome, its duration, and the evidence of a failure are collected into the run.

A step whose name does not start with `app.` is not sent to the app. It is a **fixture**: a request to your backend tooling to create or read data, such as a user with a given balance. The example case has none, so it needs no configuration. Real suites almost always do; [Fixtures](/guides/fixtures/) explains how to declare them.

`npx lynkeus case init` writes a starting point for that next stage: an example case that uses fixtures, a reference of the case format next to it (`cases/README.md`), a small fixtures server (`cases/fixtures.mjs`), and the `cases` section of `lynkeus.config.json`.

## Common problems

**`case run` answers that there are no cases under `cases`.** You ran `case run` with no file and there is no `cases` folder, or it holds no `.md` files. Pass the file, or create the folder.

**A step fails with `No app attached …`.** The driver could not reach the app. See the common problems in [the installation page](/getting-started/installation-react-native/#the-cli-never-attaches).

**`app.wait` times out on a screen that is clearly there.** The route name in the case is not the one the app reports. Run `npx lynkeus screen` on that screen and copy the name from its first line.

**A text target does not match.** A text matches a button or input by its exact label first, then by part of it. A paragraph matches only by its exact, full text, so a word inside a sentence is never a target. `npx lynkeus why 'Log in'` says whether the text on screen is a wording or an accent away.

**The second run fails where the first passed.** The case depends on where the previous run left the app. Start it from a known place: `app.nav` to the first screen in `setup`, and, when your app registers a `reset` command, `app.call: { command: reset }` before it.

**Typing does nothing on the iOS simulator.** The simulator is taking keys from the Mac. Turn off **I/O → Keyboard → Connect Hardware Keyboard**.

## Next steps

- [Concepts](/getting-started/concepts/): the terms used on this page, defined once.
- [Driving the app](/guides/driving-the-app/): every drive command, scoping a target to a row, swipes and scrolling.
- [Writing cases](/guides/writing-cases/): setup, aliases, values that change per run, steps of your own.
- [Fixtures](/guides/fixtures/): preparing backend data for a case.
- [Reports](/guides/reports/): keeping a run as a directory with screenshots and video, and sharing it.
- [Headless](/platforms/headless/): running the same case in Node, with no simulator.

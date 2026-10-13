---
title: Driving the app
description: Read the screen, press, type, swipe, wait and assert from a terminal, and point each command at the right element.
---

Driving the app means sending it one command at a time from a terminal: read the screen, press a button, type into a field, wait for the next screen. You do this to explore an app before writing a test, to reproduce a failure by hand, and to learn the names a test will use.

This guide covers the commands you will use most (`screen`, `press`, `type`, `swipe`, `wait`, `see`, `idle`, `nav`, `back`), how to name an element, and how to tell two similar elements apart. Every flag is listed in the [CLI reference](/reference/cli/).

## Before you start

- The agent is mounted in your app and the app is running as a debug build on a simulator or an emulator. See [Install in a React Native app](/getting-started/installation-react-native/) or [Install in an Expo app](/getting-started/installation-expo/).
- `LYNKEUS_TOKEN` in your terminal holds the same value the app received when it was bundled.
- You run the commands from the app's folder.

## Read the screen

Everything starts with `screen`. It prints the route, the navigator path and one line per element a user could see or touch.

```bash
npx lynkeus screen
```

You should see something like this:

```text
Settings.Main (Tabs > Settings.Main) +overlay#account-sheet · 12 hidden: 12 behind-overlay
4 button #close-sheet "Close"
5 button #delete-account-button "Delete account" !disabled
6 text "Are you sure?"
7 button #slide-to-confirm ~inert
```

The header is the **route** (the screen's name, as your navigation library reports it), the path of navigators that leads to it, and the layer on top if a sheet or dialog is open. Elements the platform is not presenting, such as another tab or the screen under a sheet, are left out and counted.

Each line is an element: its index, its kind (`button`, `input`, `text`, `scroll`, `switch`, `image`, `view`), its `#testId`, its label, and its state.

| State | Meaning |
|---|---|
| `!disabled` | The control will not answer a touch. |
| `~covered` | Something is drawn over it. A touch at its center would land on something else. |
| `~inert` | Readable, not touchable. |

Useful variants:

| Command | What it adds |
|---|---|
| `npx lynkeus screen --all` | Also lists what is not presented. |
| `npx lynkeus screen --frames` | Adds each element's center, in points. |
| `npx lynkeus screen --tree` | Nested lines with no geometry. This is the form to diff. |
| `npx lynkeus screen --json` | The full structure, for programs. |

## Name an element: targets

A **target** is how you tell a command which element you mean. There are five spellings.

| Spelling | Matches |
|---|---|
| `#next-button` | The element with that `testID`. |
| `Continue` | A control (a button or an input) by exact label, then by substring. A paragraph matches only by its exact text. |
| `"Continue"` | The same text, and only ever a text. See [Quoted targets](#quoted-targets). |
| `12` | The element at that index in the last screen listing. |
| `100,200` | A point, in window points. |

Add `[n]` to a `#testId` or a text to pick among several matches, counting from 0: `'#row[2]'` is the third element with that `testID`.

Prefer `#testId`. Text changes with copy and language, an index changes whenever the screen does, and a point changes with the device.

Covered elements are never matched. When two elements tie, the later one wins, because it draws on top.

In a shell, quote targets that start with `#` so the shell does not read them as a comment:

```bash
npx lynkeus press '#next-button'
```

### Quoted targets

lynkeus decides what a target is from its shape. Digits are an index, `#` starts a `testID`, and to `wait` and `see` a word that starts with a capital is a route. That leaves some texts you cannot write plainly: a label that reads `12`, a hashtag, a button labeled `Next`.

A target inside quotes of its own is the text between them and never anything else:

```bash
npx lynkeus wait '"Next"'      # the element that says Next, not a route called Next
npx lynkeus press '"12"'       # the control labeled 12, not the element at index 12
```

There are two pairs of quotes because there are two readers. The shell takes the outer pair; the inner pair reaches lynkeus. Either kind of quote works on the inside.

:::note[Since 0.3.0]
Before 0.3.0 the inner quotes stayed in the text, so `press '"Next"'` looked for a label with quotes in it and found nothing, and a capitalized word given to `wait` or `see` could only be a route.
:::

## Press, type and swipe

`press` puts a finger on an element. It is a synthesized touch, so gesture recognizers and pressables see it as they would a real one.

```bash
npx lynkeus press '#next-button'
npx lynkeus press 'Continue'
npx lynkeus press '#photo' --hold 800      # a long press, in ms
npx lynkeus press '#next-button' --settle  # then wait for the app to go quiet and print the screen
```

`type` types into the focused input. Give it a target and it taps that field first, which is how a person focuses it.

```bash
npx lynkeus type '1124888418' '#phone-input'
npx lynkeus type 'ana' '#search' --submit   # then the return key
npx lynkeus type 'new value' '#name' --clear
npx lynkeus type 'a long text' '#notes' --paste   # insert at once instead of key by key
```

`swipe` is a drag. Without a target it swipes the screen. On a target it drives that element's gesture, such as a slider or a sheet.

```bash
npx lynkeus swipe up
npx lynkeus swipe left '#carousel'
npx lynkeus swipe --from 40,400 --to 320,400   # both ends placed by hand, in points
```

On a target the drag starts at its center. A wide control cannot always afford that: a slider that needs 80% of its width would end off-screen, and a touch that leaves the screen is canceled. Use `--from` and `--to` in that case.

## Wait for what comes next

After an action, the app needs time: a request, an animation, a navigation. `wait` returns the moment a route or an element appears, so you never guess a duration.

```bash
npx lynkeus wait Settings.Main              # until that route is on screen
npx lynkeus wait '#pay-button'              # until that element appears
npx lynkeus wait '"Pay now"'                # until an element with that text appears
npx lynkeus wait '#spinner' --gone          # until it leaves
npx lynkeus wait '#row-25' --scroll         # scroll the nearest scroller until it is in the window
npx lynkeus wait 800                        # a plain pause, in ms
```

`wait` gives up after 10 seconds by default. Change that with `--timeout <ms>`.

`wait` and `see` take a route or a target in the same position. A word that starts with a capital letter (`Settings.Main`, `Next`) is a route. To wait for a text that looks like one, quote it: `'"Next"'`. A route that does not start with a capital, as expo-router's do, takes the `route:` prefix: `npx lynkeus wait route:index`.

`idle` waits for something different: for the app to stop committing renders, which means data arrived and animations finished.

```bash
npx lynkeus idle
```

A screen that has not started loading looks exactly like one that has finished: both are quiet. When that matters, pass `--after <commit>` with the commit count from before the action (`screen --verbose` prints it). `idle` then waits for the app to commit past that count first.

A screen that ticks, such as a countdown or a spinner that re-renders, never goes idle. `idle` reports that as `idle: false` when its timeout ends. If such a control is always on screen, list its testID pattern under `live` in `lynkeus.config.json` so its text stops counting.

## Assert

`see` checks that a route or an element is on screen now. It exits with code 1 when it is not, which makes it usable in a shell script.

```bash
npx lynkeus see '#pay-button'
npx lynkeus see Checkout.Confirm
npx lynkeus see '#error-banner' --absent
npx lynkeus see '#receipt' --within 2000    # allow it this long to appear
```

For the backend half of a check, `requests` lists the HTTP requests the app made, with method, path, status and duration.

```bash
npx lynkeus requests --last 10
```

## Move without touching: nav and back

`nav` jumps straight to a route. It is a teleport, not a user action: use it to get to where a test starts, not to prove that a user can get there.

```bash
npx lynkeus nav Checkout.Confirm '{"id":"abc"}'
npx lynkeus back
```

`back` pops the current route.

Both need a navigation adapter. With `auto()` the React Navigation container is found for you. Without an adapter you still get the screen, touches and waits, but no routes.

## Tell similar elements apart: scoping

A list repeats the same control in every row. Two flags narrow a target to the one you mean.

`--in <target>` picks the match nearest another element:

```bash
npx lynkeus press '#like-message-button' --in 'hi from Ana'
```

`--nth <n>` picks by position among the matches, counting from 0:

```bash
npx lynkeus press '#like-message-button' --nth 2   # the third match
```

`press`, `type` and `wait` all accept both. `--in` takes a `#testId` or a text.

## Run many commands on one connection

Each `npx lynkeus …` invocation starts a process and opens a connection, which costs about 1.5 seconds. A step itself costs about 50 ms. When you run more than a couple of commands, keep one connection open with `session`:

```bash
printf '%s\n' '["press","#next-button"]' '["wait","Settings.Main"]' '["screen"]' | npx lynkeus session
```

`session` reads one JSON array of arguments per line on stdin and answers one JSON object per line: `{ok, out, json?}`, or `{ok:false, error, why?}` when the step failed. `exit` ends it. Commands that run a whole flow or host the app are not available in a session.

## How it works

The agent inside your app walks React's own tree, keeps the components a user could see or touch, measures each one, and asks the platform which of them a touch would actually reach. That is why `screen` can say an element is covered. The whole reading takes one JavaScript tick.

Touches and keystrokes are synthesized natively inside the app's process, so they travel the same path as a real finger and a real keyboard. Waits end on the render that satisfies them.

An input's `value` is what its native field holds, not what React was told to put there. A field the app does not control (one with no `value` prop) therefore reads as what was typed into it. Values of `secureTextEntry` fields are masked. The request log keeps method, path, status and duration, never headers or bodies.

:::note[Since 0.3.0]
Reading the value from the native field needs the native module of `lynkeus-agent` 0.3.0, so rebuild the app after updating the package. Until then the agent reads React's props as before: an uncontrolled field reads as empty after typing, and one with a `defaultValue` keeps reading as that. The same rebuild gives Android its corrected `~covered`; see [Android](/platforms/android/).
:::

## Common problems

**A press does nothing.** Read the screen. The element may be `~covered`, `!disabled`, or not presented at all (the header counts those, and `screen --all` lists them). `press --js` calls the React handler directly instead of synthesizing a touch. That is a useful comparison, not a fix.

**You do not know why a step failed.** After a failed `press`, `wait`, `type`, `swipe` or `nav`, lynkeus prints why: the target is covered or disabled, the text is a wording or an accent away, requests were still in flight, the backend answered 5xx. Ask again at any moment:

```bash
npx lynkeus why '#pay-button'
npx lynkeus why --route Checkout.Confirm
```

**A text target does not match.** A word inside a paragraph is never a target: a paragraph matches only by its exact text. `npx lynkeus why '"Continue"'` says whether the text is a wording or an accent away.

**`wait Next` times out although the button is on screen.** A capitalized word is a route to `wait` and `see`. Quote the text: `npx lynkeus wait '"Next"'`.

**An input reads `value=""` after typing into it.** The app was built before `lynkeus-agent` was updated, and the field has no `value` prop. Rebuild the app.

**A wait times out on a screen that is clearly there.** The route name comes from the navigation adapter. Check `npx lynkeus screen` for the real name.

**No keyboard appears on the iOS simulator.** The simulator is taking keys from the Mac. Turn off I/O → Keyboard → Connect Hardware Keyboard.

**The driver never attaches.** Check that the build is a debug build, that the agent is enabled for this environment, that the app's log does not say `the app passed a token and it is empty`, and that the app's token equals `LYNKEUS_TOKEN`. `--attach-timeout <ms>` waits longer. More in [Troubleshooting](/troubleshooting/).

## Next steps

- [Writing cases](/guides/writing-cases/): the same commands as steps in a file.
- [Recording and snapshots](/guides/recording-and-snapshots/): let lynkeus write the steps while you use the app.
- [CLI reference](/reference/cli/): every command and flag.
- [Concepts](/getting-started/concepts/): the vocabulary used here.

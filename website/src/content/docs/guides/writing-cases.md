---
title: Writing cases
description: Write a test as a case file, reuse values between steps, define steps of your own, and run one case or a whole suite.
---

A **case** is one test, written as a markdown file a person can read top to bottom: what has to exist, what the user does, and what must be true afterward. The same file runs on a simulator, an emulator and the headless host.

This guide covers the format in practice. For every step and parameter, see the [case format reference](/reference/case-format/).

## Before you start

- You can drive the app from the terminal. See [Driving the app](/guides/driving-the-app/).
- You know the testIDs and routes of the screens the test crosses. `npx lynkeus screen` prints them.

## Create the first case

`case init` writes a working starting point, so you begin from something that runs.

```bash
npx lynkeus case init
```

You should see:

```text
wrote cases/example.md
wrote cases/README.md
wrote cases/fixtures.mjs
added cases to lynkeus.config.json
next: `lynkeus case run cases/example.md --dry-run`, then make fixtures.mjs talk to your backend
```

`example.md` is a case to copy from. `README.md` is a short reference of the format. `fixtures.mjs` is a small server that prepares backend data, explained in [Fixtures](/guides/fixtures/).

## The shape of a case

```md title="cases/settings-dark-mode.md"
---
id: settings-dark-mode
title: "Settings: switching to dark mode"
description: >
  A user can switch the theme from Settings and the choice is shown as selected.
---
setup:
  - app.call: { command: reset }

steps:
  - app.press: "#settings-button"
  - app.wait: Settings.Main
  - app.press: "Dark"
  - app.see: { testId: theme-dark-selected }

expected: |
  The dark theme is marked as selected.
```

The file has two parts.

The **frontmatter**, between the `---` lines, names the case. `id` identifies it in every report; when you leave it out, the file name is used. `title` and `description` are for people.

The **body** is YAML with three keys:

- `setup` is what has to exist before the test begins. A setup step that fails stops the case.
- `steps` is what the user does and what you assert.
- `expected` is a sentence that says what the case proves. It is not executed.

Each step is one key and one value: `verb: value`. A step that fails stops the case.

The setup above calls `reset`, a command your app registers with `qa.register` to log out and clear its storage and caches. Starting every case from a clean app avoids the most common bug between tests: state left by the one before.

## Steps that drive the app

Steps that start with `app.` are the terminal commands you already know.

| Step | Value |
|---|---|
| `app.press` | A target, or `{ target, within?, nth?, optional?, hold?, timeoutMs? }`. In place of `target`: `testId` or `text` |
| `app.type` | `{ text, target?, submit?, clear?, timeoutMs? }` |
| `app.swipe` | `{ direction, target?, distance? }` or `{ from, to }` |
| `app.wait` | A route, a target, a number of ms, `{ target, scroll? }` or `{ request, status? }` |
| `app.see` | A target, or `{ testId?, text?, route?, request?, event?, layer?, absent?, timeoutMs? }` |
| `app.nav` | A route, or `{ route, params }` |
| `app.back` | No value |
| `app.call` | `{ command, params?, expect?, as? }` |

A target is spelled as on the command line: `#testId`, a text, an index or `x,y`.

Where a step takes `target`, it also takes `testId`, which is the same thing without the `#`. `app.press`, `app.type`, `app.swipe`, `app.wait` and `app.see` accept it. `app.press` takes `text` as well:

```yaml
steps:
  - app.press: { testId: settings-button }      # the same as target: "#settings-button"
  - app.press: { text: "Dark" }
  - app.type: { text: "ana@example.com", testId: email-input }
```

A text inside quotes of its own is always a text, never a route, an index or a `testId`. It matters most for `app.wait`, which reads a capitalized word as a route:

```yaml
steps:
  - app.wait: Next        # waits for a route called Next
  - app.wait: '"Next"'    # waits for the element that says Next
  - app.press: '"12"'     # the control labeled 12, not the element at index 12
```

The outer quotes are YAML's and the inner ones reach lynkeus, so use one kind inside the other.

:::note[Since 0.3.0]
`testId` in place of `target`, `text` in `app.press`, `timeoutMs` in `app.type` and quoted targets arrived in 0.3.0. An earlier version refuses them with `press has no testId`, `app.press needs a target` or `type has no timeoutMs`, and keeps the quotes as part of the text.
:::

A few behaviors are worth knowing before you write many cases:

- `app.press` waits for the control to be there and enabled. With `optional: true` it presses only if the control is on screen, which suits a one-time prompt.
- `app.type` with a target taps that field first, once the field is there. A field that mounts a moment after its screen is given 5 seconds to arrive; `timeoutMs` changes that. `app.swipe` has no `timeoutMs`.
- `app.see` is an assertion. Everything it names must hold at once. It waits up to 3 seconds by default; `timeoutMs` changes that.
- `app.see` and `app.press` scroll to what they look for. You do not need a swipe before each element below the fold.
- `app.wait: { request: "POST /v1/orders" }` waits for the app to make that request and get a 2xx answer. Add `status` to expect another code.
- `app.call` runs a command the app registered with `qa.register`. `expect` checks fields of its answer.

Any other lynkeus command is also a step, with its arguments by name: `app.mock`, `app.network`, `app.appstate`, `app.deeplink`.

```yaml
steps:
  - app.type: { text: "ana@example.com", target: "#email-input", submit: true }
  - app.wait: { request: "POST /v1/session" }
  - app.see: { route: Home.Main, text: "Hello, Ana" }
  - app.see: { testId: error-banner, absent: true }
```

## Reuse values between steps: aliases and `{{…}}`

A step can keep its answer under a name, called an **alias**, with `as`. Later steps read from it with `{{alias.path}}`.

```yaml
setup:
  - create_user: { as: u, name: "Ana" }

steps:
  - app.deeplink: "myapp://dev-login?user={{u.user_id}}"
  - app.see: { text: "{{u.name}}" }
```

`create_user` here is a fixture: a step answered by your own backend tooling. See [Fixtures](/guides/fixtures/).

Three other sources are always available:

| Reference | Value |
|---|---|
| `{{random.letters}}` | Six random lowercase letters, new on every run |
| `{{random.digits}}` | Six random digits, new on every run |
| `{{env.NAME}}` | The environment variable `NAME` |

A value that is one reference keeps its type, so `{{u.points}}` stays a number. Inside a longer string it becomes text. A reference that resolves to nothing fails the step with `{{u.email}} is empty`, and an unknown alias fails with ``no alias 'u' (add `as: u` to the step that creates it)``.

:::tip
Since 0.3.0, set `LYNKEUS_SEED` to any value and each case draws the same random values on every run, and different ones from the case beside it. Use it when you compare the screenshots of two runs.
:::

## Run a case over several inputs

`matrix` in the frontmatter runs the case once per combination of values.

```md
---
id: signup
matrix: { locale: [en, fr], login: [phone, email] }
---
steps:
  - app.see: { testId: "signup-{{matrix.login}}-input" }
```

This runs four times. Each run is named after its combination, for example `signup[locale=fr,login=phone]`, and `{{matrix.locale}}` anywhere in the file is that run's value.

## Steps for one host only: `on:`

Sometimes one host needs a step the others do not, such as closing a native screen that the headless host never shows. Put those steps under `on:`. Everywhere else they are skipped.

```yaml
steps:
  - app.press: "#open-camera"
  - on: device
    do:
      - app.press: "364,84"
  - app.see: "#photo-preview"
```

| Value | The step runs when |
|---|---|
| `device` | The app runs on a simulator or an emulator |
| `headless` | The app runs on a host without a device |
| `ios`, `android` | The app reports that platform |
| `has:<command>` | The app registered that command |

Put `!` in front to turn any of them around: `on: "!ios"`.

## Steps of your own: macros

Every suite repeats a few sequences, logging in above all. A **macro** names a step and the steps it stands for. Macros live in `lynkeus.config.json`, under `cases.macros`.

```json title="lynkeus.config.json"
{
  "cases": {
    "macros": {
      "app.login": [
        { "app.call": { "command": "reset" } },
        { "app.deeplink": "myapp://dev-login?user={{param.as.user_id}}" },
        { "when": "wait", "do": { "app.wait": "{{param.wait}}" } }
      ]
    }
  }
}
```

A case then uses it like any step:

```yaml
setup:
  - create_user: { as: u }
  - app.login: { as: u, wait: Home.Main }
```

Inside a macro, `{{param.x}}` is what the case passed. A parameter that names an alias is that alias, which is why `{{param.as.user_id}}` reads the user's id.

`when` runs a step only if the case passed that parameter (`"when": "wait"`) or passed that value (`"when": "method=phone"`). `unless` is the opposite.

## Things that get in the way: interruptions

An app may put something in front of any step: a lock screen, a consent sheet. Writing a step for it in every case does not scale. An **interruption** says what it looks like and how to get past it.

```json title="lynkeus.config.json"
{
  "cases": {
    "interruptions": [
      { "see": "#unlock-keypad", "do": ["app.unlock"], "unless": "keypad" }
    ]
  }
}
```

Before a press, a type, a swipe or a see, the runner looks for `#unlock-keypad`. If it is on screen, it runs the `do` steps first (`app.unlock` here would be a macro of yours). A step whose own text matches `unless` is about the interruption itself and is left alone.

## Run cases

```bash
npx lynkeus case run cases/settings-dark-mode.md   # one case
npx lynkeus case run                               # every .md under cases.dir
npx lynkeus case run --dry-run                     # parse and list the steps, run nothing
npx lynkeus case run cases/gift.md --host          # start the headless host for the run and stop it after
```

Each step prints as it finishes, then the case's verdict, then the summary:

```text
▶ settings-dark-mode — Settings: switching to dark mode
  ✅ app.call command: reset  (212ms)
  ✅ app.press #settings-button  (96ms)
  ✅ app.wait Settings.Main  (140ms)
  ✅ app.press Dark  (88ms)
  ✅ app.see testId: theme-dark-selected  (31ms)
✅ PASSED  ✅ 5  — 0.6s
✅ settings-dark-mode
1/1 passed
```

The command exits with 0 when no case failed and 1 otherwise.

When a step fails, the case prints the screen at the failure, the last requests, and why the step failed. Add `--continue` to keep running the remaining steps of a case after one fails, to see everything that is wrong in one pass.

### Retries

A failed case runs once more before it counts as failed. One that passes the second time is reported as `⚠ passed on retry`. `--once` turns the second chance off. See [Flaky tests](/guides/flaky-tests/) for what to do with those.

### Unsupported is not failed

A step the host cannot do, such as a mocked response on a simulator or an emulator, is `unsupported`. The case stops there and is reported as one that cannot run on this host. It does not fail the run:

```text
3/5 passed, 2 cannot run on this host
```

### Several cases at once: jobs

`--jobs <n>` runs n cases at the same time, each on its own host. Each job needs its own driver port, given with `--ports`.

```bash
npx lynkeus case run --jobs 3 --ports 8123,8124,8125
```

The app or host of each job must dial its own port. With several jobs the longest cases start first, so the jobs finish together; `--in-order` keeps the order you gave. `--host-command` starts a fresh host for every case and stops it afterward. In the command, `{port}` is replaced by the port the host must dial and `{job}` by the job's number.

## How it works

The runner opens one connection to the app and keeps it for the whole case. `app.` steps go through the same code as the terminal commands. Any step name that is not `app.`, `assert`, `exec` or a macro is sent to your fixtures command.

The runner also absorbs what only a device does. After a swipe on a device it waits for the screen to stop moving, since a pager keeps going after the finger lifts. After a wait for a route it lets the screen finish sliding in before the next press.

## Common problems

**`cases/x.md: no frontmatter (a case starts with --- and its id)`.** The file must begin with a `---` line, the frontmatter, and a closing `---`.

**`… must be one step, as verb: value`.** A list item has two keys. Each step is exactly one key; put parameters inside braces.

**`app.foo is not a step: lynkeus has no command foo, and the project declares no macro for it`.** The verb is misspelled, or the macro is missing from `cases.macros`. `--dry-run` finds these without running anything.

**`port 8123 is held by another lynkeus case run`.** Two runs on one port would take turns at the app. Stop the other run or give this one other `--ports`.

**`app.wait: Next` times out on a screen where the Next button is plainly there.** A capitalized word is a route to `app.wait`. Quote the text, `app.wait: '"Next"'`, or use the element's `testId`.

**A request assertion passes for the wrong request.** A `request` counts only what the app asked for after the step before it began. To look further back, put `app.requests: mark` where the counting should start.

**The cases live in another repository.** Set `LYNKEUS_CONFIG` to a second configuration file. It is read over the app's, and the paths under its `cases` are relative to it.

## Next steps

- [Fixtures](/guides/fixtures/): prepare and read the backend from a case.
- [Reports](/guides/reports/): keep each run as a report.
- [Case format reference](/reference/case-format/): every step and parameter.
- [Configuration reference](/reference/configuration/): every key under `cases`.

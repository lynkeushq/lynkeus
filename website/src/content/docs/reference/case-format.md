---
title: Case format
description: The case file in full — frontmatter, setup and steps, every verb with its parameters, conditions, references, macros and interruptions.
---

A **case** is one test, written as a Markdown file that a person can read from top to bottom: what has to exist, what the user does, and what must be true afterwards. This page is the complete reference of that file. For a guided introduction, read [Writing cases](/guides/writing-cases/) first.

`lynkeus case run` runs cases. Its flags are in the [CLI reference](/reference/cli/#lynkeus-case-run); the project settings a case relies on are under [`cases` in the configuration](/reference/configuration/#cases).

## A complete case

```md title="cases/points.md"
---
id: points
title: "A user who was given points sees them on the first screen"
description: >
  The balance on the home screen follows the backend without a restart.
---
setup:
  - create_user: { as: u, name: "Ana" }

steps:
  - app.see: { text: "Hello" }
  - give_points: { user: u, points: 25 }
  - app.see: { text: "25 points", timeoutMs: 10000 }
  - assert: { user: u, path: points, equals: 25 }

expected: |
  The points on screen and the points the backend holds are both 25.
```

The file has two parts, both YAML:

- The **frontmatter**, between the two `---` lines, names the case.
- The **body** has three keys: `setup` (what to prepare), `steps` (what to do and check) and `expected` (what that proves, in words).

Each entry of `setup` and `steps` is one **step**: a single key, the verb, and its value. Here `create_user` and `give_points` are fixtures of the project, `app.see` drives the app, and `assert` reads the backend.

## Frontmatter

The file must start with `---` on its first line. A file without frontmatter is refused with `no frontmatter (a case starts with --- and its id)`.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `id` | string | the file name without `.md` | The case's name in output, reports and file names. |
| `title` | string | none | One line saying what the case proves. Printed when the case starts and shown in reports. |
| `description` | string | none | A longer explanation. Kept in the run file for reports. |
| `matrix` | object of lists | none | Inputs to run the case over. See [Matrix](#matrix). |

Other keys are allowed and ignored by the runner.

## Body

| Key | Type | Meaning |
|---|---|---|
| `setup` | list of steps | What has to exist before the test. A step that fails here stops the case, even with `--continue`. |
| `steps` | list of steps | The test itself. |
| `expected` | string | What a passing run proves, for the reader. The runner does not evaluate it. |

All three are optional. `setup` and `steps` use the same step syntax and the same verbs. The difference is what a failure means, and that a setup made only of fixtures can be run ahead of time by `lynkeus case prepare`.

## How a step is read

A step is written `verb: value`, or as a bare word when the verb takes no value:

```yaml
steps:
  - app.back
  - app.press: "#next-button"
  - app.type: { text: "ana@example.com", target: "#email" }
```

An entry with more than one key is refused: ``must be one step, as `verb: value` ``.

The verb decides who performs the step:

| Verb | Performed by |
|---|---|
| A name in `cases.macros` | The steps the macro stands for. Macros are looked up first, so a macro can be named `app.login`. |
| `app.<something>` | The app, through the agent. |
| `assert` | The backend, read through the `inspect` fixture. |
| `exec` | A shell command. |
| Anything else | A fixture of the project. |

### What happens when a step fails

A failed step stops the case. The remaining steps are reported as skipped, unless `case run --continue` was given. The report keeps the screen as it was, the requests the app had made, and why the step failed.

A step has one of four results:

| Result | Meaning |
|---|---|
| `passed` | It did what it says. |
| `failed` | It did not. The case fails. |
| `skipped` | It was not run: an `on:` condition did not hold, an `optional` press found nothing, or an earlier step failed. |
| `unsupported` | The host has no way to do it, such as a mocked response on a real device. The case stops there with result `unsupported`. It is not retried and does not fail the run. |

## Targets

Steps that touch or look for an element take a **target**, written as a string:

| Spelling | Matches |
|---|---|
| `"#next-button"` | The element with that `testID`. |
| `"Continue"` | A control (button or input) by exact label, then by substring. A paragraph only by its exact text. |
| `"12"` | The element at that index in the screen listing. |
| `"364,84"` | A point, in window points. |
| `"#row[2]"` | The third match (counted from 0). |

In YAML, quote a target that starts with `#`: an unquoted `#` starts a comment.

## Steps that drive the app

### `app.press`

Presses an element. It waits for the control to be listed, in the window, enabled and no longer moving before it presses.

```yaml
- app.press: "#next-button"
- app.press: { target: "#like-button", within: "hi from Ana" }
- app.press: { target: "#promo-close", optional: true }
- app.press: { target: "#message", hold: 600 }
```

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `target` | target | required | What to press. A plain string value is the target. |
| `within` | target | | Among several matches, take the one nearest this `#testId` or text. |
| `nth` | number | | Take the nth match, counted from 0. |
| `optional` | boolean | `false` | Press only if the target is on screen once the app has gone quiet. Otherwise the step is skipped, not failed. |
| `hold` | number (ms) | | Keep the finger down this long. About 600 is a long press. |
| `timeoutMs` | number (ms) | `3000` | How long to wait for a control that is still disabled or covered. Applies to a `#testId` target. |
| `js` | boolean | `false` | Call the element's `onPress` directly instead of synthesizing a touch. |

When the target is not listed, the step waits half a second and then scrolls to find it. When it is listed but outside the window, the step scrolls toward it.

### `app.type`

Types text. With a `target`, the field is tapped first.

```yaml
- app.type: { text: "1124888418", target: "#phone-input", submit: true }
```

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `text` | string | required | What to type. A plain string value is the text, typed into the focused input. |
| `target` | target | | The field to tap first. |
| `within` | target | | Among several matches, take the one nearest this target. |
| `nth` | number | | Take the nth match, counted from 0. |
| `submit` | boolean | `false` | Press the return key afterwards. |
| `clear` | boolean | `false` | Clear the field first. |
| `paste` | boolean | `false` | Insert the whole text at once instead of key by key. |

### `app.swipe`

Drags a finger, across the window or on an element.

```yaml
- app.swipe: up
- app.swipe: { direction: left, target: "#carousel" }
- app.swipe: { from: "40,400", to: "340,400" }
```

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `direction` | `up`, `down`, `left`, `right` | | Which way to drag. A plain string value is the direction. |
| `target` | target | | Swipe on this element: drives its own gesture (a slider, a sheet). The whole drag is kept inside the window. |
| `distance` | number (points) | | How far to drag. |
| `from`, `to` | `"x,y"` | | Both ends of the drag, in points, instead of a direction. |
| `durationMs` | number (ms) | | How long the drag takes. |

On a device, a swipe is followed by a wait for the screen to stop moving. A pager keeps going after the finger lifts, and would swallow a swipe sent into that momentum.

### `app.wait`

Waits for something. The value decides for what.

```yaml
- app.wait: Settings.Main                              # a route
- app.wait: "#pay-button"                              # a target
- app.wait: 800                                        # milliseconds
- app.wait: { target: "#row-25", scroll: true }        # scroll until it is in the window
- app.wait: { target: "#spinner", gone: true }         # until it leaves
- app.wait: { request: "POST /v3/payments", status: 201 }
```

| Value | Waits for |
|---|---|
| A route name | The app to be on that route. A word that starts with a capital letter, with more such words after dots, is read as a route. |
| A target | The element to be on screen. |
| A number | That many milliseconds. |
| An object | See the parameters below. |

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `target` | route or target | | What to wait for. |
| `within` | target | | Among several matches, take the one nearest this target. |
| `nth` | number | | Take the nth match, counted from 0. |
| `gone` | boolean | `false` | Wait until it leaves the screen. |
| `scroll` | boolean | `false` | Swipe until the target is in the window. |
| `request` | string | | Wait for a request the app made, written `METHOD /path`. A bare path matches any method. The path matches when the request's path ends with it. |
| `status` | number | any 2xx | With `request`: the status the answer must have. |
| `timeoutMs` | number (ms) | `10000` | Give up after this long. |

A `request` counts only the requests the app started after the previous acting step began, so an earlier screen's request to the same path does not pass for the one you mean. See [`app.requests`](#apprequests) to mark further back.

:::caution
A one-word label that starts with a capital letter, such as `Continue`, is read as a route by `app.wait`. Wait for such a control by its `testID`, or assert it with `app.see`.
:::

### `app.see`

Asserts what the app shows or did. Everything the step names must hold at once.

```yaml
- app.see: "#pay-button"
- app.see: { text: "25 points", timeoutMs: 10000 }
- app.see: { route: Checkout.Confirm, testId: total, text: "€ 12.00" }
- app.see: { target: "#error-banner", absent: true }
- app.see: { request: "GET /v3/accounts", status: 200 }
- app.see: { event: signup_completed, props: { method: email } }
- app.see: { layer: true }
```

A plain string value is a target, never a route. To assert a route, use `route`.

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `target` | target | | The element must be on screen. `testId: total` is accepted in place of `target: "#total"`. |
| `within` | target | | Among several matches, take the one nearest this target. |
| `nth` | number | | Take the nth match, counted from 0. |
| `text` | string | | With a target: the element, or an element inside it, must contain this text. Alone: some element on screen must contain it. |
| `route` | string | | The app must be on this route. |
| `layer` | boolean or string | | `true`: a layer (a sheet, a dialog) is open over the screen. `false`: none is. A string: one is open and its `testID` contains the string. |
| `request` | string | | The app must have made this request, written `METHOD /path`. |
| `status` | number | any | With `request`: the status the answer must have. |
| `event` | string | | The app must have reported this analytics event. |
| `props` | object | | With `event`: properties the event must carry. Values are compared as text. |
| `absent` | boolean | `false` | Turn the assertion around: the step passes when the conditions do not hold. |
| `timeoutMs` | number (ms) | `3000` | How long the conditions have to become true. While the app reports that it is busy, the step keeps waiting a little longer, up to 12 seconds in total. |

On a device, and on a host that lists only what its window shows, `app.see` looks further before its deadline counts: a short wait in case the target is arriving, a scroll in case it is below the fold, and a longer wait in case a carousel is about to show it.

### `app.nav`

Jumps straight to a route, then waits for the route and for the app to settle. This is a teleport, not a user action: use it to get to where the test starts.

```yaml
- app.nav: Settings.Main
- app.nav: { route: Checkout.Confirm, params: { id: "abc" } }
```

| Parameter | Type | Meaning |
|---|---|---|
| `route` | string | The route name. A plain string value is the route. |
| `params` | object | Optional. The route's params. |

### `app.back`

Pops the current route. It takes no value.

```yaml
- app.back
```

### `app.requests`

Marks a point in the app's requests by hand.

```yaml
- app.requests: mark
- app.press: "#refresh"
- app.press: "#confirm"
- app.see: { request: "POST /v3/refresh" }
```

A `request` condition normally counts only what the app asked for after the previous acting step began. `app.requests` marks further back: the mark holds until a step has looked for a request, so a request made several steps earlier still counts.

### `app.call`

Runs a command the app registered with `qa.register`. See the [Agent API](/reference/agent-api/).

```yaml
- app.call: { command: reset }
- app.call: { command: setFlag, params: { name: new-checkout, on: true } }
- app.call: { command: stores, params: { name: session }, expect: { loggedIn: true }, as: session }
```

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `command` | string | required | The command's name. |
| `params` | any | | What to pass to it. |
| `expect` | object | | Paths into the answer and the value each must have. Values are compared as text. `null` means the path must be empty. The call is repeated until the answer matches or the time is up. |
| `as` | string | | Keep the answer under this alias, for [references](#references). |
| `timeoutMs` | number (ms) | `3000` | How long `expect` has to become true. |

### `app.run`

Runs a flow: a JSON file of steps, as `lynkeus run` replays it.

```yaml
- app.run: login.json
- app.run: { flow: login.json, vars: { phone: "1124888418" } }
```

| Parameter | Type | Meaning |
|---|---|---|
| `flow` | string | The flow file, relative to `cases.flows` (default `flows`). A plain string value is the flow. |
| `vars` | object | Optional. The flow's variables. |

### `app.event` and `app.events`

Assert on, or clear, what the app told its analytics.

```yaml
- app.events: clear
- app.press: "#sign-up"
- app.event: signup_started
- app.event: { name: signup_completed, props: { method: email } }
- app.event: { name: signup_failed, absent: true }
```

`app.events` empties the app's event buffer, so that later assertions see only what happens next.

`app.event` asserts that an event was reported. It is `app.see` with an `event`, and takes the same `props`, `absent` and `timeoutMs`.

| Parameter | Type | Meaning |
|---|---|---|
| `name` | string | The event's name. A plain string value is the name. |
| `props` | object | Optional. Properties the event must carry. |
| `absent` | boolean | Optional. Assert that no such event was reported. |

### Any other lynkeus command

Any other `app.<name>` runs the lynkeus command of that name, with or without its `os` prefix: `app.mock` is `lynkeus mock`, `app.network` is `lynkeus os network`, `app.deeplink` is `lynkeus os deeplink`.

```yaml
- app.deeplink: "myapp://pay/abc"
- app.appstate: background
- app.network: "off"
- app.clock: { now: "2027-01-01T00:00:00Z" }
- app.mock: { route: "GET /v3/accounts", status: 500 }
- app.mock: clear
- app.idle
```

The value becomes the command's arguments:

| Value | Becomes |
|---|---|
| Nothing | The bare command. |
| A string that names one of the command's switches | That switch: `app.mock: clear` is `lynkeus mock --clear`. |
| Any other string or number | The first argument. |
| A list | The arguments, in order. |
| An object | Keys that name an argument fill that argument. Every other key is a flag: `true` sets a switch, `false` and `null` leave it out, a list repeats the flag. |

In an object, the keys `target`, `request`, `route`, `url`, `state` and `text` also stand for the command's first argument, whatever the command calls it. Six flags have a longer spelling you can use instead: `within` for `in`, `timeoutMs` for `timeout`, `delayMs` for `delay`, `durationMs` for `duration`, `holdMs` for `hold` and `advanceMs` for `advance`.

A key that names neither an argument nor a flag of the command fails the step with `<command> has no <key>`. A name that is no lynkeus command and no macro fails with `app.<name> is not a step`. `lynkeus case run --dry-run` reports both without running anything.

The arguments and flags of each command are in the [CLI reference](/reference/cli/). Commands marked headless there work only on the headless host; on a device the step is reported as `unsupported`.

## Steps that prepare and read the backend

### Fixtures

Any step whose verb is not `app.*`, `assert`, `exec` or a macro is a **fixture**: a piece of backend preparation your project defines. lynkeus sends the step to the command in `cases.fixtures` as one JSON line and reads one line back. The protocol is described in [Fixtures](/guides/fixtures/).

```yaml
setup:
  - create_user: { as: u, name: "Ana" }
  - give_points: { user: u, points: 25 }
```

| Parameter | Type | Meaning |
|---|---|---|
| `as` | string | Keep the fixture's answer under this alias. It is not sent to the fixture. |
| Anything else | any | Sent to the fixture as its params. |

Parameters named in `cases.refs` are rewritten before they are sent. With `"refs": { "user": "user_id" }`, `user: u` reaches the fixture as `user_id`, read from what the step with `as: u` answered. A step that names no `user` gets the `user_id` of the latest answer that had one.

A fixture that answers `"ok": false` fails the step with its `error`. A case that names a fixture the fixtures command did not list is refused before anything runs.

### `assert`

Reads the backend through the `inspect` fixture (or the one named in `cases.inspect`) and checks one path of its answer.

```yaml
- assert: { user: u, path: points, equals: 25 }
- assert: { user: u, path: orders.0.status, equals: paid }
- assert: { user: u, path: orders.*.id, includes: "ord_" }
```

| Parameter | Type | Meaning |
|---|---|---|
| `path` | string | Required. Where to look in the answer, with dots: `orders.0.status`. A number indexes a list. `list.*.field` collects `field` from every item of the list. |
| One matcher | | Required. See the table below. |
| Anything else | any | Sent to the `inspect` fixture as its params, after `cases.refs`. |

| Matcher | Passes when the value |
|---|---|
| `equals: x` | Equals `x`. Numbers are compared as numbers, everything else as text. |
| `near: x` | Is a number within 0.01 of `x`. |
| `gte: x` | Is a number greater than or equal to `x`. |
| `lte: x` | Is a number less than or equal to `x`. |
| `includes: x` | Contains `x` as text. For a list: some item contains it. |
| `matches: "regex"` | Matches the regular expression. |
| `present: true` | Exists. |
| `absent: true` | Does not exist. |

The fixture also receives `section`, set to the first segment of `path`, so a server that builds its answer part by part needs to build only that part. Asserts in a row that ask for the same thing read one answer.

A failed assert reports the value it found: `points is 20`.

### `exec`

Runs a shell command, in the folder of the configuration file that declares `cases`. It fails the step when the command exits with an error, and gives up after 120 seconds.

```yaml
- exec: "bin/rails runner 'Job.drain'"
- exec: { run: "bin/issue-token --json", as: token }
```

| Parameter | Type | Meaning |
|---|---|---|
| `run` | string | The command. A plain string value is the command. |
| `as` | string | Optional. Keep the command's output under this alias. If the output contains a JSON object, the alias holds that object. Otherwise it holds `{ out: "<the output>" }`. |

## Conditions with `on:`

One case runs on a simulator and on the headless host. Where only one of them needs a step, wrap it in `on:` with the steps under `do:`. Everywhere else the steps are skipped.

```yaml
steps:
  - app.press: "#scan-id"
  - on: device
    do:
      - app.press: "364,84"
  - on: headless
    do:
      - app.scan: "ID-123"
```

| Condition | Holds when |
|---|---|
| `device` | The app runs on a phone, a simulator or an emulator. |
| `headless` | The app runs anywhere else. |
| `ios` | The app reports the platform `ios`. |
| `android` | The app reports the platform `android`. |
| `has:<command>` | The app registered that command, as `lynkeus hello` lists them. |
| `!<condition>` | The condition does not hold: `!ios`, `!has:reset`. |

`do` takes one step or a list of steps. An entry with `do` and no `on` is refused.

## References

A value can refer to something that is only known when the case runs, written between double braces.

| Reference | Value |
|---|---|
| `{{alias.path}}` | A path into what the step with `as: alias` answered. `{{u.user_id}}`, `{{order.items.0.sku}}`. |
| `{{random.letters}}` | Six random lowercase letters. |
| `{{random.digits}}` | Six random digits. |
| `{{env.NAME}}` | The environment variable `NAME` of the process running the case. |
| `{{matrix.key}}` | This run's value of a [matrix](#matrix) input. |
| `{{param.x}}` | Inside a [macro](#macros): what the case passed as `x`. |

```yaml
setup:
  - create_user: { as: u, email: "qa-{{random.letters}}@example.com" }
steps:
  - app.deeplink: "myapp://dev-login?user={{u.user_id}}"
  - app.see: { text: "{{u.name}}" }
```

Three rules apply:

- A value that is exactly one reference keeps its type: `points: "{{u.points}}"` sends a number if the answer held a number. Inside a longer text, the reference becomes text.
- A reference to nothing fails the step: `{{u.email}} is empty`.
- A reference to an alias no step created fails with ``no alias 'u' (add `as: u` to the step that creates it)``.

`{{random.letters}}` and `{{random.digits}}` are new on every run. With the environment variable `LYNKEUS_SEED` set to anything, each case draws the same values every time, and different ones from the case beside it. That is what comparing two runs' screens needs.

:::note
`LYNKEUS_SEED` is new and not yet in a published release.
:::

## Matrix

A case that should run over several inputs declares them in its frontmatter. It then runs once per combination.

```md title="cases/signup.md"
---
id: signup
title: "Sign up in {{matrix.locale}} with {{matrix.login}}"
matrix: { locale: [en, fr], login: [phone, email] }
---
setup:
  - create_user: { as: u, locale: "{{matrix.locale}}" }
steps:
  - app.press: "#login-with-{{matrix.login}}"
```

This file runs four times. Each run is named after its combination: `signup[locale=en,login=phone]`, `signup[locale=en,login=email]`, and so on.

`{{matrix.key}}` is replaced everywhere in the file, the frontmatter included, before the file is parsed. A `{{matrix.key}}` that is not in the matrix is refused.

## Macros

A **macro** is a step of your own: a name, and the steps it stands for. Macros live under `cases.macros` in `lynkeus.config.json`, so every case of the project can use them.

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

A case then uses it like any other step:

```yaml
setup:
  - create_user: { as: u }
steps:
  - app.login: { as: u, wait: Home.Main }
```

### Parameters

Inside a macro, `{{param.x}}` is what the case passed as `x`. A parameter whose value is the name of an alias is that alias, so with `as: u`, `{{param.as.user_id}}` is the user's id. When the case passes a plain value instead of an object, it is `{{param.value}}`.

### Conditional entries

An entry of a macro is either a plain step, or an object with `do` and one or more conditions:

| Key | Runs the step when |
|---|---|
| `when` | The condition holds. A list means all of them must hold. |
| `unless` | The condition does not hold. A list means none of them may hold. |
| `on` | The host matches, as in [Conditions with `on:`](#conditions-with-on). |

A `when` or `unless` condition is written one of three ways:

| Condition | Holds when |
|---|---|
| `wait` | The case passed the parameter `wait`, with a value other than `false`, `null` or `none`. |
| `method=phone` | The case passed `method` with exactly that value. |
| `ran:create_user` | A step with that verb has already run in this case. |

For reports, timing and requests, a macro is one step of the case. A request it waits for counts from its first action on, not only from its last.

## Interruptions

An **interruption** is something the app may put in the way of any step: a lock screen, a consent sheet, a rating prompt. `cases.interruptions` names each one and the steps that get past it, so cases do not have to.

```json title="lynkeus.config.json"
{
  "cases": {
    "interruptions": [
      { "see": "#unlock-keypad", "do": ["app.unlock"], "unless": "keypad" }
    ]
  }
}
```

| Key | Type | Meaning |
|---|---|---|
| `see` | target | When this element is on screen, the interruption is in the way. |
| `do` | list of steps | The steps that get past it. Macros are allowed. |
| `unless` | string | Optional. A regular expression, matched without regard to case against the step's own value. A step that matches is about the interruption itself, and is left alone. |

The runner checks for interruptions before a press, a type, a swipe or a see, and while an `app.wait` is waiting. If the steps in `do` fail but the interruption is gone anyway, the case goes on.

## Retries

A case that fails runs once more before it counts as failed. One that passes the second time is reported as passed on retry. `case run --once` turns the second chance off. A case with result `unsupported` is not retried.

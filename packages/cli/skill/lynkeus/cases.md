# Writing cases

A case is a markdown file in the cases folder (`cases.dir` in `lynkeus.config.json`, default `cases/`). `lynkeus case init` writes the folder once, with an example, a fixtures server and a `README.md` that holds the whole format; read that README for anything not here.

```markdown
---
id: sign-out
title: "A signed-in user signs out"
description: What this proves, in a sentence or two.
---
setup:
  - create_user: { as: u }            # not app.*: a fixture the fixtures server answers
steps:
  # 1 Signed in
  - app.call: { command: signIn, params: { user: "{{u.email}}" } }
  - app.wait: Home
  # 2 Sign out
  - app.press: "#sign-out-button"
  - app.see: { text: "Signed out", contains: true }
teardown:
  - app.relaunch
expected: |
  1. The user lands on Home.
  2. Signing out says so.
```

- A comment that starts with a number (`# 2 Sign out`) opens a section; reports and the live status group steps by it. Number them like `expected`.
- `teardown` runs after the steps whether they passed or failed; a failing teardown step is a warning, not a failure. Use it to put back what the case changed outside the app.
- `exclusive: true` in the frontmatter runs the case alone under `--jobs` (it changes something every case sees).
- `matrix: { locale: [en, fr] }` runs it once per value; `{{matrix.locale}}` reads it.
- `lynkeus case run --dry-run` lists each case's steps with every macro opened, and marks a step that is not one.

## Targets

- `#testId` first, then short texts. A text also matches a field's placeholder; an index (`app.press: 7`) and `x,y` work too.
- Letter case never matters. A text target matches an element's whole text (a button's label also by part). For a word inside a paragraph: `app.see: { text: "…", contains: true }`.
- A bare word that starts with a capital is a route: `app.wait: Next` waits for the route `Next`. Quote it twice for the text: `app.wait: '"Next"'`.
- In a list of rows, give each row's control a testID; `within` scopes a target to an element, `nth` picks one of several.

## Steps

`app.press`, `app.type` (`{ text, target?, submit?, clear? }`), `app.swipe`, `app.wait` (route, target, ms, `{ target, scroll: true }`, `{ anyOf: [...] }`, `{ request: "GET /path", status? }`), `app.see` (`{ testId?, text?, contains?, route?, request?, event?, absent? }`), `app.nav` (a teleport to where the case starts; a screen inside a nested navigator can be named alone, Lynkeus finds its parents), `app.back`, `app.relaunch`, `app.call`, `app.mock`, and any other Lynkeus command as `app.<command>` with its arguments by name. A step that is not `app.*`, `exec` or `assert` is a fixture: see the README.

## A known start: app commands

Sign in, reset or seed state through a command the app registers, not by driving forms in every case (that is also what keeps iOS's Save Password prompt away):

```ts
import { qa } from 'lynkeus-agent'
qa.register('signIn', async ({ user }) => { /* … */ return { ok: true } })
```

`app.call: { command: signIn, params: {...}, expect?, as? }` runs it. Right after a launch a command not registered yet is asked again for up to 5 s. Do not register inside `if (__DEV__)`: FastSim runs a release bundle and would miss them; outside it they are inert in production builds.

## `app.relaunch`

Starts the app again as a fresh case finds it: terminated and launched on a Simulator or emulator, a host the run started is started again, any other host mounts the app again. The case's mocks go with it; set them after. A case that starts with a view the app did not draw over it (a system prompt the case before left) is relaunched before its first step, and its result says so.

## `on:` blocks

Steps only one kind of target needs:

```yaml
  - on: device        # or headless, ios, android, has:<command>, !device …
    do:
      - app.press: "#close-native-sheet"
```

## Macros and interruptions

`cases.macros` in `lynkeus.config.json` names a step and the steps it stands for; a case calls it as one step (`- app.signedIn: { user: u }`). Steps several cases open with belong in one: `case coverage` suggests it.

```json
"macros": {
  "app.signedIn": [
    { "app.call": { "command": "signIn", "params": { "user": "{{param.user}}" } } },
    { "when": "wait", "do": { "app.wait": "{{param.wait}}" } },
    { "on": "device", "do": [{ "app.press": { "target": "#dismiss-banner", "optional": true } }] }
  ]
}
```

`when` runs a block only if the case passed that parameter (or `"x=value"`), `unless` the opposite, `on` keeps it to one target; `do` is one step or a list.

`cases.interruptions` names what may get in the way of any step (a lock screen, a consent sheet) and how to get past it: `{ "see": "#unlock-keypad", "do": ["app.unlock"], "unless": "keypad" }`.

## Mocks

`app.mock: { route: "GET /v1/feed", status: 500, body: {...} }` answers in place of the server; `lost: true` lets the server act and loses the answer. Each case starts with no mocks. A mocked request reads `(mocked)` in the evidence: the case's doing, never the backend's. A rule no request matched is a warning naming what the app asked for instead. For a loading state: `app.mock: { route, hold: true }`, the steps that look, then `app.mock: { release: true }`; a held request is not waited for (idle and frames go on) and is reported as held. `{ clear: true }` drops the rules.

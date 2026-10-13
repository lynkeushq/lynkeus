---
title: Analytics events
description: Record the analytics events your app sends during a test, assert on them in a case, and check that a funnel still exists.
---

Analytics break silently. An event is renamed, a property changes from a number to a string, a screen stops reporting, and nobody notices until a dashboard has been flat for a week. A test that already walks the signup flow can also check that the flow still reports what the dashboard reads.

This guide shows how to make the app's events visible to lynkeus, how to assert on them in a case, and how to check a **funnel**: an ordered list of events with the properties each one needs.

## Before you start

- The agent is mounted in the app. See [Install in a React Native app](/getting-started/installation-react-native/).
- You know where your app reports to its analytics: usually one function that every screen calls.

## Step 1: Tell lynkeus about each event

Call `qa.event` from the place where the app reports to its analytics.

```ts title="src/analytics.ts"
import { qa } from 'lynkeus-agent';

export const track = (name: string, props?: Record<string, unknown>) => {
  qa.event(name, props);
  analyticsSdk.track(name, props); // your own SDK, unchanged
};
```

`qa.event(name, props)` records the event in two places: the agent's trace, in order with routes, requests and touches, and a buffer that holds the most recent 500 events.

An app that already keeps its own buffer of events can register a command named `events` with `qa.register`. It replaces the default one.

## Step 2: Look at what the app recorded

Use the app for a moment, then ask:

```bash
npx lynkeus events
```

You should see one line per event, oldest first, each with its properties:

```text
signup_started {"source":"home","step":1}
signup_completed {"method":"email"}
```

`--name <regex>` keeps only the events whose name matches. This command reads the buffer and leaves it as it is.

If you see `(none)`, the app has not called `qa.event` yet. Check that the call sits on the path your screens actually use.

## Step 3: Assert on events in a case

Two steps work with events.

`app.events: clear` empties the buffer, so what follows counts only the events of this case.

`app.event` asserts that an event was sent. Give it a name, or a name and the properties it must carry.

```md title="cases/signup-events.md"
---
id: signup-events
title: "Signing up reports the funnel"
---
steps:
  - app.events: clear
  - app.press: "#signup-button"
  - app.event: { name: signup_started, props: { source: home } }
  - app.type: { text: "ana{{random.digits}}@example.com", target: "#email-input", submit: true }
  - app.wait: Home.Main
  - app.event: signup_completed
  - app.event: { name: signup_abandoned, absent: true }
```

A property matches when its value, read as text, equals the one you wrote. Properties you do not name are ignored. `absent: true` asserts that no such event was sent.

Like `app.see`, the step waits up to 3 seconds for the event before it fails (`timeoutMs` changes that). A failure reads `no signup_started event with {"source":"home"}`.

You can also put an event inside a wider assertion: `app.see: { route: Home.Main, event: signup_completed }` requires both at once.

## Step 4: Keep the events of every step

To review events rather than assert on each one, keep them with the run.

For cases, any run with `--out` files each event under the step that caused it:

```bash
npx lynkeus case run --out run
```

Each step in `run/cases.jsonl` then has an `events` list, with the name, the properties and the route the app was on. The hosted report shows them next to each step. See [Reports](/guides/reports/).

`--events <dir>` writes the same events per case, as `<dir>/<case id>/events.jsonl`, without the rest of the run directory.

For a flow, `run --events` does the same:

```bash
npx lynkeus run flows/signup.json --events
npx lynkeus events --run last
```

You should see each event with the step and route it happened on:

```text
 2 Onboarding.Start  signup_started {"source":"home","step":1}
 5 Home.Main  signup_completed {"method":"email"}
```

`run --events` empties the app's buffer as it goes. The events are kept as `events.jsonl` in the run's folder under `.lynkeus/runs/`.

## Step 5: Describe a funnel

A funnel file is the contract between the app and a dashboard: these events, in this order, with these properties.

```json title=".lynkeus/funnels/signup.json"
{
  "steps": [
    { "event": "signup_started", "props": { "source": "string", "step": "number" } },
    { "event": "signup_completed", "props": { "method": "email" } }
  ]
}
```

A property is written one of two ways. `"string"`, `"number"` or `"boolean"` names the type the dashboard needs. Any other value is one the dashboard filters on, and must match exactly.

## Step 6: Check the funnel against a run

```bash
npx lynkeus run flows/signup.json --events
npx lynkeus funnel check signup --run last
```

You should see every step of the funnel marked:

```text
✓ signup
  ✓ 1 signup_started  (step 2)
  ✓ 2 signup_completed  (step 5)
```

When the contract is broken, the line says how, and the command exits with code 1:

```text
✗ signup
  ✓ 1 signup_started  (step 2)
  ✗ 2 signup_completed  (step 5)  — method is "phone", the funnel filters on "email"
```

The possible problems are `never happened`, `happened, but before the step it should follow`, a property that `is missing`, and a property of the wrong type (`step is string, the funnel needs number`).

`--run` takes a run folder or `last`, which is the default. The folder `case run --events <dir>` wrote for a case, `<dir>/<case id>`, is a run folder too, so a funnel can be checked against a case as well as a flow.

## Compare two builds

`events diff` compares the events of the same flow on two builds and lists what was added, lost or reshaped.

```bash
npx lynkeus events diff .lynkeus/runs/<main run> last
```

```text
+ signup_method_chosen
- signup_started
~ signup_completed: +plan, step number→string
```

A lost or reshaped event exits with code 1. An added one does not. This is the check to run on a pull request: a change that breaks a dashboard says so before anyone looks at the dashboard.

## See which funnel steps your tests cover

```bash
npx lynkeus funnel report
```

```text
signup
  ✓ signup_started  3 run(s)
  ✗ signup_completed  no run produces it
```

`funnel report` reads the recorded runs (the last 50; `--last <n>` changes that) and says which funnel steps some run produces and which none does. This is coverage of analytics, not conversion: a scripted run always converts.

## How it works

`qa.event` keeps the event inside the app. Nothing is sent anywhere. The driver reads the buffer through the app's `events` command, the same way it reads the screen.

During a case run with `--out` or `--events`, the runner reads the buffer after every app step and assigns the new events to that step. It never empties the buffer, because the case may be asserting on it.

The run file can also carry events with a `provider`: what an analytics SDK itself was asked to send, as opposed to what the app told `qa.event`. Those are recorded only on a host that captures SDK calls.

## Common problems

**`(none)` from `lynkeus events`.** No `qa.event` call has run since the app started, or the buffer was emptied by `app.events: clear` or `run --events`.

**`no events recorded for that run (run a flow with --events)`.** The run was made without `--events`, or `last` points at a different run than you expect. Pass the run's folder.

**`no funnel signup: write .lynkeus/funnels/signup.json`.** The funnel file does not exist under that name.

**An `app.event` assertion passes because of an earlier case.** The buffer holds events from before this case. Start the case with `app.events: clear`, or reset the app in its setup.

**A property comparison fails on a number.** In `app.event`, values are compared as text, so `step: 1` matches `1`. In a funnel file, write `"number"` to require the type, or the exact value to require that value.

## Next steps

- [Reports](/guides/reports/): events next to each step, in a page.
- [Writing cases](/guides/writing-cases/): the rest of the case format.
- [Agent API reference](/reference/agent-api/): `qa.event`, `qa.register` and `qa.observe`.

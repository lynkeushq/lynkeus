---
title: Reports
description: Keep a run as a directory with screenshots and video, and push it to the hosted service as a report your team can open.
---

A terminal summary is enough while you write a test. A team needs more: what each step looked like, which step failed and why, and a link to send. A **report** is one run of your cases kept in that form.

There are two parts. The open-source CLI writes a run to a directory on your machine. The hosted service at [lynkeus.io](https://lynkeus.io) turns that directory into a page anyone with the link can open. The first part works on its own. The second is the paid service, which has a free plan.

## Before you start

- You have cases that run. See [Writing cases](/guides/writing-cases/).
- For screenshots: a host that can take them. A simulator or an emulator can. The headless host renders nothing to capture.
- For the hosted report: an API key from lynkeus.io.

## Step 1: Write the run to a directory

```bash
npx lynkeus case run --out run --screenshots
```

`--out <dir>` writes the run as a directory. `--screenshots` adds a frame of the screen after every app step. Both `--screenshots` and `--video` need `--out`, since that is where they keep what they take.

You should see the usual output in the terminal, and afterward this on disk:

```text
run/
  run.json          when it started and ended, what the app ran on, the totals
  cases.jsonl       one line per attempt of a case, in the order they ran
  login/            one folder per case
    01-app-press-next-button.png
    01-app-press-next-button.json
    …
  login.2/          the second attempt, when the case was retried
```

Each screenshot has a `.json` file beside it with the screen's structure at that moment.

Add `--video` to film each case, where the host can film. Each step then records the second of the video at which it began. `--video-fps <n>` sets the frame rate (30 by default).

:::note
`--video` films a case only where the host offers a `record` command, which the host names in `hello` (`lynkeus hello` lists it). The built-in headless host draws nothing, and a simulator or emulator session offers no such command, so on those a run keeps its screenshots and has no video. The flag is not an error there: the case runs and is not filmed.
:::

## Step 2: Read the run directory

You do not need the hosted service to use a run. The directory is a documented format that a script or a dashboard of your own can read.

`run.json` is the manifest:

```json title="run/run.json"
{
  "schema": 1,
  "startedAt": "2026-10-12T09:14:03.120Z",
  "git": { "commit": "4f2a9c1", "branch": "feature/checkout" },
  "finishedAt": "2026-10-12T09:16:41.007Z",
  "platform": "ios",
  "native": true,
  "totals": { "cases": 12, "passed": 11, "failed": 1, "unsupported": 0, "retried": 2 }
}
```

`native` says whether the app ran on a device or simulator (`true`) or was hosted without one. `git` is present when the run was made from a git checkout. `totals` counts each case by its last attempt.

Each line of `cases.jsonl` is one attempt of one case. It carries the case's `id`, `title`, `description` and `file`, the `attempt` (1, or 2 for the second chance), the `result`, when it started, how long it took, and its `steps`.

Each step says:

| Field | Meaning |
|---|---|
| `step` | The step as text |
| `section` | `setup` or `steps` |
| `status` | `passed`, `failed`, `skipped` or `unsupported` |
| `ms` | How long it took |
| `error` | Why it failed, when it did |
| `events` | The analytics events the app sent while it ran |
| `screenshot` | The frame after it, relative to the run directory |
| `videoS` | The second of the video at which it began |
| `backend` | What the backend did for it, with `--traces` |

A failed attempt also keeps its `evidence` (the screen at the failure, the last requests, and why) and a `diagnosis`.

The TypeScript types are `RunManifest`, `RunCase`, `RunStep` and `RunEvent` in the `lynkeus-protocol` package, with the schema number in `RUN_SCHEMA`. Fields are only ever added. A change to what an existing field means raises the schema number, and a reader should refuse a schema it does not know.

:::note
`run.json` is written when the run starts and again when it ends. A run that was cut short has no `finishedAt` and no `totals`.
:::

## Step 3: Get a key for the hosted service

1. Sign in at lynkeus.io with Google or GitHub. You get an organization of your own, or join the one that invited you.
2. Under **API keys**, create a key. It is shown once.
3. Export the key. The CLI talks to `https://lynkeus.io` unless `LYNKEUS_REPORTS_URL` names another service:

```bash
export LYNKEUS_REPORTS_KEY=lk_…
```

## Step 4: Push the run

Add `--push` to upload the run when it ends:

```bash
npx lynkeus case run --out run --screenshots --push
```

You should see the report's address at the end of the summary:

```text
11/12 passed
report: https://lynkeus.io/r/…
newly failing (1): checkout-declined-card
```

The lines after the address compare this run to the one before it: `newly failing (n): …` and `fixed since the run before (n): …`. They appear only when there is something to say.

A run you already have on disk goes up with `report push`:

```bash
npx lynkeus report push run --project myapp
```

`--project <name>` is the project the run is filed under. It defaults to the name of the app's folder.

`--push` checks for the key before the run starts, so a missing key stops the command at once instead of after every case has run. If the upload itself fails, the run still counts: the summary says `the report was not uploaded: …` and the exit code reflects the cases.

## What the hosted report shows

- Each case, with its steps and how each one ended.
- The screenshot after each step, and the video in step with the steps where one was recorded. Since 0.5.0 a host that can (fastsim on a Mac) writes the screenshots as AVIF, about a fifth of a PNG's size; `--frames png` keeps PNG, for frames you compare pixel for pixel.
- What the case is about: its `description`, `why`, `given`, `ticket` and `expected`.
- The analytics events each step sent, with the service they went to (over 40 services: Mixpanel, Amplitude, Segment, PostHog, RudderStack, Firebase and Google Analytics, Meta, TikTok, AppsFlyer, Adjust, Branch, Braze, Iterable, Customer.io, MoEngage, OneSignal, Intercom, Sentry, Datadog, New Relic, Bugsnag, Embrace, Instabug, FullStory, LogRocket, Smartlook, Hotjar, Heap, Pendo, mParticle, Statsig, LaunchDarkly and others). See [Analytics events](/guides/analytics-events/).
- The requests each step sent, with their headers and bodies, and what came back. Secrets in them (passwords, codes, tokens, card numbers, `Authorization` and cookies) are replaced by `…`, and a body is cut at 16 KB. Since 0.5.0, for any run made with `--out`.
- Why a failed case failed, with only the nearby requests that got a server error or no answer.
- What the backend did for each step, when the run used `--traces`: each request with what the app sent and got back, and the jobs and calls out it set off. Database queries are never kept or shown, since their statements name your tables. See [Backend traces](/guides/backend-traces/).
- The events your backend sent to its own analytics, marked BACKEND, when `cases.serverEvents` names a fixture that reads them. See [Configuration](/reference/configuration/#casesserverevents).
- The branch and commit the run was made from, linked to the repository; what commit the project's run before was on, with a link to compare the two; and the files the run had with changes no commit has.

### Finding your way in a report

- The cases list names each case by its `title`, with its id under it. Fold it to a rail of status dots with its button or `[`.
- Tabs narrow what each step shows: All, Steps, Events, Network and Backend, each with a count. A filter (built in, yours or your team's) and **Edit rules** choose the rest.
- The search box filters steps, events, properties and services as you type; `/` focuses it. A pill per service shows or hides its events, and a switch shows the SDK calls (`setAttribute`, `identify`, `updateUser`…) that are hidden by default.
- **Events map** lays out which service heard what in each step, a row per step and a column per service: a step that should have told a service something and did not shows as a gap. A cell opens that step with only that service.
- The timeline under the film has a dot per service above each step that sent to it.

The report's address contains a token of its own that cannot be guessed. Anyone with the link can open it.

## List reports from the terminal

```bash
npx lynkeus report list                              # the organization's latest reports
npx lynkeus report history checkout-declined-card    # how one case came out, run by run
npx lynkeus report flakes --project myapp            # cases that do not always pass at the first try (Team)
```

`report list` prints one line per run: when it started, its project and platform, how many cases passed, and the report's address. `--limit <n>` sets how many (20 by default, at most 100).

`report history` and `report flakes` are explained in [Flaky tests](/guides/flaky-tests/).

## Plans and retention

| | Free | Team |
|---|---|---|
| Projects | 1 | Unlimited |
| History kept | 7 days | 90 days |
| Screenshot per step | Yes | Yes |
| Video | No | Yes |
| Events per step | Yes | Yes |
| Flaky-test trends | No | Yes |

Each day, a scheduled job deletes the runs that are older than their plan keeps, with their files.

On the Free plan a video is refused at upload. The rest of the run is kept, and the command says which files were left out:

```text
report: https://lynkeus.io/r/… (not kept on this plan: login/video.mp4)
```

See your plan, or change it:

```bash
npx lynkeus report plan             # the organization's plan and what it keeps
npx lynkeus report plan --upgrade   # prints the Stripe checkout address for Team
npx lynkeus report plan --manage    # prints the Stripe portal: card, invoices, canceling
```

## How it works

`report push` sends the run in four stages: it creates the run from `run.json`, sends `cases.jsonl`, uploads every screenshot and video the cases name, and marks the run finished. The service answers the last stage with the report's address and the comparison to the previous run.

The run directory is the only thing the service reads. It does not connect to your app, your simulator or your backend.

## Common problems

**`--screenshots and --video keep what they take in the run directory: add --out <dir>`.** Add `--out`.

**`--push uploads the run directory: add --out <dir>`.** Same cause.

**`set LYNKEUS_REPORTS_KEY to an API key of your organization (lynkeus.io, API keys); LYNKEUS_REPORTS_URL names another service`.** The key is not set in this shell.

**``run: no cases.jsonl; pass the directory `case run --out` wrote``.** `report push` was given a directory that is not a run.

**The run has no screenshots.** The host takes none. The headless host renders nothing to capture; use a simulator or an emulator for runs that need pictures.

**The run has no video.** A case is filmed only where the host offers a `record` command; run `npx lynkeus hello` and look for `record` among its `commands`. The built-in headless host and a simulator or emulator session offer none, so a run there keeps its screenshots and no video. The case does not fail because of it.

## Next steps

- [Running on CI](/guides/ci/): push a report from every pull request.
- [Flaky tests](/guides/flaky-tests/): read the history of a case.
- [Backend traces](/guides/backend-traces/): add the backend's side to each step.
- [Security](/security/): what the hosted service keeps.

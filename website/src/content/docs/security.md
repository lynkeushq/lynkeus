---
title: Security
description: What the lynkeus agent exposes and to whom, why it exists only in debug builds, what the token protects, and what the hosted report service stores and for how long.
---

lynkeus puts code inside your app that lets another process read the screen and press things. That is a capability worth understanding before you adopt it. This page describes exactly what is exposed, to whom, and what keeps it out of the builds your users get. It then covers the hosted report service: what a pushed run contains, who can read it, and when it is deleted.

It is written for the lead who decides whether to adopt lynkeus, and for the developer who has to configure it safely.

## The short version

- The agent runs in debug builds only. In a release build the native code that synthesizes touches is not compiled in, and the JavaScript that talks to the driver is never loaded.
- The app dials **out** to the local machine. Nothing listens inside the app, and nothing is reachable from the network.
- With a token, the app serves only the driver that knows the secret.
- The headless host refuses to start without a token, and refuses a backend that is not local.
- Nothing leaves your machine unless you push a run to the report service. What you push is deleted after 7 days on the Free plan and 90 days on the Team plan.

## What the agent can do

Once a driver is attached, it can do everything the [protocol](/reference/protocol/) describes:

- Read the screen: every element React rendered, with its `testID`, text, value and position.
- Press, type and swipe, as a user would.
- Navigate to any route and open deep links.
- Read the app's recent HTTP requests: method, URL, status and duration.
- Read the trace: routes, requests, store changes and analytics events.
- Run any command the app registered with `qa.register`, and read any store it exposed with `qa.observe`.

That is the same reach as a person holding the phone with a debugger attached. The sections below are about making sure only your own tests have it.

### What the agent does not record

The agent limits what it reads in three places.

| Data | What is kept |
|---|---|
| Inputs with `secureTextEntry` | The value is masked with `•`. A password never appears in a screen listing. |
| HTTP requests | Method, URL, status and duration only. Headers and bodies are never recorded. In the URL, the values of query parameters whose name ends with `token`, `key`, `secret`, `code`, `otp`, `password`, `pin`, `session` or `auth` are replaced with `…`. |
| Store changes in the trace | Which top-level keys changed. An object is reduced to its number of keys and an array to its length, so payloads do not land in the trace. |

Two things are not reduced, and you control both:

- The `stores` command returns the state of a store you passed to `qa.observe`. Observe a store only if a test may read it.
- The properties you pass to `qa.event` are recorded as given.

## Debug builds only

The agent is built so that it cannot run in a release build, at two levels.

**Native code.** The part that synthesizes touches is compiled per build.

- On iOS it is wrapped in `#if DEBUG`. The symbols do not exist in a release binary. This matters for more than safety: touch synthesis uses private UIKit API, the technique KIF and Detox rely on, and it must never reach App Store review.
- On Android the module checks the application's `FLAG_DEBUGGABLE` flag and refuses every call unless the app is debuggable.

**JavaScript.** `enabled` defaults to `__DEV__`. When it is false, `auto()` returns at once and `<Lynkeus>` never loads the code that opens the connection.

### Gate `enabled` on your environment

A debug build is not always a safe build. A debug build pointed at your production backend, with real accounts, should not run the agent.

```js title="index.js"
import { auto } from 'lynkeus-agent/auto';

auto({
  token: process.env.LYNKEUS_TOKEN,
  enabled: __DEV__ && config.ENV !== 'prod',
});
```

:::caution
Never set `enabled` to `true` unconditionally. The default, `__DEV__`, is the least you should keep.
:::

## The connection

The direction of the connection is the main protection. The app is the client: it dials the driver. The driver is the server.

| | |
|---|---|
| Where the app dials | `localhost` on iOS. `10.0.2.2`, the emulator's address for the host machine, on Android. |
| Where the driver listens | `127.0.0.1`: the loopback interface, not the network. |
| What listens inside the app | Nothing. |

So another device on the same Wi-Fi cannot reach the agent: there is no port to connect to. What remains is other software on the same machine, which could listen on the port the app dials. That is what the token is for.

## The token

The **token** is a secret shared by the app and its driver. When the app is mounted with one, the driver must present the same value as its first message. Until it does, the app answers every request with `unauthenticated` and serves nothing.

```js
auto({ token: process.env.LYNKEUS_TOKEN });
```

```bash
export LYNKEUS_TOKEN=<the same value>
lynkeus screen
```

Without a token, the app serves whatever process is listening on the port it dials. On a developer's own machine that may be acceptable. Set a token wherever the app can reach anything that matters: a shared staging backend, a CI runner that runs other jobs.

Treat the token like any other secret:

- Do not commit it. Keep it in your environment, and in CI in the CI's secret store.
- Use one per machine or per pipeline rather than one for everybody.
- It is compiled into the debug build that reads it, so do not reuse a secret that protects something else.

In an Expo app the app reads the token from `EXPO_PUBLIC_LYNKEUS_TOKEN`, because Expo only inlines variables with that prefix. The value ends up in the bundle of your development build, which is the same exposure as any other build-time token.

## The headless host

The headless host runs your app's JavaScript in Node, usually against a real backend. Because nothing about it is tied to a simulator on a developer's desk, it has stricter defaults.

- **It refuses to start without a token.** `lynkeus headless start` stops with an error unless `LYNKEUS_TOKEN` is set.
- **It refuses hosts that are not local.** With `network: 'real'`, the host lets the app reach only the hosts in `networkHosts`, which defaults to loopback. A request to anything else is refused at once.
- **It checks the API address before the app renders.** The entry that `lynkeus headless init` writes reads the variable named by `apiEnv` (default `API_URL`) and throws unless it points at `localhost`, `127.0.0.1` or `10.0.2.2`.

An automated test pointed at production by accident is exactly what the last two prevent. If you edit the generated entry, keep the guard.

## Tests that act on their own

Two commands press things without a script: `smoke` and `crawl`.

`crawl` is read-only by default. Every press happens, but the moment one makes the app write (a `POST`, `PUT`, `PATCH` or `DELETE`), the crawl reports it, stops exploring past it and never presses that control again. `--press-anything` turns that off and is for a disposable environment only.

lynkeus ships no list of dangerous controls, because which controls are irreversible depends on your app. List yours under `crawl.never` in `lynkeus.config.json`. See [Configuration](/reference/configuration/#smoke-and-crawl).

## What stays on your machine

Everything lynkeus learns is written as files under `.lynkeus/` in the app's folder: the graph, recorded screens, snapshots, run artifacts. No server is involved. A run goes somewhere else only when you ask for it, with `case run --push` or `report push`.

Run directories and `.lynkeus/runs/` can hold screenshots and screen listings of your app. Decide deliberately whether to commit them or upload them as CI artifacts.

## The hosted report service

The report service at [lynkeus.io](https://lynkeus.io) is optional and separate from the open-source tool. It stores runs you push so that your team can open them as a report.

### What a pushed run contains

`lynkeus report push` and `case run --push` upload the run directory that `case run --out` wrote:

| File | Contains |
|---|---|
| `run.json` | When the run started and ended, the platform, the git branch and commit, the totals. |
| `cases.jsonl` | For each case: its id, title, description and file path, and each step as the case words it, with its result, duration and error. |
| Frames | A screenshot after each app step, when you ran with `--screenshots`. |
| Films | A video of each case, when you ran with `--video`. |

A line of `cases.jsonl` can also carry:

- The analytics events each step caused, with their properties.
- For a failed case, its evidence: the screen listing at the failure, the last requests (status, method and URL) and the diagnosis.
- With `--traces`, what your backend did for each step: the spans it exported, with their attributes, such as a route, a status, a table or a job class.

The service also records the project name you push under.

:::caution
A report shows what your app showed. If a test logs in as a real person, that person's name and data are in the screenshots. Run tests against test data: in CI, run the backend the job tests, seeded for tests, so that no production data is involved.
:::

Step text is stored as it is written in the case file. A password written out in an `app.type` step is part of that text, while a reference such as `{{u.password}}` is stored as the reference. Use throwaway credentials in cases, and pass them by reference.

### Who can read a report

| Access | Who |
|---|---|
| The report's link | Anyone who has it. The link contains a token that is the run's own and cannot be guessed, and opening it does not require signing in. Share it as you would share the report itself. |
| The dashboard and the list of runs | Members of your organization, signed in with Google or GitHub. |
| The API | Whoever holds one of your organization's API keys. |
| AI clients over MCP | A client a member connected and approved, signed in as that member. It can only read. A member can disconnect it under **Members**. |

### API keys

A key identifies your organization to the API. `LYNKEUS_REPORTS_KEY` holds it.

- A key is shown once, when you create it. The service stores only a hash of it, so it cannot show it to you again.
- Create one key per pipeline, so that you can revoke one without stopping the others.
- In CI, keep it in the CI's secret store.

### How long a run is kept

| Plan | Runs and frames | Films |
|---|---|---|
| Free | 7 days | Not kept. The upload leaves them out and says so. |
| Team | 90 days | 90 days |

A job runs every day and deletes the runs older than the plan keeps, together with their files. Deletion is by the run's age, counted from when it was pushed.

### Payment

Subscriptions are handled by Stripe. `lynkeus report plan --upgrade` prints Stripe's checkout address and `--manage` prints Stripe's portal, where the card, the invoices and canceling live.

## A checklist

Before you rely on lynkeus in a team:

1. `enabled` is gated on `__DEV__` and on your environment.
2. A token is set in CI and on any machine that reaches a shared backend.
3. The token and the report key are in secret stores, not in the repository.
4. Tests run against test data, with throwaway credentials.
5. `crawl.never` lists the controls a crawl must not press.
6. The headless entry still has its local-backend guard.

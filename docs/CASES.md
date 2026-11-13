# Cases

Cases a person can read, run against the app. The format and the runner are
lynkeus'; what a user is, how this app logs in and how its backend is prepared
are the project's, declared in `lynkeus.config.json`.

```sh
npx lynkeus case init                 # an example case, this reference, a fixtures server to start from
npx lynkeus case run                  # every case under cases.dir
npx lynkeus case run cases/gift.md --host   # one case, hosting the app in Node for the run
npx lynkeus case run --report out.jsonl     # one JSON line per case, for CI
npx lynkeus case run --out run/            # the run as a directory a report can read
```

A case is a markdown file: frontmatter that names it, then `setup`, `steps`
and `expected`. `lynkeus case run cases/example.md` runs one; without files
it runs every case in this folder. A step that fails stops the case, and the
report carries the screen, the requests and the reason.

## Steps that drive the app

| Step | Value | |
|---|---|---|
| `app.press` | target, or `{ target, within?, nth?, optional?, hold?, timeoutMs? }` | Waits for the control to be there and enabled. `optional` presses only if it is on screen. |
| `app.type` | `{ text, target?, submit?, clear?, timeoutMs? }` | `target` is tapped first, once it is there (`timeoutMs` is how long that may take); `submit` ends with the return key. |
| `app.swipe` | `{ direction, target?, distance? }` or `{ from, to }` | |
| `app.wait` | route, target, ms, `{ target, scroll? }` or `{ request, status? }` | `scroll` swipes until the target is in the window. A `request` is `METHOD /path`. |
| `app.see` | target, or `{ testId?, text?, route?, request?, event?, layer?, absent?, timeoutMs? }` | An assertion on what the app shows or did. Everything named must hold. |
| `app.nav` | route, or `{ route, params }` | A teleport, for getting to where the case starts. |
| `app.back` | | |
| `app.requests` | `mark` | A `request` counts only what the app asked for after the step before it began; this marks further back, until a step has looked for a request. |
| `app.call` | `{ command, params?, expect?, as? }` | A command the app registered with `qa.register`. |
| `app.run` | `{ flow, vars? }` | A lynkeus flow, from the flows folder. |
| `app.events` / `app.event` | `clear` / `{ name, props?, absent? }` | What the app told its analytics. |
| `app.<command>` | its arguments by name | Any other lynkeus command: `app.mock`, `app.network`, `app.appstate`, `app.deeplink`… |

```yaml
  - app.mock: { route: "POST /v3/transfers", lost: true, times: 1 }   # the server gets it and acts; the app never hears back
  - app.mock: { route: "GET /v3/accounts", status: 500 }
```

A request a mock answered (or whose answer it lost) is marked `mocked`: a failed
case's evidence says `(mocked)` after it, and its reasons never blame the
backend for the 500 the case asked for.

A target is `#testId`, a text, an index or `x,y`. Where a step takes `target` it also takes `testId`. A text inside quotes of its own (`'"Next"'`) is always a text, where `app.wait: Next` would wait for a route called `Next`.

One case runs on a host and on a device. What only one of them needs — closing a
native screen the host never shows — is kept to it; everywhere else it is
skipped:

```yaml
  - on: device        # or headless, ios, android, has:<command>; ! in front turns it around
    do:
      - app.press: "364,84"
```

On a device, a swipe is followed by a wait for the screen to stop moving, since
a pager keeps going after the finger lifts and swallows a swipe sent into that
momentum. A swipe on a target keeps the whole drag inside the window.

A case that should run over several inputs says so in its frontmatter, and runs
once per combination, named after it (`signup[locale=fr,login=phone]`):

```yaml
matrix: { locale: [en, fr], login: [phone, email] }
```

`{{matrix.locale}}` anywhere in the file is that run's value.

Cases run side by side (`case run --jobs N`) share one backend. A case that
changes what every case sees, such as a global feature flag or a setting for all
users, says so in its frontmatter and runs alone: it waits for the cases in
flight to end, and no other starts until it has ended. Its setup is never made
ahead (`--ahead`), since that may be what changes the shared state.

```yaml
exclusive: true
```

On a device, and on a host that lists only what its window shows, `app.see`
and `app.press` look further down the page by themselves: a short wait in case
the target is arriving, a scroll in case it is below the fold (never one that
would drag a sheet shut), and a longer wait in case a carousel is about to show
it. Only then does the step's deadline count.

## Steps that prepare and read the backend

Any other step name is a **fixture**: lynkeus sends it to the command in
`cases.fixtures` (lynkeus.config.json) as one JSON line and reads one back.

```
→ {"command": "create_user", "params": {"name": "Ana"}, "env": {"NAME": "Ana"}}
← {"ok": true, "user_id": "u_1", "name": "Ana"}
```

`as: u` keeps the answer; `{{u.user_id}}` reads it later. `assert` calls
the `inspect` fixture and checks one path of its answer with `equals`,
`includes`, `gte`, `lte`, `near`, `matches`, `present` or `absent`.
`exec: { run: "…", as? }` runs a shell command and keeps its JSON output.

Before the first case lynkeus asks the fixtures command what it answers
(`{"command": "lynkeus.describe"}`). A server that replies with
`{"commands": ["create_user", …]}` has every case checked against that list,
and a case naming a fixture that is not on it is refused before anything runs,
instead of failing halfway with the backend already changed. A server that
replies `"ok": false` is not checked. The whole contract, with descriptions a server can give of
each command, is [FIXTURES.md](FIXTURES.md).

## Steps of your own

`cases.macros` names a step and the steps it stands for. Inside,
`{{param.x}}` is what the case passed, and a parameter that names an alias
is that alias.

```json
"macros": {
  "app.login": [
    { "app.call": { "command": "reset" } },
    { "app.deeplink": "myapp://dev-login?user={{param.as.user_id}}" },
    { "when": "wait", "do": { "app.wait": "{{param.wait}}" } }
  ]
}
```

`when` runs a step only if the case passed that parameter (`"when": "wait"`)
or passed that value (`"when": "method=phone"`); `unless` is the opposite.

`cases.interruptions` names what the app may put in the way of any step — a
lock screen, a consent sheet — and the steps that get past it:

```json
"interruptions": [{ "see": "#unlock-keypad", "do": ["app.unlock"], "unless": "keypad" }]
```

It runs before a press, a type, a swipe or a see finds it there; a step whose
own words match `unless` is about it, and is left alone.

Cases and fixtures often live in a repository of their own: `LYNKEUS_CONFIG`
names a second configuration file, read over the app's, and the paths under
its `cases` are relative to it.

`{{random.letters}}` and `{{random.digits}}` are new on every run. With
`LYNKEUS_SEED` set to anything, each case draws the same ones every time, and
different ones from the case beside it: what comparing two runs' screens needs.

## Several cases at once

```sh
npx lynkeus case run --jobs 4 --ports 8201,8202,8203,8204 --host-command 'LYNKEUS_PORT={port} npx lynkeus headless start'
```

`--jobs N` runs N cases side by side, each job on a host of its own that dials the
job's port from `--ports`; `--host-command` starts a fresh host for every case
and stops it after (`{port}` is where it dials, `{job}` the job). The longest
cases, from the ledger `--flakes` keeps, go first so the jobs end together;
`--in-order` keeps the order given. With `--keep-hosts`, each job's host starts
once and serves the job's cases; it starts again before a case when it exited,
its app stopped answering or its heap is past `--host-heap` percent, so a host
that dies takes one case with it, not every case after. `--host-timeout` is how
long a host may take to attach (600000 ms: it builds the app first). `--ahead N` makes up to N setups while other
cases run (`case prepare` does the same into `--prepared`), and only starts one
while `--idle` of the CPU is free. A case that is `exclusive` waits for the others
(above). `lynkeus ci` does all of this from the config, with `--keep-hosts`;
its first port is `LYNKEUS_PORT`, else `port` in the config, else 8123, and
`--keep-up` leaves only the backend up (the hosts end with the run).

## Coverage and impact

```sh
npx lynkeus case coverage                              # screens touched, untouched, and names the app lost
npx lynkeus case coverage --route Pay.Main             # the cases that touch one screen
npx lynkeus case run $(npx lynkeus case impact --files)   # only the cases a branch's changes reach
npx lynkeus case new pay-limits --to Pay.Main --write     # a draft to finish: the way there and the setup to pick
```

`case new` begins at `--from`, or at `cases.start` in the config. It never chooses the setup: it lists, commented out,
what the project's fixtures server describes ([FIXTURES.md](FIXTURES.md)), and the author keeps what the case needs.

A case touches a screen it goes to (`app.nav`), waits for (`app.wait`) or checks (`app.see: { route }`), and every
screen a passing run went through when `case run --seen .lynkeus/seen` kept them. The screens come from the route
graph (`lynkeus map build`); `case impact` finds what a diff reaches as `map check` does.

## In CI

`lynkeus ci` is a suite run the way a CI job wants one: the project's backend brought up by the project's own
command, N hosts of the app, the cases spread across them, the report uploaded, a summary for the job, and
everything torn down, failure or not. lynkeus knows no backend; the config says how to start one:

```json
"ci": {
  "backend": { "up": "../qa-tools/ci/env.sh up", "down": "../qa-tools/ci/env.sh down", "ready": "http://127.0.0.1:3100/up" },
  "hosts": { "count": 4 },
  "push": true
}
```

`ci.hosts.command` starts a host other than headless (`{port}` is where it dials), `ci.run` adds `case run` flags as on the
command line, and `ci.backend.timeoutMs` and `ci.hosts.timeoutMs` bound how long each takes to come up.

```yaml
- run: npx lynkeus ci --affected --base origin/main   # only the cases this pull request's changes reach
```

## Configuration

```json
"cases": {
  "dir": "cases",
  "flows": "flows",
  "fixtures": { "command": "node cases/fixtures.mjs", "cwd": ".", "timeoutMs": 120000 },
  "inspect": "inspect",
  "refs": { "user": "user_id" },
  "macros": {}
}
```

`refs` says which parameters point at what an earlier step made: with
`"user": "user_id"`, `user: u` reaches the fixture as `user_id`, read from what
`as: u` kept, and a step that names no user gets the latest one. The fixtures
command is started once per run, in `cwd`, and can be anything that reads a
line and writes a line: a Node script, a Rails runner, a container.

The other keys under `cases`: `start` (the screen `case new` begins on),
`interruptions` and `macros` (above), `serverEvents` (`{ fixture, provider? }`:
the fixture is asked after each app step with `{ since }` and answers
`{ events: [{ name, props, provider? }] }`, the backend's own analytics),
`appEvents` (`{ provider }`: the service the app's own events go to, so a report
names it instead of "App") and `nativeMocks` ([HEADLESS.md](HEADLESS.md)). The
defaults are `dir: "cases"`, `flows: "flows"` and `inspect: "inspect"`.

## What a run leaves

A failed case runs once more before it counts as failed (`--once` turns that
off), and one that passes the second time is reported as passed on retry. A
failed step leaves the screen as it was, the requests the app had made and,
for a step on a target, why: covered, hidden behind a layer, disabled, gone.

A step the host has no way to do (`os clock` on a simulator, a command
the app does not register in this build) is `unsupported`, not failed: the case
stops there, counts as one that cannot run on this host, and does not fail the
run. The same case then passes where the host can do it.

`--out <dir>` writes the run as a directory that a report, a dashboard or a
script can read without knowing how the run was made:

```
run.json         when it started and ended, what the app ran on, the totals
cases.jsonl      one line per attempt of a case, in the order they ran
progress.ndjson  where the run is, an event per line, written as it goes
```

A line of `cases.jsonl` carries the case's id, title, description and file, the
attempt (1, or 2 for the second chance), the result, when it started, how long
it took, and its steps. Each step says which part of the case it is (`setup` or
`steps`), whether it passed, failed, was skipped or is unsupported on this host, how long it took, its error, and the events the
app sent to its analytics while it ran. A failed attempt keeps its evidence.

A long case can number its parts with a comment over the step that opens each one
(`# 3 A wrong PIN`, or `# 3b …`); every step after it, up to the next one, carries
that `heading`, and a report groups the steps by it. Any other comment is a note.

### What the backend did

`--traces` shows, under each step, what the backend did for it: every request
the app sent while the step ran, and the queries, jobs and calls out each one
set off. It uses OpenTelemetry, so any backend that can export traces works and
lynkeus needs to know nothing about it:

1. The run listens for OTLP over HTTP on `localhost:4318` (`--traces-port`).
2. Each app step gets its own span id, and the host puts it in the W3C
   `traceparent` header of every request the app sends during the step.
3. The backend, with its OpenTelemetry SDK on and
   `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`, continues that trace
   and exports what it did. Jobs carry the trace on when their instrumentation
   propagates it (ActiveJob, Sidekiq and Celery's do).
4. When the case ends, every span whose chain of parents reaches a step is
   kept under that step in `cases.jsonl` (`backend`), the request first and
   what it set off indented under it.

The agent puts the header on the app's requests itself (its `traceContext`
command), so this works on a simulator, an emulator or a device as well as on
fastsim; an app with an agent older than this release goes untraced. A
backend's spans that no step's request caused, such as a scheduler's, are left
out. Turn
the backend's exporter on only for test runs: it costs a little on every
request.

### Following a long run

A run says where it is as it goes, in `progress.ndjson` (in the `--out`
directory; without one, in `.lynkeus/last-run.progress.ndjson`; a `--dry-run`
writes none). Every event has `type` and `at`, an ISO time:

```
{"type":"run-start","pid":4121,"total":52,"jobs":4,"cases":[{"id":"login-sign-in-pin","title":"Sign in with a PIN","expectedMs":81993}, …]}
{"type":"report","url":"https://…"}
{"type":"case-start","id":"login-sign-in-pin","job":0,"attempt":1,"steps":176,"host":"port 8201"}
{"type":"step","id":"login-sign-in-pin","job":0,"index":87,"steps":176,"section":"steps","heading":"4 A forgotten PIN","step":"app.press #security-forgot-passcode-button"}
{"type":"step","id":"login-sign-in-pin","job":0,"index":87,"steps":176,"section":"steps","heading":"4 A forgotten PIN","step":"app.press #security-forgot-passcode-button","status":"passed","ms":412}
{"type":"case-end","id":"login-sign-in-pin","job":0,"attempt":1,"result":"passed","ms":81122}
{"type":"run-end","passed":50,"failed":2,"unsupported":0,"ms":1520400}
```

- `run-start` comes first and names every case in the order the jobs take
  them, with `expectedMs`, how long it took when it last passed (from the
  ledger `--flakes` keeps), where known. A reader of the file needs nothing
  else to work out the time left. `pid` is the run's process.
- `report` comes with `--push`, once the report exists (and `run-end` carries
  `report` too).
- `case-start` names the `job`, the `attempt` and the `host` it runs on.
  `case-end` of a failed first attempt has `retrying: true`.
- A `step` event comes when the step starts and again, with its `status` and
  `ms`, when it ends. `index` counts from 0 over the steps the case runs
  (`steps` of them), `section` says whether it is in `setup` or `steps`, and
  `heading` is the numbered comment above it (`# 4 A forgotten PIN`); a step
  before the first one has none.

`--progress json` also writes the events to stdout, one per line, and the run's
summary to stderr. Over MCP the events go to the caller as progress
notifications instead.

In a terminal (stderr is a TTY and `CI` is not set) the run keeps a status line
under its output: cases done and failed, the time spent and the time left, and
what each job is running and in which section. The time left comes from
`expectedMs`, else from how long this run's own cases took. `--progress none`
leaves the line out; `--progress json` replaces it.

`lynkeus case status [dir]` reads the file from another terminal, during the run
or after it: `dir` is the run's `--out`, or its `progress.ndjson`; without one,
the last run of this project (`.lynkeus/last-run.json` points at it). `--json`
gives the same as an object. A run whose process is gone without a `run-end` is
reported as `stopped`. An MCP client calls the `case_status` tool, and hears
`case_run`'s progress as MCP progress notifications when it passes a progress
token. With `--push` the report is made when the run starts and fills case by
case, so its address works from the first case; a send that fails is tried again
at the end. A reports service from before this gets the whole run at the end.

### A host that dies

With `--host` (or `--keep-hosts`, per job: below), the run owns the host. When it died during a case (out of
memory, a crash) or its app stopped answering, the case that lost it still
fails, and its reasons say how the host ended, with its last words and its log;
the next case starts on a host started again, which writes a log of its own.
Before each case the run also asks the host how full its heap is (one line in
the log) and starts it again past `--host-heap` percent of its limit
(`heapLimitMb`, 60 percent unless told), so a case does not begin on a host
about to run out. Without this, every case after a crash failed with "No app
attached". With `--host-command` alone, each case gets a fresh host anyway.

### A run with everything

A report shows, under each step, a frame, the second of the film, every
request with its headers and bodies, the analytics events and what the backend
did. What turns each on:

| In the report | How |
| --- | --- |
| Frames | `--out <dir> --screenshots` (AVIF; `--frames png` only to compare pixels) |
| Film | `--video`, on a host that films: fastsim. A simulator, an emulator and headless keep frames only. |
| Requests and responses | `--out`: the agent keeps them while a run keeps evidence |
| The app's analytics and SDK calls | `--out`. What is seen depends on the host: Mixpanel, AppsFlyer, Firebase Analytics and Crashlytics, Sentry, Datadog and Intercom everywhere (the agent wraps their modules, in development builds only); the other SDKs in [HEADLESS.md](HEADLESS.md) on fastsim and headless, which stand in for their modules; an SDK written in JavaScript (Segment, Amplitude, PostHog, RudderStack…) everywhere, by the requests it sends. A native SDK not wrapped on a simulator or an emulator sends from native code and is not seen there. |
| What the app printed | `--out`: the agent keeps its console and uncaught errors, with their stacks, under the step that printed them |
| The backend's analytics | `cases.serverEvents` in the config |
| What the backend did | `--traces` (above) |
| A link to share | `--push`, with `LYNKEUS_REPORTS_KEY` in the environment |

A run that kept evidence and saw no analytics event from the app, or was asked
for a film and kept none, says so when it ends.

### Frames two runs are compared by

A frame is taken once the app stops committing (`--settle <ms>`, 150 by default).
A simulator's or an emulator's own transitions, and a host's animations on its own
clock, keep moving after the app is quiet; `--still <ms>` takes the frame again
until two in a row are the same, that many ms apart, and the frame's JSON says
whether it stopped (`still`). For frames compared pixel by pixel across two runs
or two hosts: `--screenshots --frames png --settle 700 --still 300`. A screen that
moves on by itself (a success screen that prints, then leaves) is still caught at
another moment on each side.

The types are `RunManifest`, `RunCase`, `RunStep` and `RunEvent` in
`lynkeus-protocol`, with `RUN_SCHEMA` in `run.json`. A field is only ever
added; a change to what an existing field means raises the schema, and a
reader should refuse a schema it does not know. `run.json` is written when the
run starts and again when it ends, so a run that was cut short has no
`finishedAt` and no `totals`.

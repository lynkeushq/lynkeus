# Cases

Cases a person can read, run against the app. The format and the runner are
Lynkeus'; what a user is, how this app logs in and how its backend is prepared
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
report carries the screen, the requests and the reason. An optional `teardown`
list puts back what the case changed outside the app; it runs after the steps,
passed or failed, and a teardown step that fails leaves the result as it was
and is named in it.

## Steps that drive the app

| Step | Value | |
|---|---|---|
| `app.press` | target, or `{ target, within?, nth?, optional?, hold?, timeoutMs? }` | Waits for the control to be there and enabled. `optional` presses only if it is on screen. |
| `app.type` | `{ text, target?, submit?, clear?, timeoutMs? }` | `target` is tapped first, once it is there (`timeoutMs` is how long that may take); `submit` ends with the return key. |
| `app.swipe` | `{ direction, target?, distance? }` or `{ from, to }` | |
| `app.wait` | route, target, ms, `{ target, scroll?, enabled? }`, `{ anyOf: [target, ...] }` or `{ request, status? }` | `scroll` swipes until the target is in the window. `enabled` waits until the target is there, enabled and taking touches (not inert). `anyOf` accepts the first target present; an item is a string, `{ testId }` or `{ text, nth? }`, and `gone` cannot go with it. A `request` is `METHOD /path`, and a trailing slash on either side does not matter; it is waited for until it answers 2xx unless `status` names another. |
| `app.see` | target, or `{ testId?, text?, contains?, route?, request?, event?, layer?, absent?, timeoutMs? }` | An assertion on what the app shows or did. Everything named must hold. Letter case never matters, so a text drawn in capitals (`textTransform`) is found by the words the source writes, and spaces around a text do not count. A target that is a text matches an element's whole text (a button's label also matches a part of it: as whole words first, then inside a word, and a press that matched by part names the element it pressed, as a warning); `contains: true` finds it inside a longer text, a paragraph say. `{ text }` on its own finds it inside any text. |
| `app.nav` | route, or `{ route, params }` | A teleport, for getting to where the case starts. A screen inside a nested navigator can be named alone (`app.nav: DemoPodcastList`): Lynkeus finds its parents from the path a run last saw it at, else from the route graph. `params: { screen: Inner }` names the nested screen of a navigator route. The step then waits for the screen it lands on; a navigator's own name counts as reached once the focused screen is inside it. |
| `app.back` | | |
| `app.requests` | `mark` | A `request` counts only what the app asked for after the step before it began; this marks further back, until a step has looked for a request. |
| `app.call` | `{ command, params?, expect?, as? }` | A command the app registered: `qa.register('reset', async (params) => { … })`, with `qa` from `lynkeus-agent`. What the function returns is what `expect` and `as` read. Right after the app attached (a launch, a relaunch) a command it has not registered yet is asked for again for up to 5 s; then it fails, naming those it did. |
| `app.relaunch` | | Starts the app again as a fresh case finds it: on a Simulator or emulator the app is terminated and launched, a host the run started (`host_command`) is started again, and any other host mounts the app again. The case's mocks go with it; set them after. |
| `app.run` | `{ flow, vars? }` | A Lynkeus flow, from the flows folder. |
| `app.events` / `app.event` | `clear` / `{ name, props?, absent? }` | What the app told its analytics. |
| `app.<command>` | its arguments by name | Any other Lynkeus command: `app.mock`, `app.network`, `app.appstate`, `app.deeplink`… |

```yaml
  - app.mock: { route: "POST /v3/transfers", lost: true, times: 1 }   # the server gets it and acts; the app never hears back
  - app.mock: { route: "GET /v3/accounts", status: 500 }
```

A request a mock answered (or whose answer it lost) is marked `mocked`: a failed
case's evidence says `(mocked)` after it, and its reasons never blame the
backend for the 500 the case asked for.

Every case starts with no mocks: Lynkeus clears the app's rules and holds before
the first step and again after the last, so a mock never answers for another case
or for the app driven by hand. `app.mock: { clear: true }` drops them in the
middle of a case. A rule no request matched is a warning in the case's result,
with what the app asked the network for instead:
`mock rule GET /v1/feed.json never matched; GET /v1/api.json went to the network`.

A target is `#testId`, a text (a field's placeholder too), an index (`app.press: 7`) or `x,y`. Where a step takes `target` it also takes `testId`. A bare word that starts with a capital is a route: `app.wait: Next` waits for a route called `Next`, and when the app has no such route but `Next` is on screen, the failure says so. A text inside quotes of its own (`'"Next"'`) is always a text.

One case runs on a host and on a device. What only one of them needs — closing a
native screen the host never shows — is kept to it; everywhere else it is
skipped:

```yaml
  - on: device        # or headless, ios, android, has:<command>; ! in front turns it around
    do:
      - app.press: "364,84"
```

A case starts on a Simulator or emulator with nothing in front of the app. When
a view the app did not draw covers it before the first step (iOS's Save Password
prompt after the case before signed in, a permission prompt, an alert left
open), Lynkeus relaunches the app and the case's result says so; if the view is
there again after the relaunch, the launch itself shows it and the case has to
answer it. Within a case, `app.relaunch` does the same on purpose.

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

Any other step name is a **fixture**: Lynkeus sends it to the command in
`cases.fixtures` (lynkeus.config.json) as one JSON line and reads one back.

```
→ {"command": "create_user", "params": {"name": "Ana"}, "env": {"NAME": "Ana"}}
← {"ok": true, "user_id": "u_1", "name": "Ana"}
```

`as: u` keeps the answer; `{{u.user_id}}` reads it later. `assert` calls
the `inspect` fixture and checks one path of its answer with `equals`,
`includes`, `gte`, `lte`, `near`, `matches`, `present` or `absent`.
`exec: { run: "…", as? }` runs a shell command and keeps its JSON output.

Before the first case Lynkeus asks the fixtures command what it answers
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
`{ "on": "headless", "do": [ … ] }` keeps steps to one kind of host, as in a case
(`do` is one step or a list). `case run --dry-run` lists every case's steps with
each macro opened into the ones it stands for.

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

`--seed`, `--locale`, `--time-zone` and `--epoch` (or `launch` in the config) pin
the facts the app would take from the machine. A host the run starts receives
them in its environment (a host `--host-command` starts for a case gets the seed
made the case's own, `<seed>:<case id>`, so `Math.random` in the app draws
differently in each case, as a fresh install would); a run records them as `launch` in `run.json`, and lists
under `launch.unsupported` the ones an attached Simulator or emulator could not
apply. On an attached app that includes the seed: it still makes the case's own
`{{random.*}}` repeatable, but the app's `Math.random` is its own.

## Where a case must pass

Where a case must pass is the project's decision, declared once in `lynkeus.config.json`:

```json
{ "cases": { "targets": ["fastsim:ios", "fastsim:android"] } }
```

The targets are `headless` (the app in Node), `fastsim:ios` and `fastsim:android` (Lynkeus FastSim drawing each
platform), `ios` (the app on the iOS Simulator, or an iPhone) and `android` (the app on the Android emulator, or a
phone). One team with FastSim for both platforms declares those two and nothing else; another declares
`["headless", "ios"]`. A case that needs something only some targets have (a device-only feature) declares its own in
its frontmatter, which replace the project's for that case:

```yaml
---
id: scan-card
targets: [ios, android]
---
```

`--on targets` checks each case on its declared targets, all of them at once, and on nothing else:

```sh
npx lynkeus case run cases/login.md --on targets
```

```text
✅ fastsim:ios      login
❌ fastsim:android  login — step 4/7 app.see #welcome: not on screen: {"testId":"welcome"}
fastsim:ios 1/1 passed · fastsim:android 0/1 passed
```

A declared target this machine cannot run on is named with why, and the check is incomplete: the run fails and its
last line says which targets were not checked (`⚠ check incomplete: fastsim:android (3 case(s)) declared but not
available here…`). A case is done when `--on targets` passes on every target it declares. With no `cases.targets`
(and a case without its own), `--on targets` refuses and asks for them. `lynkeus status` shows the declared targets
and whether each runs here, or proposes a value when there are none (FastSim for each of the app's platforms when it
is installed, else `headless` and the platforms the app builds for, from its `ios` and `android` folders); `lynkeus
init` writes that proposal when the config has none, and says so. Plain `case run` still runs on the attached app,
the fast loop while a case is written.

## On every target

`--on all` runs the cases on every target this machine has instead, and a target it lacks fails nothing:

```sh
npx lynkeus case run cases/login.md --on all
```

```text
✅ ios        login
✅ android    login
❌ headless   login — step 4/7 app.see #welcome: not on screen: {"testId":"welcome"}
○ fastsim:ios not available: not installed: `lynkeus fastsim install --platform ios` (Team plan)
○ fastsim:android not available: not installed: `lynkeus fastsim install --platform android` (Team plan)
ios 1/1 passed · android 1/1 passed · headless 0/1 passed · fastsim:ios not available · fastsim:android not available
a failure's screen and requests: run that target again alone, or with verbose
```

`--on` also takes target names, comma-separated: `headless`, `fastsim:ios`, `fastsim:android`, `ios`, `android`.
`all` is those five. `fastsim` is FastSim on the last bundle, whichever platform it draws. `simulator` is the app attached on the
driver port whichever platform it runs on (`emulator` and `device` name it too, and its line reads `emulator` on
Android), as before there were two. Both device apps dial the same driver port (the Android one through 10.0.2.2, or
`adb reverse` on a phone), and the driver hands each to the connection of its platform by what the app says when it
attaches, so the two run side by side with no rebuild and no port of their own; with only `simulator`, the app that
dialed last is the one driven. Every target that can run here takes the cases at the same time, as `case run` would on
it alone: the device apps on the driver port, headless and FastSim on hosts kept for the run on free ports picked together (`--jobs` gives each of them
that many). Outside `--on targets`, a target this machine lacks is named once with why and fails nothing: no app on a Simulator or emulator is
attached (or the one attached runs on a host; for `ios` and `android`, no Simulator, emulator or phone of that
platform is up, or its app does not attach within 3 s), headless is not set up (`lynkeus headless init`), or FastSim is not
installed, has no bundle or gets no grant. A FastSim target runs `ci.hosts.command` when that starts `fastsim-run` on a bundle
of its platform, else the installed kit's `fastsim-run` on `--bundle` (when it draws that platform), else on that platform's bundle made last under `.lynkeus`
(`<kit>/bin/fastsim-bundle . .lynkeus/fastsim-ios ios`); a bundle older than the app's code is bundled again first.

The answer is one line per case per target, with the failing step and the first line of its error; `--verbose` adds
each failure in full, as a run on one target shows it, and notices a target gave (native values a host did not answer,
the run folder) follow under its name. The run fails when a case fails on any target that ran, or a target could not
start. `--out <dir>` keeps each target's run in `<dir>/<target>` (`<dir>/fastsim-ios` for `fastsim:ios`; `--events` likewise), the hosts keep flake ledgers
of their own (`.lynkeus/flakes.headless.json`, `.lynkeus/flakes.fastsim-ios.json`…), and `case status` and `case stop` see
one run, each case named with its target. `--on` starts each target's hosts itself, so it refuses `--host`,
`--host-command`, `--keep-hosts` and `--ports`.

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
its ports are the free ones from `LYNKEUS_PORT`, else `port` in the config, else
8123, up (one another process listens on, such as a `lynkeus mcp` server, or
another run claims is passed over), and `--keep-up` leaves only the backend up:
every host ends with the run, also when `case run` died or ci got SIGINT or
SIGTERM. With `--host-command`, `case run` refuses a `--ports` entry another
process listens on before any host starts.

## Coverage and impact

```sh
npx lynkeus case coverage                              # screens touched, untouched, and names the app lost
npx lynkeus case coverage --route Pay.Main             # the cases that touch one screen
npx lynkeus case run $(npx lynkeus case impact --files)   # only the cases a branch's changes reach
npx lynkeus case new pay-limits --to Pay.Main --write     # a draft to finish: the way there and the setup to pick
```

`case new` begins at `--from`, else at `cases.start` in the config, else at the screen an attached app shows (in a
session or over MCP), else at the first screen the navigator declares; a comment in the draft says which. Unless
`--from` names it, a start with no known way to the screen gives way to `cases.start`, then the first declared screen,
when the route map knows a way from there, and the comment says so (`no known way from DemoShowroom`). When no case
reaches the screen, the draft lists under its route check, commented out, what is known to be on it: the testIDs its
source writes, short texts runs saw there, and the presses its source has lead on. It never
chooses the setup: one comment names the fixtures the project's server describes ([FIXTURES.md](FIXTURES.md)), and
none while that server is still the example `case init` wrote.

When an existing case already reaches the screen, `case new` offers that case's way there instead of a plan from the
route map: its setup and its steps up to the screen, under a comment that names the case, and with `--from` only the
steps after that screen. A case reaches the screen when its last passing run was on it after a step, or when a step
goes to it, waits for it or checks it. The shortest way wins, and one a passing run walked wins a tie. Nothing is
rewritten: the draft is the author's to keep or change.

A case touches a screen it goes to (`app.nav`), waits for (`app.wait`) or checks (`app.see: { route }`), in its own
steps or in a macro it calls (through macros that call macros, with the `{{param.*}}` it passes), and every screen a
passing run went through. Without `.lynkeus/seen` (a fresh CI checkout) the steps and macros are all there is. A
route bound to a navigator (its component declares other routes, as a tab navigator nested under `Demo` does) is not
counted as a screen: coverage leaves it out of both counts and names it on a line of its own, and `case impact` never
lists it as reached and touched by no case. Its screens are counted instead. `case run` keeps those in `.lynkeus/seen/<case id>.json` (or in `--seen <dir>`):
the screens of the case, and the screen the app was on after each step, read off trace marks the steps take anyway.
The screens come from the route graph (`lynkeus map build`); `case impact` finds what a diff reaches as `map check`
does. A change to the file that registers the app or to the root
component it registers reaches every screen, so every case is listed, with that file as the reason.

A change to a string table is narrowed to what it changes. A file whose top level is only object literals of strings
(nested or not, with imports, types and spreads of other tables allowed) is read as one by its shape, whatever its name;
its strings at the base are compared with its strings now. It then reaches the files that name a changed key
(`tx="settings:title"`, `t('settings.title')`, a key path, `strings.settings.title`, or a key built from a literal
prefix such as `` t(`settings.${name}`) ``) and the cases whose steps name the changed string's old or new text,
not every screen that imports it. When a changed key is named nowhere by its whole key (a hook bound to a prefix, a
key built at runtime), every importer counts as before and a line names the key.

A file whose change is only the values of `testID`, `nativeID`, `accessibilityLabel` or `aria-label` (string
literals or templates, as JSX props or object properties), or only comments and formatting, reaches no screen
through imports. A renamed or removed testID reaches the cases whose steps name it, old or new (`#id`, `#id[2]`, a
`testId` field, or a macro the case calls that names it; a template's `${…}` matches any text). A changed label
reaches the cases that name its old or new text. Any other change in the file, even a testID now read from a
variable, keeps every screen that imports it, and other changed files still reach theirs. The comparison prints both
versions without comments or formatting, so swapped testIDs count as changed.

When three or more case files open their setup or their steps with the same app steps (two at least; key order,
spacing and `timeoutMs` aside), `case coverage` ends with one hint: the cases, how many steps, and the entry to put
under `cases.macros` so each case says them in one step. It names a macro already declared with those steps instead.

## In CI

`lynkeus ci` is a suite run the way a CI job wants one: the project's backend brought up by the project's own
command, N hosts of the app, the cases spread across them, the report uploaded, a summary for the job, and
everything torn down, failure or not. Lynkeus knows no backend; the config says how to start one:

```json
"ci": {
  "backend": { "up": "../qa-tools/ci/env.sh up", "down": "../qa-tools/ci/env.sh down", "ready": "http://127.0.0.1:3100/up" },
  "hosts": { "count": 4 },
  "push": true
}
```

`ci.hosts.command` starts a host other than headless (`{port}` is where it dials), `ci.run` adds `case run` flags as on the
command line, and `ci.backend.timeoutMs` and `ci.hosts.timeoutMs` bound how long each takes to come up.

With `cases.targets` declared, the job runs each case on its declared targets a CI job can start: `headless` and
`fastsim:ios` / `fastsim:android`, one target after another (each brings up its `hosts.count` hosts, so two targets
never double a runner's memory), each in `<out>/<target>` when there are several, and the summary links each target's
report. A FastSim target runs `ci.hosts.command` when that is `fastsim-run` on a bundle of its platform, else the
installed kit on that platform's last bundle; a `ci.hosts.command` that starts no FastSim is the project's own
headless host. `ios` and `android` need a device and are listed as not run. A declared FastSim target the job cannot
start (no kit, no bundle) fails it as an incomplete check. Without `cases.targets`, the job runs every case on
`ci.hosts.command`, or headless, as before.

```yaml
- run: npx lynkeus ci --affected --base origin/main   # only the cases this pull request's changes reach
```

## Configuration

```json
"cases": {
  "dir": "cases",
  "targets": ["headless", "ios"],
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

`targets` is where a case must pass (above). The other keys under `cases`: `start` (the screen `case new` begins on),
`interruptions` and `macros` (above), `serverEvents` (`{ fixture, provider? }`:
the fixture is asked after each app step with `{ since }` and answers
`{ events: [{ name, props, provider? }] }`, the backend's own analytics),
`appEvents` (`{ provider }`: the service the app's own events go to, so a report
names it instead of "App") and `nativeMocks` ([HEADLESS.md](HEADLESS.md): what a native SDK answers, and the
values of native constants the host does not know). The
defaults are `dir: "cases"`, `flows: "flows"` and `inspect: "inspect"`.

## What a run leaves

A failed case runs once more before it counts as failed (`--once` turns that
off), and one that passes the second time is reported as passed on retry. A
failed step leaves the screen as it was, the requests the app had made and,
for a step on a target, why: covered, hidden behind a layer, disabled, gone.

What a run answers is short, since an agent reads it after every run: a passing
case is one line, and a failed one names its step (`failed at step 4 of 6`), the
step's error, the screen at the failure cut to what a check can name (rows of a
list counted, not repeated; testIDs and controls before texts; twenty lines), the
requests that failed, never answered or were mocked, and why. A notice the last
run in the same process gave word for word (the native values a host did not
answer) is one line. `--verbose` (`verbose` over MCP) answers with all of it;
`cases.jsonl`, `--report` and `--json` always keep everything. What the run
noticed without changing a case's result (a teardown step that failed, a mock
rule nothing matched, a relaunch before the first step) follows the case's line
with ⚠, and is `warnings` in `cases.jsonl`.

The summary calls a case flaky when its recent runs (the ledger `--flakes` keeps)
disagree. A run of another version of the case does not count: the history
starts again when its steps, or a macro they call, change. Nor does a failure
that reproduced, failing again on its second chance or failing the same step
with the same error in another run: that is a break, not a flake. Runs are only
compared with runs on the same target (`ios`, `android`, `fastsim:ios`, `host:android`,
from what the app said when it attached) and of the same app source (the commit plus
the working tree's diff, leaving out the cases and `.lynkeus/`): a case that fails from
the moment the app changed is broken, not flaky. A case whose app never attached (the
driver's port taken, no app running) did not run and is not recorded.

A failed `app.see`, or `app.wait` for a target, also keeps under its step in
`cases.jsonl` a `looked` object: `listing`, every element of the screen at the
failure as `lynkeus screen --all` lists them (off the window, hidden with its
reason, covered; the first 150); `scrolls`, the first 20 scrolls the step made
(`direction`, `atMs` into the step, whether the content `moved`, and the first
and last element listed `before` and `after`) with `scrollsTotal`; and `target`,
whether it was ever in the element tree (`found`), its `last` state and how its
state changed (`seen`). The error says the same in a few words: `(found, below
the window, after 2 scrolls)` or `(never in the tree, after 2 scrolls)`. A step
that passes keeps none of it.

A step the host has no way to do (`os clock` on a simulator, a command
the app does not register in this build) is `unsupported`, not failed: the case
stops there, counts as one that cannot run on this host, and does not fail the
run. The same case then passes where the host can do it.

`--out <dir>` writes the run as a directory that a report, a dashboard or a
script can read without knowing how the run was made:

```
run.json         when it started and ended, what the app ran on, the launch facts, the totals
cases.jsonl      one line per attempt of a case, in the order they ran
progress.ndjson  where the run is, an event per line, written as it goes
```

A line of `cases.jsonl` carries the case's id, title, description and file, the
attempt (1, or 2 for the second chance), the result, when it started, how long
it took, and its steps. Each step says which part of the case it is (`setup` or
`steps`), whether it passed, failed, was skipped or is unsupported on this host, how long it took, its error, and the events the
app sent to its analytics while it ran. `phases` splits a step's time by what it
waited on (`marks`, `target`, `action`, `settle`, `wait`, `look`, `events`; see
`RunStepPhase` in lynkeus-protocol), so a step over 500 ms can be explained; the
console writes them after such a step. A failed attempt keeps its evidence.

A long case can number its parts with a comment over the step that opens each one
(`# 3 A wrong PIN`, or `# 3b …`); every step after it, up to the next one, carries
that `heading`, and a report groups the steps by it. Any other comment is a note.

### What the backend did

`--traces` shows, under each step, what the backend did for it: every request
the app sent while the step ran, and the queries, jobs and calls out each one
set off. It uses OpenTelemetry, so any backend that can export traces works and
Lynkeus needs to know nothing about it:

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
Lynkeus FastSim; an app with an agent older than this release goes untraced. A
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
| A page to open offline | `report.html`, written beside every `--out` run; `lynkeus report html <dir> [--embed]` writes it again |
| Film | `--video`: FastSim films itself; an iOS Simulator films through `simctl io recordVideo` and an Android emulator or phone through `screenrecord` (3 minutes at most). Headless keeps frames only. |
| Requests and responses | `--out`: the agent keeps them while a run keeps evidence |
| The app's analytics and SDK calls | `--out`. What is seen depends on the host: Mixpanel, AppsFlyer, Firebase Analytics and Crashlytics, Sentry, Datadog and Intercom everywhere (the agent wraps their modules, in development builds only); the other SDKs in [HEADLESS.md](HEADLESS.md) on FastSim and headless, which stand in for their modules; an SDK written in JavaScript (Segment, Amplitude, PostHog, RudderStack…) everywhere, by the requests it sends. A native SDK not wrapped on a simulator or an emulator sends from native code and is not seen there. |
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
or two hosts: `--screenshots --frames png --settle 700 --still 300` (over MCP,
`case_run` with `frames`, `settle` and `still`). A screen that
moves on by itself (a success screen that prints, then leaves) is still caught at
another moment on each side.

The types are `RunManifest`, `RunCase`, `RunStep` and `RunEvent` in
`lynkeus-protocol`, with `RUN_SCHEMA` in `run.json`. A field is only ever
added; a change to what an existing field means raises the schema, and a
reader should refuse a schema it does not know. `run.json` is written when the
run starts and again when it ends, so a run that was cut short has no
`finishedAt` and no `totals`.

---
title: Running on CI
description: What a CI job needs to run lynkeus cases, which host to choose, and how to push a report from every pull request.
---

Tests earn their keep when they run on every change without anyone asking. This guide explains what a CI job needs in order to run your cases, how to choose where the app runs, and how to leave a report on each pull request.

lynkeus does not ship a ready-made action for running cases. A job runs the same commands you run locally. The one workflow lynkeus writes for you, `map ci`, is covered at the end: it needs no app at all.

## What every job needs

Whatever the host, a job that runs cases needs five things.

1. **Node and your dependencies.** The CLI and the headless host need Node 22 or newer. Install the project's packages as usual; `lynkeus` and `lynkeus-agent` are among them.
2. **The app, running somewhere.** Either hosted in Node by the headless host, or as a debug build on a simulator or an emulator. The next section helps you choose.
3. **A shared token.** `LYNKEUS_TOKEN` must hold the same value for the app and for the CLI. In a job that builds or hosts the app itself, any value works, as long as both sides read the same one. An app that passes a token and receives an empty one keeps its agent off, so a job that forgets the variable on the app's side fails to attach rather than run unprotected.
4. **A backend to talk to.** The app under test makes real requests. Run the backend the job tests, with its database and cache, seeded for tests. No shared environment is needed, and no production data is involved.
5. **A fixtures command, if your cases use fixtures.** It is started by `case run` from `cases.fixtures` in `lynkeus.config.json`, so it must be runnable in the job. See [Fixtures](/guides/fixtures/).

The job's result is the exit code of `case run`: 0 when no case failed, 1 otherwise. A case that cannot run on the chosen host is reported as `unsupported` and does not fail the job.

## Choose a host

The **host** is where the app runs during the test. The same cases run on all of them.

| | Headless host | Simulator or emulator |
|---|---|---|
| What runs | The app's JavaScript in Node, native modules mocked | The real debug build |
| Needs | Node, a Linux container is enough | A machine that can run the simulator or emulator, and a build of the app |
| Start time | About 40 seconds | A build, an install and a boot |
| Screenshots and pixel snapshots | No | Yes |
| Contrast in `lint` | No | Yes |
| Camera, push delivery, WebView content, native gestures, native crashes | No (mocked or absent) | Yes |
| Parallel runs | One host per port, scales with cores | One host per port |

The two are not exclusive. One way to split the work is to run the suite on the headless host for every pull request, and the cases that need the native layer on a simulator or an emulator. Steps that only one side needs go under `on: device` or `on: headless` in the case, so the suite stays one set of files.

For what each host can and cannot do, see [Headless](/platforms/headless/), [iOS](/platforms/ios/) and [Android](/platforms/android/).

## Run on the headless host

This is the job with the fewest moving parts: no simulator, no build.

### Before the first run

Set up the headless host locally and commit the result. See [Headless](/platforms/headless/).

```bash
npx lynkeus headless init --auto     # writes the headless entry, mounts the agent
npx lynkeus headless doctor          # lists native modules that still need a mock
LYNKEUS_TOKEN=secret npx lynkeus case run --host
```

When that passes on your machine, the job is the same command.

### The command

```bash
npx lynkeus case run --host --out run
```

`--host` starts `lynkeus headless start` for the run and stops it afterward. `--out run` writes the run as a directory, which you can keep as a build artifact or push as a report.

You should see `host: up` once the app is hosted, then each case. If the host has not come up within 180 seconds, the command stops with `the host did not come up within 180 s` followed by the last lines of its output.

### A plain workflow

This GitHub Actions workflow runs the documented commands and nothing else. Adapt the backend steps to your project.

```yaml title=".github/workflows/lynkeus.yml"
name: lynkeus
on: pull_request

jobs:
  cases:
    runs-on: ubuntu-latest
    env:
      LYNKEUS_TOKEN: ci-token
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci

      # Start the backend this job tests, seeded for tests, on localhost.
      # - run: docker compose up -d --wait

      - run: npx lynkeus case run --host --out run --report run/report.jsonl

      - if: always()
        uses: actions/upload-artifact@v4
        with:
          name: lynkeus-run
          path: run
```

`--report <file>` appends one JSON line per case, for a script that reads results.

:::caution
The headless host refuses to reach any network host other than `127.0.0.1` and `localhost` unless you list more in `networkHosts`. That guard exists so an automated run is never pointed at production by accident. In the job, publish the backend on localhost.
:::

### Run cases in parallel

Each job in `case run --jobs` needs its own host on its own port. `LYNKEUS_PORT` moves a host and its driver together, so start one host per port and give the ports to the run:

```bash
LYNKEUS_PORT=8123 npx lynkeus headless start &
LYNKEUS_PORT=8124 npx lynkeus headless start &
LYNKEUS_PORT=8125 npx lynkeus headless start &

npx lynkeus case run --jobs 3 --ports 8123,8124,8125 --out run
```

The longest cases start first, so the jobs finish together. Hosts scale with the machine's cores.

A long-lived host grows: Node's heap gains a few dozen MB per full app reset. A runner that drives hundreds of cases on one host should restart it when `npx lynkeus call memory` reports too much.

## Run on a simulator or an emulator

Use this for what the headless host cannot show: screenshots, contrast, and anything native. The device here is a simulator or an emulator; physical devices are not supported.

The job has more to prepare, and those steps are your platform's, not lynkeus's:

1. Build the **debug** build of the app, with the agent enabled. lynkeus does not work in a release build: the code that synthesizes touches is not compiled into one.
2. Give the app the token the job will use. In a React Native CLI app the token is written into the development bundle by the `lynkeus-agent/babel` plugin, so start Metro with `LYNKEUS_TOKEN` set in its environment. In an Expo app, start the development server with `EXPO_PUBLIC_LYNKEUS_TOKEN` set to the same value.
3. Boot the simulator or emulator, install the app and launch it.
4. Run the cases.

```bash
npx lynkeus launch com.example.myapp --clean --attach-timeout 60000
npx lynkeus case run --out run --screenshots
```

`launch` relaunches the app, by its bundle id or application id, and waits for the agent to connect. With `--clean` it also runs the app's `reset` command. When it returns, the app is attached and the cases can start.

Three global flags are useful here. `--app <bundleId>` names the app for commands that launch it. `--device <udid|name>` picks a simulator. `--attach-timeout <ms>` gives the app longer to connect than the default 15 seconds. All three can live in `lynkeus.config.json` as `app`, `device` and `attachTimeout`.

How the app reaches the CLI differs by platform:

- On the iOS simulator, the app dials `localhost:8123`.
- On the Android emulator, the app dials `10.0.2.2:8123`, the emulator's address for the machine that runs it.

Nothing listens inside the app. It dials out and retries every 1.5 seconds, so the order in which the app and the CLI start does not matter.

## Push a report from CI

A report gives each run a page with its steps, screenshots and failures. See [Reports](/guides/reports/) for the service and its plans.

Store the organization's API key as a secret and add `--push`:

```yaml
- run: npx lynkeus case run --host --out run --push
  env:
    LYNKEUS_REPORTS_URL: https://lynkeus.io
    LYNKEUS_REPORTS_KEY: ${{ secrets.LYNKEUS_REPORTS_KEY }}
```

The step prints the report's link, and which cases broke or were fixed since the run before. The run records the branch and the commit it was made from, read from the checkout and from GitHub's own variables.

On a simulator or an emulator, add `--screenshots` to keep a frame after every step. `--video` films each case only where the host offers a `record` command, which it names in `hello`; the built-in headless host and a simulator or emulator session offer none, so a run there has screenshots and no video. Where a video is recorded, it is kept on the Team plan.

### Comment on the pull request

To leave the link on the pull request, keep the output and post the lines that matter:

```yaml
- run: npx lynkeus case run --host --out run --push | tee lynkeus.log
  shell: bash
- if: always() && github.event_name == 'pull_request'
  run: gh pr comment ${{ github.event.pull_request.number }} --body "$(grep -E '^(report:|newly failing|fixed since)' lynkeus.log)"
  env:
    GH_TOKEN: ${{ github.token }}
```

`if: always()` matters: the comment is most useful when the cases failed.

:::note
With `| tee`, the step's exit code is `tee`'s unless the shell runs with `pipefail`. In GitHub Actions, `shell: bash` on the step turns it on. Without it, the step passes when cases fail.
:::

## Add backend traces

If the backend can export OpenTelemetry traces, add `--traces` and start the backend with its exporter pointed at the run:

```yaml
- run: npx lynkeus case run --host --out run --traces --push
```

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 <your backend start command>
```

Each step of the report then lists the requests the app sent and what the backend did for them. See [Backend traces](/guides/backend-traces/).

## Checks that need no app: `map ci`

One check runs on every pull request with no app, no device and no backend. `map check` reads the source and names the screens a diff can reach.

```bash
npx lynkeus map ci
```

You should see `wrote .github/workflows/lynkeus-map-check.yml`. On every pull request, that workflow builds the map from the sources, runs `map check` against the base branch, and keeps one comment on the pull request up to date with the screens the diff reaches. The analysis takes well under a second.

`--depth <n>` sets how many imports away the check looks (2 by default). `--force` overwrites an existing workflow file.

Reviewers use the comment to know where to look, and a pipeline can use the same list to decide which cases to run.

## Other checks worth a step

- **Lint against a baseline.** `npx lynkeus lint --baseline <file> --strict` fails when a branch adds a warning to a screen. See [Lint and contrast](/guides/lint-and-contrast/).
- **Tree snapshots.** `npx lynkeus snapshot <name>` exits with code 1 when a screen's structure differs from its baseline, on any host. See [Recording and snapshots](/guides/recording-and-snapshots/).
- **Analytics contracts.** `npx lynkeus funnel check <name>` exits with code 1 when a funnel is broken. See [Analytics events](/guides/analytics-events/).

Each of these acts on the screen the app is showing or on a recorded run, so the job must first bring the app there.

## Common problems

**The run hangs and then fails to attach.** The app never connected. On the headless host, check that `LYNKEUS_TOKEN` is set: `headless start` refuses to run without it. On a simulator or an emulator, check that the build is a debug build, that the agent is enabled for the environment the build targets, that Metro (or Expo's development server) was started with the token variable set, and that the app's token equals the job's `LYNKEUS_TOKEN`. If the app's log says `lynkeus: the app passed a token and it is empty`, the variable did not reach the bundle. Then raise `--attach-timeout`.

**`the host failed to start: …`.** The headless host hit a Jest error; the message ends with the last lines of its output. Run `npx lynkeus headless doctor` locally to see which native modules still need a mock, and `npx lynkeus headless doctor --explain "<first line of the error>"` for a specific error.

**The app never leaves the splash screen under the headless host.** A native module lynkeus does not know, or Node resolving `localhost` to IPv6 while the backend listens on IPv4. Use `127.0.0.1` for the backend's address.

**An environment variable change has no effect under the headless host.** If your Babel configuration inlines environment variables, Jest's transform cache keeps the first value it saw. Remove the cache directory your Jest configuration points at.

**`port 8123 is held by another lynkeus case run`.** Two runs share a machine and a port. Give each run its own `--ports`, or its own `LYNKEUS_PORT`.

**The job passes although cases were not run.** Read the summary line. `3/5 passed, 2 cannot run on this host` means two cases were `unsupported` on this host. They need the other kind of host.

**`set LYNKEUS_REPORTS_URL and LYNKEUS_REPORTS_KEY (the organisation’s API key)`.** The variables are not set for this step. Check that the secret exists and that the step's `env` passes it.

## Next steps

- [Reports](/guides/reports/): what the pushed report shows.
- [Flaky tests](/guides/flaky-tests/): keep one unreliable test from blocking every pull request.
- [Headless](/platforms/headless/): set up and tune the headless host.
- [Environment variables](/reference/environment-variables/): every `LYNKEUS_*` variable.

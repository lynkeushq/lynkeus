---
title: Flaky tests
description: Find the tests that pass and fail without anything changing, measure them, and tell a flaky test from a broken one.
---

A **flaky** test passes sometimes and fails other times with no change to the code. It is worse than a failing test in one way: people learn to rerun it, and then to ignore it. A **broken** test fails every time, because the app or the test is wrong.

The two need different work, so the first job is to tell them apart. lynkeus gives you four tools for that: the automatic retry, a local ledger, the `flake` command, and the history kept by the hosted reports.

## Before you start

- You have cases that run. See [Writing cases](/guides/writing-cases/).
- For the hosted history: runs pushed to lynkeus.io. See [Reports](/guides/reports/). Flaky-test trends are on the Team plan.

## What the retry tells you

`case run` gives every failed case a second chance. A case that fails once runs again before it counts as failed.

```text
▶ checkout-card — Paying with a saved card
  ✅ app.press #pay-button  (104ms)
  ❌ app.wait Checkout.Done  — Timed out …  (10012ms)
❌ FAILED  ✅ 1  ❌ 1  — 10.4s
  retrying checkout-card once
  ✅ app.press #pay-button  (98ms)
  ✅ app.wait Checkout.Done  (2210ms)
✅ PASSED  ✅ 2  — 2.5s
```

The summary then marks it:

```text
✅ checkout-card  ⚠ passed on retry
1/1 passed
```

Read the three outcomes this way:

| Outcome | What it means |
|---|---|
| Passed at the first try | Nothing to do. |
| Passed on retry | The run is green, and the case is a flaky suspect. |
| Failed twice | The run is red. The case is broken, or flaky enough to fail twice in a row. |

The retry keeps a suite usable while a flaky test exists. It does not fix anything, and `⚠ passed on retry` is the signal not to lose.

`--once` turns the second chance off. Use it while you work on one case and want the first failure immediately.

```bash
npx lynkeus case run cases/checkout-card.md --once
```

A case reported as `unsupported` (a step this host cannot do) is not retried, and it is neither flaky nor broken.

## The local ledger

Every `case run` records how each case did in a ledger: a JSON file at `.lynkeus/flakes.json`. For each case it keeps its last 20 outcomes, with the step and error it last failed on.

When a case's recent runs disagree with each other, the summary says so:

```text
⚠ checkout-card is flaky: 3 of its last 12 runs failed or needed a second chance
```

The rule is simple. A case is called flaky when some, but not all, of its recorded runs failed or needed the retry. A case with no bad runs is healthy. A case whose every recorded run was bad is not called flaky either: it is failing consistently, which is a different problem.

`--flakes <file>` puts the ledger somewhere else. The ledger is local to the machine that ran the cases, so on CI it only accumulates if you keep the file between jobs.

The ledger also remembers how long each case took. With `--jobs`, the runner uses that to start the longest cases first.

## Measure a flaky flow with `flake`

Once you suspect a sequence, measure it. `flake` replays a flow a number of times and reports how often it passed, and where it failed.

A **flow** is a JSON file of steps, the format that `lynkeus record` writes and `lynkeus run` replays. See [Recording and snapshots](/guides/recording-and-snapshots/) for how to get one from a session in the app.

```bash
npx lynkeus flake flows/login.json --times 10 --var phone=1124888418
```

You should see one line per run as it goes, then the summary:

```text
login: passed 8/10 (median 6s)
  2× at step 4 (waitFor {"route":"Settings.Main","timeoutMs":10000}): Timed out …
```

`--times <n>` is how many runs (5 by default). `--var <k=v>` supplies a variable the flow needs and can be repeated. The command exits with code 1 unless every run passed.

An intermittent failure has become a number and a step. Read the summary like this:

- **One failure shape.** The same step, the same error, some of the time. That is one flake, and the step tells you where to look.
- **More than one failure shape.** The summary adds: `more than one failure shape: not one flake but several, or a screen that fails in different ways when slow`.
- **No failures.** The summary adds: `no failure in this sample; if it fails elsewhere, the difference is the environment (load, data, a parallel runner)`. Compare the machine where it fails with this one before you look at the test.

:::note
`flake` takes a flow, not a case file. To repeat a case, run `case run --once` on it several times and read the ledger line.
:::

## Find out why it fails

A number says how often. For the cause, use what the failing attempt left behind.

- **The failure's evidence.** A failed case prints the screen at the failure, the last requests and why the step failed. With `--out`, the same evidence is kept per attempt in the run directory, so the failed first attempt of a case that passed on retry is still there to read.
- **`npx lynkeus why`.** Asks why the last step failed: the target is covered or disabled, requests were still in flight, the backend answered 5xx.
- **`npx lynkeus requests`.** If a test waits seconds after an action, it is usually the backend answering. This shows each request with its duration.

Check the waits first. A fixed pause (`app.wait: 2000`) passes when the backend is fast and fails when it is slow. Waiting for the request and the screen themselves removes the guess:

```yaml
# Fragile: assumes the request takes under two seconds
- app.press: "#pay-button"
- app.wait: 2000
- app.see: "#receipt"

# Stable: waits for the request, then for the screen
- app.press: "#pay-button"
- app.wait: { request: "POST /v1/payments" }
- app.wait: Checkout.Done
- app.see: "#receipt"
```

Then check the starting state. A stale cache left by an earlier test is the most common bug between tests. Have each case start from a clean app by calling the app's `reset` command in its setup.

## Flaky or broken, across runs

One machine's ledger is a short memory. When runs are pushed to the hosted service, the history of every case is kept across machines, branches and commits.

List the unreliable cases of a project:

```bash
npx lynkeus report flakes --project myapp
```

```text
myapp: 30 runs
broken   57%  ✗✗✗✗↻✓✓✓  checkout-declined-card  https://lynkeus.io/r/…
flaky    83%  ✓✓↻✓✓✗✓✓  checkout-card  https://lynkeus.io/r/…
```

Each line shows the case's state, how often it passed at the first try, its recent runs newest first, its id, and the last report where it went wrong. The marks are `✓` passed, `↻` passed on a retry, and `✗` failed. The least reliable cases come first.

The service applies one rule to separate the two states: **a case that failed its last three runs is broken rather than flaky.**

`--runs <n>` sets how many of the latest runs to read (30 by default). When nothing is unreliable, the command says `every case passed at the first try in the last 30 runs`.

Then look at one case over time:

```bash
npx lynkeus report history checkout-card --project myapp
```

```text
Paying with a saved card (myapp)
✓  2026-10-12 09:14    2.4s  main @ 4f2a9c1  https://lynkeus.io/r/…
↻  2026-10-11 17:02    2.6s  feature/checkout @ 91be07d  https://lynkeus.io/r/…
✓  2026-10-11 11:40    2.3s  main @ 0c3d5aa  https://lynkeus.io/r/…
```

Each line has the outcome, when the run was made, how long the case took, the branch and commit, and the report to open. `--runs <n>` defaults to 50.

This is the view that tells the two apart. Failures scattered across unrelated commits point to a flaky test. Failures that begin at one commit and continue point to a change that broke it, and the line names the commit.

Both commands need `LYNKEUS_REPORTS_URL` and `LYNKEUS_REPORTS_KEY`. `report flakes` is on the Team plan.

## A routine that works

1. Keep the retry on in CI, so one flaky test does not block every pull request.
2. Treat `⚠ passed on retry` as a finding, not as a pass. Look at `report flakes` regularly.
3. For each suspect, read the evidence of the failed attempt, fix the wait or the leftover state, and confirm with repeated runs.
4. When a case is marked broken, open `report history` and find the commit where it started.

## Common problems

**The ledger never reports anything on CI.** `.lynkeus/flakes.json` is written on the machine that runs the cases. A fresh CI machine starts with no ledger. Keep the file between jobs, or use the hosted history.

**`flake` passes 10 out of 10 and the case still fails on CI.** The difference is the environment. Look at load, data and parallel runs on the CI machine.

**`checkout-card is in none of myapp's recent runs`.** The case id or the project is wrong. The id is the `id` in the case's frontmatter; a case with a `matrix` has ids like `signup[locale=fr,login=phone]`.

## Next steps

- [Reports](/guides/reports/): push runs so their history is kept.
- [Writing cases](/guides/writing-cases/): waits, requests and retries in the case format.
- [Running on CI](/guides/ci/): where flaky tests cost the most.

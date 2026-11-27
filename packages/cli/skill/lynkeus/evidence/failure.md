# Reading a failure: verbose, why, looked, retries, flaky

- A failed case answers with its step, the error, the screen at the failure cut to what a check can name, and the requests that failed, never answered or were mocked. `--verbose` gives all of it.
- `why` reads the screen, the requests and the trace as rules and says why the last step failed; after a missing text it names the closest text on screen and, with uncommitted changes, the line that took it out.
- In `cases.jsonl` a failed `app.see` or `app.wait` keeps a `looked` object: every element at the failure and each scroll it made.
- A failed case runs once more before it counts as failed (`--once` turns that off). A case is flaky only when runs of the same version of it disagree.

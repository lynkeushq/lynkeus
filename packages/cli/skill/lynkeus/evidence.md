# Evidence and reports

A run keeps evidence only with `--out <dir>`; then it writes `run.json` (the run, the launch facts, the totals), `cases.jsonl` (one line per attempt, every step) and `report.html` beside them.

| In the report | How |
|---|---|
| A frame after each step | `--out <dir> --screenshots` (AVIF; `--frames png` only to compare pixels) |
| Film of each case | `--out <dir> --video`: FastSim, a Simulator (`simctl recordVideo`) or an emulator (`screenrecord`); headless has none. Each step says at what second it began. |
| Requests with headers and bodies, the app's console and errors | `--out` |
| The app's analytics events | `--out` (seen for the SDKs the agent wraps, and any SDK written in JavaScript) |
| What the backend did for each step | `--traces`: point the backend's `OTEL_EXPORTER_OTLP_ENDPOINT` at `http://localhost:4318` |
| A link to share | `--push`, with `LYNKEUS_REPORTS_KEY` in the environment |

For a run with everything: `case run --out <dir> --screenshots --video --traces` (and `--push` when there is a key). When the run ends it warns about evidence it could not keep (no film on this host, no analytics seen): pass that on to the person.

## Sharing a run

- `report.html` opens offline in any browser. Its frames and film stay files in the folder: share the folder (a zip, a CI artifact).
- `lynkeus report html <dir> --embed` writes it again as one file with everything inside, to send.
- `--push` uploads the run and prints its address as soon as the run starts; the report fills case by case.

## Reading a failure

A failed case answers with its step, the error, the screen at the failure cut to what a check can name, and the requests that failed, never answered or were mocked. `--verbose` gives all of it. `why` reads the screen, the requests and the trace as rules and says why the last step failed; after a missing text it names the closest text on screen and, with uncommitted changes, the line that took it out. In `cases.jsonl` a failed `app.see` or `app.wait` keeps a `looked` object: every element at the failure and each scroll it made.

A failed case runs once more before it counts as failed (`--once` turns that off). The summary calls a case flaky only when runs of the same version of it disagree.

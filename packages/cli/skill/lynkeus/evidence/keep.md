# Keeping evidence: --out, frames, film, traces, --push

A run keeps evidence only with `--out <dir>`: `run.json` (the run, launch facts, totals), `cases.jsonl` (one line per attempt, every step) and `report.html` beside them.

| In the report | How |
|---|---|
| A frame after each step | `--out <dir> --screenshots` (AVIF; `--frames png` only to compare pixels) |
| Film of each case | `--out <dir> --video`: FastSim, a Simulator (`simctl recordVideo`) or an emulator (`screenrecord`); headless has none. Each step says at what second it began. |
| Requests with headers and bodies, the app's console and errors | `--out` |
| The app's analytics events | `--out` (the SDKs the agent wraps, and any SDK written in JavaScript) |
| What the backend did for each step | `--traces`: point the backend's `OTEL_EXPORTER_OTLP_ENDPOINT` at `http://localhost:4318` |
| A link to share | `--push`, with `LYNKEUS_REPORTS_KEY` in the environment |

Everything: `case run --out <dir> --screenshots --video --traces` (and `--push` with a key). At the end the run warns about evidence it could not keep (no film on this host, no analytics seen): pass that on to the person.

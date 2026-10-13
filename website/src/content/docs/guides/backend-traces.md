---
title: Backend traces
description: Use --traces and OpenTelemetry to see, under each step of a test, the requests the app sent and what the backend did for them.
---

When a step fails, the screen shows half of the story. The other half happened on the server: the request that answered 500, the query that took four seconds, the job that never ran. **Backend traces** put that half under the step that caused it.

lynkeus uses OpenTelemetry for this, the open standard for traces. Any backend that can export traces works, and nothing from lynkeus is installed in the backend. This guide is for whoever runs the backend during tests.

## Before you start

- You have cases that run against a backend you control. See [Writing cases](/guides/writing-cases/).
- Your backend has an OpenTelemetry SDK, or you can add one.
- The agent in the app is from a release that includes trace support. An app with an older agent goes untraced.

## Step 1: Run with `--traces`

```bash
npx lynkeus case run --out run --traces
```

You should see, before the first case:

```text
backend traces: listening on http://localhost:4318 (the backend's OTEL_EXPORTER_OTLP_ENDPOINT)
```

For the length of the run, lynkeus listens for OTLP over HTTP on port 4318. `--traces-port <port>` moves it.

`--out` gives the traces a place to live: they are written into the run directory, under each step.

## Step 2: Point the backend at the run

Start the backend with its OpenTelemetry SDK enabled and its exporter pointed at the run:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 <your backend start command>
```

`OTEL_EXPORTER_OTLP_ENDPOINT` is OpenTelemetry's standard variable, so most SDKs read it without any code. How you enable the SDK depends on your language and framework; follow OpenTelemetry's instructions for yours.

lynkeus accepts both encodings of OTLP over HTTP, protobuf and JSON, on the path `/v1/traces`.

:::caution
Turn the backend's exporter on only for test runs. It costs a little on every request.
:::

## Step 3: Read what the backend did

Run the cases again. Each app step in `run/cases.jsonl` now has a `backend` list:

```json
{
  "step": "app.press #pay-button",
  "status": "passed",
  "ms": 412,
  "section": "steps",
  "backend": [
    { "name": "POST /v1/payments", "kind": "server", "at": 38, "ms": 291.4, "depth": 0, "service": "api",
      "attributes": { "http.request.method": "POST", "http.route": "/v1/payments", "http.response.status_code": 201 } },
    { "name": "SELECT accounts", "kind": "client", "at": 44, "ms": 3.1, "depth": 1, "service": "api",
      "attributes": { "db.system": "postgresql" } },
    { "name": "ChargeJob", "kind": "consumer", "at": 120, "ms": 180.2, "depth": 1, "service": "worker" }
  ]
}
```

Each entry is one span, which is OpenTelemetry's word for one unit of work: a request served, a query, a call to another service, a job.

| Field | Meaning |
|---|---|
| `name` | The span's name, as the backend's instrumentation gave it |
| `kind` | `server`, `client`, `internal`, `producer` or `consumer` |
| `at` | Milliseconds after the step began |
| `ms` | How long it took |
| `depth` | How far below the request it sits: 0 is the request itself |
| `service` | The service that reported it |
| `error` | The error message, when the span failed |
| `attributes` | What it did: method, route, status, database statement, and similar |

The request comes first, and what it set off is indented under it by `depth`. Not every attribute is kept, only the ones that say what the span did: HTTP method, route and status, database system and statement, messaging and RPC details, the exception message.

In the hosted report, each step lists the requests the app sent while it ran, and under each one the queries, jobs and calls out it set off. See [Reports](/guides/reports/).

## How it works

1. The run listens for OTLP over HTTP on `localhost:4318`.
2. Each app step gets its own span id. The agent puts it in the W3C `traceparent` header of every request the app sends during that step.
3. The backend continues that trace, as any OpenTelemetry SDK does when it receives a `traceparent` header, and exports what it did to the run.
4. When the case ends, lynkeus waits a moment for the backend's last batch. Every span whose chain of parents reaches a step is kept under that step.

Three consequences follow from this design.

**It works on every host.** The agent sets the header itself, so tracing works on a simulator, an emulator or a device.

**Background jobs are included when their instrumentation propagates the trace.** The instrumentations of ActiveJob, Sidekiq and Celery do.

**Unrelated work is left out.** Spans that no step's request caused, such as a scheduler polling, are not in the report.

A step that sets off a very large number of spans keeps the first 400. A report is not a profiler.

## Common problems

**`--traces could not listen on port 4318: …`.** Another process holds the port, often a local OpenTelemetry collector. Pass `--traces-port <port>` and point the backend's endpoint at the same port.

**No step has a `backend` list.** Work through these in order:

1. The backend is not exporting. Check that its OpenTelemetry SDK is enabled and that `OTEL_EXPORTER_OTLP_ENDPOINT` is set in the process that serves requests, not only in your shell.
2. The backend exports somewhere else. The endpoint must be the run's address and port.
3. The backend runs where `localhost` is not your machine, for example in a container. The run listens on the loopback interface (`127.0.0.1`) only, so the backend must be able to reach that address.
4. The agent in the app predates trace support. Update `lynkeus-agent` and rebuild the app.
5. The run has no `--out`. The terminal summary does not print traces; they are kept in the run directory.

**Requests appear, jobs do not.** The job library's instrumentation is not propagating the trace context. Enable the OpenTelemetry instrumentation for that library.

**Fixture steps have no backend list.** Only app steps and macros are traced, wherever they are in the case. A fixture step talks to your backend through your own command, not through the app.

## Next steps

- [Reports](/guides/reports/): the run directory and the hosted report.
- [Running on CI](/guides/ci/): run the backend next to the tests.
- [Fixtures](/guides/fixtures/): prepare the data the backend serves.

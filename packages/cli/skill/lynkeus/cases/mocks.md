# Mocks: app.mock, errors, lost answers, loading states

- `app.mock: { route: "GET /v1/feed", status: 500, body: {...} }` answers in place of the server; `lost: true` lets the server act and loses the answer. `{ clear: true }` drops the rules.
- Each case starts with no mocks, and a rule it sets lasts the case (an app reset inside it included). A mocked request reads `(mocked)` in the evidence: the case's doing, never the backend's. A rule no request matched is a warning naming what the app asked for instead.
- A loading state: `app.mock: { route, hold: true }`, the steps that look, then `app.mock: { release: true }`. A held request is not waited for (idle and frames go on) and is reported as held.

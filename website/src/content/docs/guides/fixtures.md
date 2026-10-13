---
title: Fixtures
description: Prepare backend data for a case and assert on it afterward, through a command of your own that speaks JSON lines.
---

A test of a real app needs data: a user that exists, an order in a known state, a balance to check afterward. **Fixtures** are how a case prepares the backend and reads it back.

lynkeus knows nothing about your backend. You declare one long-lived command, lynkeus sends it one line of JSON per step, and it answers with one line of JSON. That command can be anything that reads a line and writes a line: a Node script, a Rails runner, a container.

## Before you start

- You have a case that runs. See [Writing cases](/guides/writing-cases/).
- You have a way to change your backend from a script: an admin API, a database seed, an internal command.

## Step 1: Start from the generated server

```bash
npx lynkeus case init
```

This writes `cases/fixtures.mjs` and adds the `cases` block to `lynkeus.config.json`:

```json title="lynkeus.config.json"
{
  "cases": {
    "dir": "cases",
    "flows": "flows",
    "fixtures": { "command": "node cases/fixtures.mjs" },
    "inspect": "inspect",
    "refs": { "user": "user_id" },
    "macros": {}
  }
}
```

`cases.fixtures.command` is the command lynkeus starts. It is started once per run and kept open.

## Step 2: Write your fixtures

The generated server keeps users in memory. Replace the bodies with calls to your backend.

```js title="cases/fixtures.mjs"
#!/usr/bin/env node
import readline from 'node:readline';

const users = new Map();

const fixtures = {
  async create_user({ name = 'Test user' }) {
    const user = { user_id: `u_${users.size + 1}`, name, points: 0 };
    users.set(user.user_id, user);
    return user;
  },
  async give_points({ user_id, points }) {
    const user = users.get(user_id);
    if (!user) throw new Error(`no user ${user_id}`);
    user.points += Number(points);
    return { user_id, points: user.points };
  },
  // What `assert` reads.
  async inspect({ user_id }) {
    return users.get(user_id) ?? {};
  },
};

for await (const line of readline.createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const { command, params } = JSON.parse(line);
  if (command === 'lynkeus.describe') {
    console.log(JSON.stringify({ commands: Object.keys(fixtures) }));
    continue;
  }
  try {
    const fixture = fixtures[command];
    if (!fixture) throw new Error(`no fixture ${command}`);
    console.log(JSON.stringify({ ok: true, ...(await fixture(params ?? {})) }));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error.message }));
  }
}
```

Each key of `fixtures` becomes a step name you can use in a case.

## Step 3: Use fixtures in a case

Any step whose name is not `app.…`, `assert`, `exec` or a macro is a fixture.

```md title="cases/points.md"
---
id: points
title: "A user who was given points sees them on the first screen"
---
setup:
  - create_user: { as: u, name: "Ana" }

steps:
  - app.see: { text: "Hello" }
  - give_points: { user: u, points: 25 }
  - app.see: { text: "25 points", timeoutMs: 10000 }
  - assert: { user: u, path: points, equals: 25 }

expected: |
  The points on screen and the points the backend holds are both 25.
```

Three things happen here.

`as: u` keeps the answer of `create_user` under the alias `u`. Later steps read from it with `{{u.user_id}}`.

`user: u` points at that alias. The `refs` key in the configuration says how: with `"refs": { "user": "user_id" }`, the parameter `user: u` reaches the fixture as `user_id`, taken from what `as: u` kept. A step that names no user gets the latest one.

`assert` reads the backend and checks one value. It is explained below.

## Step 4: Check before you run

```bash
npx lynkeus case run cases/points.md --dry-run
```

You should see the case reported as passed, with a count of its steps. A dry run parses the file and checks that every `app.` step names a real command or macro. It does not start the fixtures command, so fixture names are checked only by a real run:

```bash
npx lynkeus case run cases/points.md
```

## Assert on the backend

`assert` calls the fixture named by `cases.inspect` (`inspect` by default) and checks one path of its answer.

```yaml
- assert: { user: u, path: points, equals: 25 }
- assert: { user: u, path: orders.0.status, equals: "paid" }
- assert: { user: u, path: orders.*.status, includes: "paid" }
```

`path` is dotted. A number indexes a list, and `.*.` collects a field from every element of a list.

| Matcher | Passes when |
|---|---|
| `equals` | The value equals this. Numbers are compared as numbers. |
| `includes` | The text contains this, or some element of the list does. |
| `gte`, `lte` | The number is at least, or at most, this. |
| `near` | The number is within 0.01 of this. |
| `matches` | The text matches this regular expression. |
| `present: true` | The value exists. |
| `absent: true` | The value does not exist. |

A failed assert reports what it found, for example `points is 0`.

The other parameters of `assert`, such as `user: u`, are sent to the `inspect` fixture, together with a `section` parameter that holds the first segment of `path`. A server that builds its answer part by part can use `section` to compute only that part.

## Run a shell command

`exec` runs a shell command from the folder of the configuration file. With `as`, it keeps the JSON object the command prints.

```yaml
- exec: { run: "bin/seed-catalog --json", as: catalog }
- app.see: { text: "{{catalog.first_product}}" }
```

## How it works: the protocol

lynkeus starts your command once and writes one JSON line per step to its stdin. Your command writes one JSON line per step to its stdout.

```json
{"command": "create_user", "params": {"name": "Ana"}, "env": {"NAME": "Ana"}}
```

```json
{"ok": true, "user_id": "u_1", "name": "Ana"}
```

- `command` is the step's name.
- `params` is the step's value as written, after `as` is removed and `refs` are resolved.
- `env` is the same parameters flattened to upper-case strings, for a server that hands them to a script as environment variables. `userId` becomes `USER_ID`.
- The answer is any JSON object. On failure, answer `"ok": false` and an `error`; the step fails with that message.

Only lines that start with `{` are read as answers, so your command may log other text to stdout. What it writes to stderr is quoted if the command ends unexpectedly.

### The describe handshake

Before the first case, lynkeus asks your server what it answers:

```json
{"command": "lynkeus.describe", "params": {}, "env": {}}
```

A server that replies `{"commands": ["create_user", "give_points", "inspect"]}` gets every case checked against that list. A case that names a fixture missing from it is refused before anything runs:

```text
points: no fixture give_point
the fixtures command answers: create_user, give_points, inspect
```

This matters because the alternative is a case that fails halfway, with the backend already changed. A server that replies `"ok": false` is not checked.

A server that is running but cannot serve, because its database is down for example, can add `"down": "<why>"` to its reply. No case starts, and the run says `the fixtures server cannot serve: <why>`.

### Configuration

```json
"fixtures": { "command": "node cases/fixtures.mjs", "cwd": ".", "timeoutMs": 120000 }
```

| Key | Default | Meaning |
|---|---|---|
| `command` | none | The command to start, run through a shell. |
| `cwd` | `.` | Where to start it, relative to the configuration file. |
| `env` | none | Extra environment variables for the command. |
| `timeoutMs` | `120000` | How long to wait for one answer. |

## Make setups ahead of time

In a large suite, setup can take longer than the steps. `case run --ahead <n>` makes up to n setups ahead of their cases while other cases run, and only while enough of the CPU is idle (`--idle`, a share from 0 to 1, default `0.25`).

```bash
npx lynkeus case run --ahead 4
```

Only a setup made entirely of fixtures can be made ahead. A setup that contains an `app.` step, a macro, `exec`, `assert` or an `on:` block runs with its case as usual.

A runner that starts `case run` once per case can use `case prepare` instead: start it first with the same cases in the order they will run, leave it running, and pass `--prepared <dir>` to each `case run`. Before it starts, it sends your server `{"command": "lynkeus.ahead"}`, so the server may give that connection a lower priority. A server that does not know the command can answer anything.

## Common problems

**`create_user is not a step lynkeus has, and the project declares no fixtures (cases.fixtures in lynkeus.config.json)`.** The configuration has no `cases.fixtures`, or lynkeus is reading another configuration file. Check the folder you run from and `LYNKEUS_CONFIG`.

**`create_user: the fixtures command did not answer within 120000 ms`.** Your command received the line and wrote nothing back. Every line in needs exactly one line out, including on errors.

**`create_user: the fixtures command ended: …`.** The command exited. The text after the colon is the end of its stderr.

**`no alias 'u'`.** A step uses `user: u` or `{{u.…}}` before any step kept an answer with `as: u`.

**`alias 'u' has no user_id`.** `refs` maps `user` to `user_id`, and the fixture that created `u` did not return that field.

## Next steps

- [Writing cases](/guides/writing-cases/): macros, interruptions and running a suite.
- [Backend traces](/guides/backend-traces/): see what the backend did for each step.
- [Configuration reference](/reference/configuration/): every key under `cases`.

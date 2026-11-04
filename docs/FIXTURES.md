# Fixtures

How a case prepares and reads a backend. lynkeus knows nothing about any backend: a project writes a **fixtures
server** in whatever language its backend speaks, and lynkeus talks to it through the contract on this page.
qa-tools (Rails, for one product) is one such server; `lynkeus case init` writes a small one to start from.

Protocol version: **1** (`FIXTURES_PROTOCOL` in `lynkeus-protocol`, with the types below).

## The connection

`cases.fixtures` in `lynkeus.config.json` names one long-lived command:

```json
{ "cases": { "fixtures": { "command": "./fixtures.sh", "cwd": ".", "timeoutMs": 120000 } } }
```

lynkeus starts it once per run (once per job with `--jobs`), writes one JSON object per line to its stdin and reads
one JSON object per line from its stdout, in order. The command runs through a shell, so `${VAR:-default}` works. It
may print anything to stderr. lynkeus closes stdin when the run ends; the server then exits.

## A step

Every step a case writes that is not lynkeus's own (`app.*`, `assert`, `exec`, a macro) goes to the server:

```
→ {"command": "create_user", "params": {"country": "ar", "as": "u"}, "env": {"COUNTRY": "ar", "AS": "u"}}
← {"ok": true, "user_id": "u_1", "phone": "+5491100000000"}
```

- `params`: the step as the case wrote it, after `{{alias.field}}` and `{{env.X}}` are filled in. `env`: the same,
  flattened to upper-case strings, for a server that hands them to a script as environment variables.
- The answer is any JSON object. `as: u` in the case keeps it, and later steps read `{{u.user_id}}`.
- A failure answers `"ok": false` and an `error`; the step and the case fail with that error.
- `inspect` is the command `assert` calls (`cases.inspect` renames it): it answers the state an assertion reads.

## Describing the server

Before the first case lynkeus sends `{"command": "lynkeus.describe", "params": {}, "env": {}}`. A server answers
what it can do:

```json
{
  "protocol": 1,
  "commands": [
    "inspect",
    {
      "name": "create_user",
      "summary": "A user who can sign in, in the given country and state",
      "params": {
        "country": { "values": ["ar", "mx", "co"], "required": true },
        "status": { "values": ["ok", "banned", "frozen"], "default": "ok" }
      },
      "example": { "country": "ar" },
      "answers": ["user_id", "phone"],
      "changes": true
    }
  ]
}
```

- `commands` lists names, descriptions (`FixtureCommand`), or both. A server that lists names only is valid.
- With the list, a case that names a command nobody answers is refused before anything runs, instead of failing
  halfway with the backend already changed.
- A description lets whoever writes a case (a person, `lynkeus case new`, a model over MCP) choose a setup without
  reading the server's code: `summary` says what state it makes or reads, `params` what it takes, `example` one call
  that works, `answers` what a later step can read, and `changes: false` marks a command that only reads.
- `down` says the server runs but cannot serve (its database is down); the run stops there and says why.
- A server that answers `"ok": false` to `lynkeus.describe` has its cases run unchecked.

## Safety

A fixtures server changes a database. It must refuse anything that is not a local, disposable one: check the
database's host and name before the first command, and refuse to run inside a web server or a console. qa-tools
does this in `commands/lib/qa.rb`.

## Checking a server

```sh
npx lynkeus fixtures check      # does it answer lynkeus.describe as this page says? changes nothing
npx lynkeus fixtures describe   # each command, its summary and parameters
```

Both are MCP tools too, so a model writing cases can read what the backend can do. What a server last described
(to `fixtures describe` or before a run) is kept in `.lynkeus/fixtures-described.json`, and `fixtures describe` shows
it for a day without starting the server: a server that boots a backend framework takes longer than an MCP client
waits. `--fresh` asks the server again.

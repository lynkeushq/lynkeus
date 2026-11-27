/**
 * What `lynkeus case init` writes: one case to copy from, the reference of the
 * format next to it, and a fixtures server with two empty fixtures, so a
 * project starts from something that runs instead of from a blank folder.
 */
export const EXAMPLE_CASE = `---
id: example
title: "A user who was given points sees them on the first screen"
description: >
  What this proves, in a sentence or two. A case reads top to bottom: what has
  to exist, what the person does, what must be true after.
why: >
  Optional: what breaks for people if this fails. The report shows it above the steps.
given: >
  Optional: what is true when it starts (who the user is, what is installed).
ticket: "[TICKET-ID]"
---
setup:
  # Anything that is not an app step is a fixture: fixtures.mjs answers it.
  - create_user: { as: u, name: "Ana" }

steps:
  # 1 The first screen greets the user
  - app.see: { text: "Hello" }

  # 2 Points given in the backend show up
  # \`user: u\` points at what \`create_user\` answered (cases.refs in lynkeus.config.json).
  - give_points: { user: u, points: 25 }
  - app.see: { text: "25 points", timeoutMs: 10000 }
  - assert: { user: u, path: points, equals: 25 }

expected: |
  The points on screen and the points the backend holds are both 25.
`;

export const FORMAT = `# Cases

A case is a markdown file: frontmatter that names it, then \`setup\`, \`steps\`
and \`expected\`. \`lynkeus case run cases/example.md\` runs one; without files
it runs every case in this folder. A step that fails stops the case, and the
report carries the screen, the requests and the reason. An optional
\`teardown\` list puts back what the case changed outside the app (a face
enrolled on a shared Simulator); it runs after the steps, passed or failed. A
teardown step that fails does not change the result, and the result names it.

## Frontmatter

| Key | | |
|---|---|---|
| \`id\`, \`title\` | a line each | how runs and reports name the case; without \`id\` it is the file's name |
| \`description\` | a paragraph | what the case proves |
| \`why\` | optional | what breaks for people if it fails |
| \`given\` | optional | what is true when it starts |
| \`ticket\` | optional | the ticket it covers |
| \`exclusive\` | optional | \`true\`: under \`case run --jobs\` it runs with no other case at once, for a case that changes state every case shares (a global flag) |
| \`targets\` | optional | where this case must pass, replacing the project's \`cases.targets\` (\`[ios, android]\` for a device-only feature); \`case run --on targets\` checks them |

A report shows \`description\`, \`why\`, \`given\`, \`ticket\` and \`expected\` above the steps, so a reader
who never opened the file knows what they are looking at.

## Steps that drive the app

| Step | Value | |
|---|---|---|
| \`app.press\` | target, or \`{ target, within?, nth?, optional?, hold?, timeoutMs? }\` | Waits for the control to be there and enabled. \`optional\` presses only if it is on screen. |
| \`app.type\` | \`{ text, target?, submit?, clear?, timeoutMs? }\` | \`target\` is tapped first, once it is there (\`timeoutMs\` is how long that may take); \`submit\` ends with the return key. |
| \`app.swipe\` | \`{ direction, target?, distance? }\` or \`{ from, to }\` | |
| \`app.wait\` | route, target, ms, \`{ target, scroll? }\`, \`{ anyOf: [target, ...] }\` or \`{ request, status? }\` | \`scroll\` swipes until the target is in the window. \`anyOf\` accepts the first target present. A \`request\` is \`METHOD /path\`, and is waited for until it answers 2xx unless \`status\` names another (\`status: 500\`). |
| \`app.see\` | target, or \`{ testId?, text?, contains?, route?, request?, event?, layer?, absent?, timeoutMs? }\` | An assertion on what the app shows or did. Everything named must hold. Letter case never matters, so a text drawn in capitals (\`textTransform\`) is found by the words the source writes, and spaces around a text do not count. A target that is a text matches an element's whole text (a button's label also matches a part of it); \`contains: true\` finds it inside a longer text, a paragraph say. \`{ text }\` on its own finds it inside any text. |
| \`app.nav\` | route, or \`{ route, params }\` | A teleport, for getting to where the case starts. |
| \`app.back\` | | |
| \`app.requests\` | \`mark\` | A \`request\` counts only what the app asked for after the step before it began; this marks further back, until a step has looked for a request. |
| \`app.call\` | \`{ command, params?, expect?, as? }\` | A command the app registered: \`qa.register('reset', async (params) => { … })\`, with \`qa\` from \`lynkeus-agent\`. What the function returns is what \`expect\` and \`as\` read. Right after the app attached (a launch, a relaunch) a command it has not registered yet is asked for again for up to 5 s; then it fails, naming those it did. |
| \`app.relaunch\` | | Starts the app again as a fresh case finds it: on a Simulator or emulator the app is terminated and launched, a host the run started (\`host_command\`) is started again, and any other host mounts the app again. The case's mocks go with it; set them after. |
| \`app.run\` | \`{ flow, vars? }\` | A Lynkeus flow, from the flows folder. |
| \`app.events\` / \`app.event\` | \`clear\` / \`{ name, props?, absent? }\` | What the app told its analytics. |
| \`app.<command>\` | its arguments by name | Any other Lynkeus command: \`app.mock\`, \`app.network\`, \`app.appstate\`, \`app.deeplink\`… |

A target is \`#testId\`, a text (a field's placeholder too), an index (\`app.press: 7\`) or \`x,y\`. Where a step takes \`target\` it also takes \`testId\`. A bare word that starts with a capital is a route: \`app.wait: Next\` waits for a route called \`Next\`, and when the app has no such route but \`Next\` is on screen, the failure says so. A text inside quotes of its own (\`'"Next"'\`) is always a text.

## Sections

A comment that starts with a number opens a section of \`steps\`: \`# 3 A wrong PIN\`
(or \`# 2b …\`). Every step after it, up to the next one, belongs to it; a report
groups the steps that way and a run's live status says which section each case is
in. Other comments are notes. Number the sections the way \`expected\` numbers
what must be true, so a reader can match one to the other.

## Mocked answers

\`app.mock: { route: "GET /path", status, body }\` answers a request in place of
the server; with \`lost: true\` the request reaches the server and its answer is
lost, as a dropped connection would. A request a mock answered is marked
\`(mocked)\` in the evidence, and a failure is never blamed on the backend for an
answer the case made. A rule no request matched is named in the case's result
with what the app asked the network for instead
(\`mock rule GET /v1/feed.json never matched; GET /v1/api.json went to the network\`).

Every case starts with no mocks: Lynkeus clears the app's rules and holds before
the first step and again after the last, so a mock never answers for another case
or for the app driven by hand. \`app.mock: { clear: true }\` drops them in the
middle of a case; \`app.mock: { route: "GET /path", hold: true }\` keeps matching
requests waiting until \`app.mock: { release: true }\`.

A case that runs over several inputs declares \`matrix: { locale: [en, fr] }\`
in its frontmatter and runs once per combination; \`{{matrix.locale}}\` is that
run's value.

One case runs on a host and on a device. What only one of them needs — closing a
native screen the host never shows — is kept to it:

\`\`\`yaml
  - on: device        # or headless, ios, android
    do:
      - app.press: "364,84"
\`\`\`

A case starts on a Simulator or emulator with nothing in front of the app: when a
view the app did not draw covers it (iOS's Save Password prompt after the case
before signed in, an alert left open), the app is relaunched before the first
step, and the case's result says so.

\`lynkeus case run --dry-run\` runs nothing: it lists each case's steps as a run
counts them, every macro opened into the steps it stands for, and marks a step
that is not one.

## Steps that prepare and read the backend

Any other step name is a **fixture**: Lynkeus sends it to the command in
\`cases.fixtures\` (lynkeus.config.json) as one JSON line and reads one back.

\`\`\`
→ {"command": "create_user", "params": {"name": "Ana"}, "env": {"NAME": "Ana"}}
← {"ok": true, "user_id": "u_1", "name": "Ana"}
\`\`\`

Before the first case Lynkeus sends \`{"command": "lynkeus.describe"}\`. A
server that answers \`{"commands": ["create_user", …]}\` gets its cases checked
first: one that names a fixture missing from the list is refused before
anything runs. A server that answers \`"ok": false\` is not checked.

\`as: u\` keeps the answer; \`{{u.user_id}}\` reads it later. \`assert\` calls
the \`inspect\` fixture and checks one path of its answer with \`equals\`,
\`includes\`, \`gte\`, \`lte\`, \`near\`, \`matches\`, \`present\` or \`absent\`.
\`exec: { run: "…", as? }\` runs a shell command and keeps its JSON output.

## Steps of your own

\`cases.macros\` names a step and the steps it stands for. Inside,
\`{{param.x}}\` is what the case passed, and a parameter that names an alias
is that alias.

\`\`\`json
"macros": {
  "app.login": [
    { "app.call": { "command": "reset" } },
    { "app.deeplink": "myapp://dev-login?user={{param.as.user_id}}" },
    { "when": "wait", "do": { "app.wait": "{{param.wait}}" } }
  ]
}
\`\`\`

\`when\` runs a step only if the case passed that parameter (\`"when": "wait"\`)
or passed that value (\`"when": "method=phone"\`); \`unless\` is the opposite.
\`{ "on": "headless", "do": [ … ] }\` keeps steps to one kind of host, as in a case.

\`cases.interruptions\` names what the app may put in the way of any step — a
lock screen, a consent sheet — and the steps that get past it:
\`{ "see": "#unlock-keypad", "do": ["app.unlock"], "unless": "keypad" }\`. It
runs before a press, a type, a swipe or a see finds it there; a step whose own
words match \`unless\` is about it, and is left alone.

Cases and fixtures often live in a repository of their own: \`LYNKEUS_CONFIG\`
names a second configuration file, read over the app's, and the paths under
its \`cases\` are relative to it.
`;

export const FIXTURES = `#!/usr/bin/env node
// The fixtures of this project: how a case prepares the backend and reads it.
// lynkeus starts this once per run and talks JSON lines to it: one line in per
// step, one line out. Replace the bodies with calls to your backend — its
// admin API, a script, a database seed.
import readline from 'node:readline';

const users = new Map();

const fixtures = {
  async create_user({ name = 'Test user' }) {
    const user = { user_id: \`u_\${users.size + 1}\`, name, points: 0 };
    users.set(user.user_id, user);
    return user;
  },
  async give_points({ user_id, points }) {
    const user = users.get(user_id);
    if (!user) throw new Error(\`no user \${user_id}\`);
    user.points += Number(points);
    return { user_id, points: user.points };
  },
  // What \`assert\` reads.
  async inspect({ user_id }) {
    return users.get(user_id) ?? {};
  },
};

for await (const line of readline.createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const { command, params } = JSON.parse(line);
  // lynkeus asks once what this server answers, and refuses a case that names anything else.
  if (command === 'lynkeus.describe') {
    console.log(JSON.stringify({ commands: Object.keys(fixtures) }));
    continue;
  }
  try {
    const fixture = fixtures[command];
    if (!fixture) throw new Error(\`no fixture \${command}\`);
    console.log(JSON.stringify({ ok: true, ...(await fixture(params ?? {})) }));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error.message }));
  }
}
`;

export const CONFIG = {
  dir: 'cases',
  flows: 'flows',
  fixtures: { command: 'node cases/fixtures.mjs' },
  inspect: 'inspect',
  refs: { user: 'user_id' },
  macros: {},
};

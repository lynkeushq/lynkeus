# Case format: frontmatter, setup, steps, teardown, expected

A case is a markdown file in the cases folder (`cases.dir` in `lynkeus.config.json`, default `cases/`). `lynkeus case init` writes the folder once, with an example, a fixtures server and a `README.md` holding the whole format.

```markdown
---
id: sign-out
title: "A signed-in user signs out"
description: What this proves, in a sentence or two.
---
setup:
  - create_user: { as: u }            # not app.*: a fixture the fixtures server answers
steps:
  # 1 Signed in
  - app.call: { command: signIn, params: { user: "{{u.email}}" } }
  - app.wait: Home
  # 2 Sign out
  - app.press: "#sign-out-button"
  - app.see: { text: "Signed out", contains: true }
teardown:
  - app.relaunch
expected: |
  1. The user lands on Home.
  2. Signing out says so.
```

- A comment starting with a number (`# 2 Sign out`) opens a section; reports group steps by it. Number them like `expected`.
- `teardown` runs whether the steps passed or failed; a failing teardown step is a warning. Use it to put back what the case changed outside the app.
- `exclusive: true` runs the case alone under `--jobs` (it changes something every case sees).
- `matrix: { locale: [en, fr] }` runs it once per value; `{{matrix.locale}}` reads it.
- `case run --dry-run` lists each case's steps with macros opened and marks a step that is not one.

---
id: backend-steps
title: Fixtures, asserts and shell steps
exclusive: true
tags: [backend, money]
---
setup:
  - create_user: { as: u, name: "Ana", balance: 25 }
  - create_user: { as: v, name: "{{random.letters}}", phone: "+1555{{random.digits}}" }
  - give_points: { user: u, points: 25 }
  - exec: { run: "echo '{\"id\": 4}'", as: shell }
  - exec: "true"
steps:
  - app.see: { text: "{{u.name}}" }
  - assert: { user: u, path: points, equals: 25 }
  - assert: { path: name, includes: "An" }
  - assert: { path: balance, gte: 10 }
  - assert: { path: balance, lte: 100 }
  - assert: { path: rate, near: 0.5 }
  - assert: { path: email, matches: "^a@" }
  - assert: { path: phone, present: true }
  - assert: { path: deleted_at, absent: true }
  - assert: { path: "accounts.*.id", includes: "acc_1" }
  - send_push: { user: v, title: "Hi {{v.name}}" }
teardown:
  - delete_user: { user: u }
  - app.call: { command: reset }
expected: |
  The backend holds what the case gave it.

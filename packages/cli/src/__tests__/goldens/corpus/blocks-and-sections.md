---
id: blocks-and-sections
title: Blocks for one host, macros, sections
description: >
  Steps kept to one host, the project's own steps and numbered sections, as a person writes them.
---
steps:
  # 1 Sign in
  - app.login: { as: u, wait: Home.Main }
  - on: device
    do:
      - app.press: "364,84"
  - on: headless
    do: { app.press: "#skip" }
  # 2 Platform specifics
  - on: ios
    do:
      - app.see: { text: "Allow" }
      - app.press: "Allow"
  - on: "!android"
    do:
      - app.wait: 300
  - on: "has:clock"
    do:
      - app.clock: { advance: 5000 }
  # 3b The rest
  - app.refresh
  - app.see: { text: "Done" }
expected:
  - The case reads the same on every host.

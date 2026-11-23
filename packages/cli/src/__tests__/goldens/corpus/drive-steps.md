---
id: drive-steps
title: "Every way a step drives the app"
description: Each app step with each form of value the case format documents.
---
steps:
  # 1 Presses
  - app.press: "#submit"
  - app.press: "Next"
  - app.press: '"Next"'
  - app.press: "'12'"
  - app.press: "12"
  - app.press: 12
  - app.press: "100,200"
  - app.press: "#row[2]"
  - app.press: "Delete[1]"
  - app.press: { target: "#submit" }
  - app.press: { testId: submit }
  - app.press: { text: "Save" }
  - app.press: { text: "Save", within: "#sheet", nth: 1 }
  - app.press: { target: "Save", within: "Card" }
  - app.press: { target: "#promo-close", optional: true }
  - app.press: { target: "#record", hold: 800 }
  - app.press: { target: "#pay", timeoutMs: 9000 }
  # 2 Typing
  - app.type: { text: "Ana" }
  - app.type: { target: "#name", text: "Ana" }
  - app.type: { testId: email, text: "a@b.co", submit: true }
  - app.type: { target: "#code", text: "123456", clear: true, timeoutMs: 8000 }
  - app.type: { target: "Name", text: "Ana", paste: true }
  # 3 Swipes
  - app.swipe: up
  - app.swipe: { direction: left }
  - app.swipe: { direction: up, target: "#carousel" }
  - app.swipe: { direction: down, target: "#sheet", distance: 300 }
  - app.swipe: { from: "200,700", to: "200,100" }
  - app.swipe: { from: "10,400", to: "380,400", duration: 400 }
  # 4 Waits
  - app.wait: Home.Main
  - app.wait: "route:index"
  - app.wait: "route:(tabs)/settings"
  - app.wait: 800
  - app.wait: "1500"
  - app.wait: "#ready"
  - app.wait: "Welcome back"
  - app.wait: '"Next"'
  - app.wait: { target: "#list-end", scroll: true }
  - app.wait: { target: "#pay", enabled: true }
  - app.wait: { target: "#spinner", gone: true, timeoutMs: 20000 }
  - app.wait: { what: Home.Main, timeoutMs: 5000 }
  - app.wait: { text: "Saved" }
  - app.wait: { text: Next }
  - app.wait: { testId: done }
  - app.wait: { anyOf: ["Welcome", { testId: home }, { text: "Hi", nth: 1 }] }
  - app.wait: { request: "POST /v3/transfers" }
  - app.wait: { request: "GET /v3/accounts/", status: 200, timeoutMs: 4000 }
  # 5 Looking
  - app.see: "#balance"
  - app.see: "Balance"
  - app.see: { testId: balance, text: "$25" }
  - app.see: { text: "25 points", request: "GET /api/points", event: points_viewed, props: { points: 25 } }
  - app.see: { route: Profile.Main }
  - app.see: { layer: true }
  - app.see: { layer: false }
  - app.see: { layer: confirm-delete }
  - app.see: { text: "Error", absent: true }
  - app.see: { target: "#toast", timeoutMs: 6000 }
  - app.see: { request: "POST /api/code", status: 201 }
  # 6 Moving around
  - app.nav: Settings.Main
  - app.nav: { route: Profile.Edit, params: { id: 7 } }
  - app.back
  - app.requests: mark
  - app.call: { command: reset }
  - app.call: { command: login, params: { user: "u_1" }, expect: { "user.id": "u_1", token: null }, as: session, timeoutMs: 5000 }
  - app.run: signup.flow.json
  - app.run: { flow: checkout.json, vars: { amount: 10, currency: USD } }
  - app.events: clear
  - app.event: points_viewed
  - app.event: { name: points_viewed, props: { points: 25 } }
  - app.event: { name: points_viewed, absent: true }
  # 7 Other commands
  - app.mock: { route: "POST /v3/transfers", lost: true, times: 1 }
  - app.mock: { route: "GET /v3/accounts", status: 500 }
  - app.mock: { route: "GET /v3/feed", hold: true }
  - app.mock: { release: true }
  - app.network: off
  - app.network: { state: on }
  - app.appstate: background
  - app.appstate: { state: active }
  - app.deeplink: "myapp://home?tab=2"
  - app.clock: { advance: 1000 }
  - app.screenshot: shot.png
  - app.unlock
expected:
  - Nothing: the case is read, not run.

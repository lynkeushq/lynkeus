---
id: deer-login
title: "flutter_deer: password login with validation"
description: >
  The login button stays off until the phone number has 11 digits and the password 6 characters; the password is
  shown and hidden again with its eye button; signing in opens the store's audit form.
---
steps:
  - app.deeplink: "/login"
  - app.see: { text: "Password Login" }
  - app.wait: { target: "#login", enabled: false }
  - app.type: { target: "#phone", text: "1500000" }
  - app.type: { target: "#password", text: "111111" }
  - app.wait: { target: "#login", enabled: false }
  - app.type: { target: "#phone", text: "15000000000", clear: true }
  - app.wait: { target: "#login", enabled: true }
  - app.press: "#password_showPwd"
  - app.press: "#password_showPwd"
  - app.press: "#login"
  - app.see: { text: "店铺资料" }
expected:
  - Login is refused until both fields are valid, then opens the audit form.

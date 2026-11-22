---
id: exact-resend-code
title: "Counter and resend countdown on an Exact host"
description: >
  Presses the counter twice, signs a name in and asks for a code. The code can be asked for again after a three second
  countdown, which the case lets pass by moving the app's own clock instead of waiting.
---
steps:
  - app.see: { text: "Count: 0" }
  - app.press: "#increment"
  - app.press: "#increment"
  - app.see: { text: "Count: 2" }
  - app.type: { target: "#name", text: "Ana" }
  - app.press: "#send"
  - app.see: { text: "Resend in 3" }
  - app.clock: { advanceMs: 3000 }
  - app.see: { text: "Resend now" }
expected:
  - The counter reads 2 and the name field holds Ana.
  - After three seconds of the app's clock the countdown has ended.

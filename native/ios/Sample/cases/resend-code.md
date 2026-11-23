---
id: native-resend-code
title: "Counter and resend countdown in a native SwiftUI app"
description: >
  Presses the counter twice, types a name and asks for a code. The code can be asked for again after a three second
  countdown, which the case waits for.
---
steps:
  - app.see: { text: "Count: 0" }
  - app.press: "#increment"
  - app.press: "#increment"
  - app.see: { text: "Count: 2" }
  - app.type: { target: "#name", text: "Ana" }
  - app.press: "#send"
  - app.see: { text: "Resend in 3" }
  - app.wait: { target: "Resend now", timeoutMs: 6000 }
expected:
  - The counter reads 2 and the name field holds Ana.
  - After three seconds the countdown has ended.

---
id: settings
title: "A preference that persists, and a link the app opens"
description: >
  Turns a setting on, leaves the screen and comes back to find it read again from the app's storage, and checks the
  help link with the app's link opener. On a host the link is also opened, where the host writes it down instead of leaving
  the app; a device would leave the app for the browser, so it does not open it there.
---
steps:
  - app.call: { command: reset }
  - app.press: "#open-settings"
  - app.see: { text: "Remember me: off" }
  - app.press: "#remember"
  - app.see: { text: "Remember me: on" }
  - app.back
  - app.press: "#open-settings"
  - app.see: { text: "Remember me: on" }
  - app.press: "#check-link"
  - app.see: { text: "Help link: available" }
  - on: headless
    do:
      - app.press: "#open-help"
      - app.see: { text: "Opened help" }
      - app.call: { command: launched, expect: { "urls.0": "https://lynkeus.io/help" } }
  - app.back
  - app.see: { text: "Count: 0" }
expected:
  - The setting is still on after leaving the screen, and the help link can be opened.

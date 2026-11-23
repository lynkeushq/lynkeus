---
id: list-and-dialog
title: "A long list, a second screen and a confirmation dialog"
description: >
  Opens the list, scrolls to a row far below the fold and picks it, goes back from the list with the system back, then
  confirms a dialog. While the dialog is up, the screen under it is not presented.
---
steps:
  - app.call: { command: reset }
  - app.press: "#open-list"
  - app.see: { text: "Items" }
  - app.wait: { target: "Item 40", scroll: true }
  - app.press: "Item 40"
  - app.see: { text: "Picked Item 40" }
  - app.press: "#open-list"
  - app.see: { text: "Item 1" }
  - app.back
  - app.see: { text: "Count: 0" }
  - app.press: "#delete"
  - app.see: { layer: confirm-delete }
  - app.see: { testId: increment, absent: true }
  - app.press: "#confirm"
  - app.wait: { target: "Delete everything?", gone: true }
  - app.see: { text: "Everything was deleted" }
expected:
  - Item 40 was picked from the list.
  - The dialog hid the screen under it, and deleting closed it.

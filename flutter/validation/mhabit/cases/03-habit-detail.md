---
id: mhabit-habit-detail
title: "mhabit: a habit's page, its heatmap, the score chart by week and the frequency chart by year"
description: >
  Checks a new habit in, opens its page, finds the heatmap calendar and the score chart, switches the score chart
  from days to weeks and the frequency chart from months to years through their menus.
---
steps:
  - app.press: "New Habit"
  - app.wait: "No Group"
  - app.type: "Stretch"
  - app.press: "#habit-edit.save-visibility"
  - app.wait: '"Stretch"'
  - app.press: { target: "#habit-record-0", within: "Stretch" }
  - app.press: '"Stretch"'
  - app.wait: '"Summary"'
  - app.see: { text: "INCOMPLETE OVERFULFILLED" }
  - app.see: { text: "Score" }
  - app.press: "Day"
  - app.press: "Week"
  # A capitalized word alone reads as a route in wait and see: quoted, it is a text.
  - app.wait: '"Week"'
  - app.see: { target: '"Day"', absent: true }
  - app.wait: { target: '"Frequency"', scroll: true }
  - app.press: "Month"
  - app.press: "Year"
  - app.wait: '"Year"'
  - app.see: { target: '"Month"', absent: true }
teardown:
  - app.press: { target: "Show menu", nth: 0 }
  - app.press: "Delete"
  - app.press: "confirm"
  - app.see: { text: "Deleted habit" }
  # mhabit's undo snackbar stays until it is dismissed (an action makes a SnackBar persist since Flutter 3.47),
  # covering the Android FAB; the deleted habit stays in the list, struck through.
  - app.swipe: { target: "UNDO", direction: down }
expected:
  - The page shows the heatmap and both charts, and each chart's period follows its menu.

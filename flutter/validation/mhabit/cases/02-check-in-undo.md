---
id: mhabit-check-in-undo
title: "mhabit: check a habit in from the table, see it count, and take it back"
description: >
  Creates a habit, taps today's cell in its row (done), reads the record and the grade on its page, then taps the cell
  through skip and the next state back to empty and reads that the record is gone.
---
steps:
  - app.press: "New Habit"
  - app.wait: "No Group"
  - app.type: "Drink water"
  - app.press: "#habit-edit.save-visibility"
  - app.wait: '"Drink water"'
  # Today's cell is the one nearest the habit's name.
  - app.press: { target: "#habit-record-0", within: "Drink water" }
  - app.press: '"Drink water"'
  - app.wait: '"Summary"'
  - app.see: { target: '"1"', within: "Records" }
  - app.see: { text: "Current grade is 0.24" }
  - app.back
  - app.wait: '"Drink water"'
  # Done, then skipped, then the third state, then empty again.
  - app.press: { target: "#habit-record-0", within: "Drink water" }
  - app.press: { target: "#habit-record-0", within: "Drink water" }
  - app.press: { target: "#habit-record-0", within: "Drink water" }
  - app.press: '"Drink water"'
  - app.wait: '"Summary"'
  - app.see: { target: '"0"', within: "Records" }
  - app.see: { text: "Current grade is 0.00" }
teardown:
  - app.press: { target: "Show menu", nth: 0 }
  - app.press: "Delete"
  - app.press: "confirm"
  - app.see: { text: "Deleted habit" }
  # mhabit's undo snackbar stays until it is dismissed (an action makes a SnackBar persist since Flutter 3.47),
  # covering the Android FAB; the deleted habit stays in the list, struck through.
  - app.swipe: { target: "UNDO", direction: down }
expected:
  - A tap on today's cell records the habit as done and raises the grade; tapping through its states removes the record.

---
id: mhabit-create-habit
title: "mhabit: create a habit with a goal and a unit, see it in the list and on its page"
description: >
  Opens the new-habit form from the bottom bar, names the habit, sets a daily goal of 2 with a unit, saves, finds it in
  the habits table and on its detail page, then deletes it so the list is as it was.
---
steps:
  - app.press: "New Habit"
  - app.wait: "No Group"
  # The form opens with the name field focused. The goal and its unit have no key and no label, only a value and a
  # hint: they are reached by index, which the name's Save button (iOS has two) and the layout make differ.
  - app.type: "Morning run"
  - on: ios
    do:
      - app.type: { target: "8", text: "2", clear: true }
      - app.type: { target: "9", text: "km" }
  - on: android
    do:
      - app.type: { target: "7", text: "2", clear: true }
      - app.type: { target: "8", text: "km" }
  - app.press: "#habit-edit.save-visibility"
  - app.wait: '"Morning run"'
  - app.press: '"Morning run"'
  - app.wait: '"Summary"'
  - app.see: { target: '"2"', within: "Goal" }
  - app.see: { text: "66d" }
teardown:
  - app.press: { target: "Show menu", nth: 0 }
  - app.press: "Delete"
  - app.press: "confirm"
  - app.see: { text: "Deleted habit" }
  # mhabit's undo snackbar stays until it is dismissed (an action makes a SnackBar persist since Flutter 3.47),
  # covering the Android FAB; the deleted habit stays in the list, struck through.
  - app.swipe: { target: "UNDO", direction: down }
expected:
  - The habit is saved with its goal and shows in the list and on its own page.

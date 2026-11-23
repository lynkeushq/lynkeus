---
id: mhabit-edit-archive
title: "mhabit: rename a habit, archive it, find it with the archived filter, and bring it back"
description: >
  Renames a new habit from its page, archives it (confirmed in a dialog), sees it leave the table, shows archived
  habits through the display filter to find it there, unarchives it and turns the filter back off.
---
steps:
  - app.press: "New Habit"
  - app.wait: "No Group"
  - app.type: "Journal"
  - app.press: "#habit-edit.save-visibility"
  - app.press: '"Journal"'
  - app.press: "Edit"
  # The name field has a key on iOS only; on Android it is the first input.
  - on: ios
    do:
      - app.type: { target: "#editable-app-bar-apple-field", text: "Journal daily", clear: true }
  - on: android
    do:
      - app.type: { target: "1", text: "Journal daily", clear: true }
  - app.press: "#habit-edit.save-visibility"
  - app.wait: '"Journal daily"'
  - app.press: { target: "Show menu", nth: 0 }
  - app.press: "Archive"
  - app.see: { text: "Archive Habit?" }
  - app.press: "confirm"
  - app.back
  - app.wait: { target: '"Journal daily"', gone: true }
  # The display filter is a menu of switches over the page; pressing the button that opened it closes it.
  - app.press: "Show menu"
  - app.press: "Display Filter"
  - app.press: "Archived"
  - app.press: "Show menu"
  - app.wait: '"Journal daily"'
  - app.press: '"Journal daily"'
  - app.press: { target: "Show menu", nth: 0 }
  - app.press: "Unarchive"
  - app.see: { text: "Unarchive Habit?" }
  - app.press: "confirm"
  - app.back
  - app.press: "Show menu"
  - app.press: "Display Filter"
  - app.press: "Archived"
  - app.press: "Show menu"
  - app.wait: '"Journal daily"'
teardown:
  - app.press: '"Journal daily"'
  - app.press: { target: "Show menu", nth: 0 }
  - app.press: "Delete"
  - app.press: "confirm"
  - app.see: { text: "Deleted habit" }
  # mhabit's undo snackbar stays until it is dismissed (an action makes a SnackBar persist since Flutter 3.47),
  # covering the Android FAB; the deleted habit stays in the list, struck through.
  - app.swipe: { target: "UNDO", direction: down }
expected:
  - The new name shows on the page; an archived habit leaves the table and is found only with the archived filter; once
    unarchived it is back with the filter off.

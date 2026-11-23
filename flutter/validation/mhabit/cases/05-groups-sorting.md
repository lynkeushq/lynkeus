---
id: mhabit-groups-sorting
title: "mhabit: a group from settings, a habit put in it, the list sorted by name, a delete undone"
description: >
  Creates a group in Manage Groups (a sheet with a name), creates a habit in that group and one outside
  it, sorts the table by name and back to the user's order, deletes a habit and takes it back from the snackbar, and
  removes what it made.
---
steps:
  - on: ios
    do:
      - app.press: { target: "Show menu", nth: 0 }
      - app.press: "Settings"
  - on: android
    do:
      - app.press: "#open-settings-action"
  - app.wait: { target: "Manage Groups", scroll: true, timeoutMs: 20000 }
  - app.press: "Manage Groups"
  # The button that creates a group has no label on Android, where it is a floating button.
  - on: ios
    do:
      - app.press: "Create group"
  - on: android
    do:
      - app.press: "5"
  - app.wait: "#adaptive-modal-confirm"
  # The sheet opens with its name field focused (keyed on iOS, labeled on Android).
  - app.type: "Health"
  - app.press: "#adaptive-modal-confirm"
  - app.wait: { target: '"Health"' }
  - app.back
  - app.back
  - app.press: "New Habit"
  - app.wait: "No Group"
  - app.type: "Yoga"
  - app.press: "No Group"
  - app.press: "Health"
  - app.press: "#habit-edit.save-visibility"
  - app.wait: '"Yoga"'
  - app.press: "New Habit"
  - app.wait: "No Group"
  - app.type: "Archery"
  - app.press: "#habit-edit.save-visibility"
  - app.wait: '"Archery"'
  # The table is flat until grouped; each group's header names it with its count and has a menu of its own, so the
  # page's menu is the first "Show menu". Picking an entry of a submenu closes the menu.
  - app.press: { target: "Show menu", nth: 0 }
  - app.press: "Group Sort Flat"
  - app.press: "By Name"
  - app.wait: "Health 1"
  - app.see: "No Group 1"
  - app.press: { target: "Show menu", nth: 0 }
  - app.press: "Sort My order"
  - app.press: "By Name"
  - app.wait: { target: '"Display Filter"', gone: true }
  - app.press: { target: "Show menu", nth: 0 }
  - app.see: "Group Sort By Name (Asc)"
  - app.press: "Sort By Name (Asc)"
  - app.press: "My order"
  - app.wait: { target: '"Display Filter"', gone: true }
  - app.press: { target: "Show menu", nth: 0 }
  - app.press: "Group Sort By Name (Asc)"
  - app.press: "Flat"
  - app.wait: { target: "Health 1", gone: true }
  - app.press: { target: "Show menu", nth: 0 }
  - app.see: "Sort My order"
  - app.see: "Group Sort Flat"
  # The button that opened the menu closes it.
  - app.press: { target: "Show menu", nth: 0 }
  - app.wait: { target: '"Display Filter"', gone: true }
  - app.press: '"Archery"'
  - app.press: { target: "Show menu", nth: 0 }
  - app.press: "Delete"
  - app.press: "confirm"
  - app.see: { text: "Deleted habit" }
  - app.press: "UNDO"
  - app.see: { text: "Deleted habit", absent: true }
  - app.wait: '"Archery"'
teardown:
  - app.press: '"Archery"'
  - app.press: { target: "Show menu", nth: 0 }
  - app.press: "Delete"
  - app.press: "confirm"
  - app.see: { text: "Deleted habit" }
  # mhabit's undo snackbar stays until it is dismissed (an action makes a SnackBar persist since Flutter 3.47),
  # covering the Android FAB; the deleted habit stays in the list, struck through.
  - app.swipe: { target: "UNDO", direction: down }
  - app.press: '"Yoga"'
  - app.press: { target: "Show menu", nth: 0 }
  - app.press: "Delete"
  - app.press: "confirm"
  - app.see: { text: "Deleted habit" }
  - app.swipe: { target: "UNDO", direction: down }
  - on: ios
    do:
      - app.press: { target: "Show menu", nth: 0 }
      - app.press: "Settings"
  - on: android
    do:
      - app.press: "#open-settings-action"
  - app.wait: { target: "Manage Groups", scroll: true, timeoutMs: 20000 }
  - app.press: "Manage Groups"
  # The group's own menu button: labeled More on Android, with no label on iOS, where the only group's row puts it
  # at index 8.
  - on: ios
    do:
      - app.press: "8"
  - on: android
    do:
      - app.press: "More"
  - app.press: '"Delete"'
  - app.see: { text: "Habits in this group will become uncategorized." }
  - app.press: "Delete"
  - app.wait: { target: '"Delete Group"', gone: true }
  - app.wait: { target: '"Health"', gone: true }
  - app.back
  - app.back
  - app.wait: "New Habit"
expected:
  - The new habit sits under its group when the table is grouped; sorting changes with the menu; a deleted habit comes
    back with UNDO.

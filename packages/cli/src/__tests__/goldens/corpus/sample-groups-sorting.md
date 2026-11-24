---
id: sample-groups-sorting
title: "A group from settings, an item put in it, the list sorted by name, a delete undone"
description: >
  Creates a group in Manage Groups (a sheet with a name), creates an item in that group and one outside
  it, sorts the list by name and back to the user's order, deletes an item and takes it back from the snackbar, and
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
  - app.type: "Home"
  - app.press: "#adaptive-modal-confirm"
  - app.wait: { target: '"Home"' }
  - app.back
  - app.back
  - app.press: "New Item"
  - app.wait: "No Group"
  - app.type: "Groceries"
  - app.press: "No Group"
  - app.press: "Home"
  - app.press: "#item-edit.save"
  - app.wait: '"Groceries"'
  - app.press: "New Item"
  - app.wait: "No Group"
  - app.type: "Laundry"
  - app.press: "#item-edit.save"
  - app.wait: '"Laundry"'
  # The list is flat until grouped; each group's header names it with its count and has a menu of its own, so the
  # page's menu is the first "Show menu". Picking an entry of a submenu closes the menu.
  - app.press: { target: "Show menu", nth: 0 }
  - app.press: "Group Sort Flat"
  - app.press: "By Name"
  - app.wait: "Home 1"
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
  - app.wait: { target: "Home 1", gone: true }
  - app.press: { target: "Show menu", nth: 0 }
  - app.see: "Sort My order"
  - app.see: "Group Sort Flat"
  # The button that opened the menu closes it.
  - app.press: { target: "Show menu", nth: 0 }
  - app.wait: { target: '"Display Filter"', gone: true }
  - app.press: '"Laundry"'
  - app.press: { target: "Show menu", nth: 0 }
  - app.press: "Delete"
  - app.press: "confirm"
  - app.see: { text: "Item deleted" }
  - app.press: "UNDO"
  - app.see: { text: "Item deleted", absent: true }
  - app.wait: '"Laundry"'
teardown:
  - app.press: '"Laundry"'
  - app.press: { target: "Show menu", nth: 0 }
  - app.press: "Delete"
  - app.press: "confirm"
  - app.see: { text: "Item deleted" }
  # The undo snackbar stays until it is dismissed (an action makes a SnackBar persist since Flutter 3.47),
  # covering the Android FAB; the deleted item stays in the list, struck through.
  - app.swipe: { target: "UNDO", direction: down }
  - app.press: '"Groceries"'
  - app.press: { target: "Show menu", nth: 0 }
  - app.press: "Delete"
  - app.press: "confirm"
  - app.see: { text: "Item deleted" }
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
  - app.see: { text: "Items in this group will have no group." }
  - app.press: "Delete"
  - app.wait: { target: '"Delete Group"', gone: true }
  - app.wait: { target: '"Home"', gone: true }
  - app.back
  - app.back
  - app.wait: "New Item"
expected:
  - The new item sits under its group when the list is grouped; sorting changes with the menu; a deleted item comes
    back with UNDO.

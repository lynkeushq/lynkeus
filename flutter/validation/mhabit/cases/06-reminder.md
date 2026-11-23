---
id: mhabit-reminder
title: "mhabit: a habit with a daily reminder at 7:45 AM, scheduled with the notifications plugin, then removed"
description: >
  Sets a reminder in the new-habit form through the time picker's text mode, saves the habit, and (on a host, where
  the notifications stand-in keeps them) reads the notification flutter_local_notifications scheduled. Then removes
  the reminder from the edit form and sees the notification cancelled.
---
steps:
  - app.press: "New Habit"
  - app.wait: "No Group"
  # The name field is focused when the form opens.
  - app.type: "Meditate"
  - app.press: "Reminder"
  - app.see: { text: "Select time" }
  - app.press: "Switch to text input mode"
  # Pasted whole: typed key by key, the Android look's minute field kept only the first digit of 45.
  - app.type: { target: "Hour", text: "7", clear: true, paste: true }
  - app.type: { target: "Minute", text: "45", clear: true, paste: true }
  - app.press: "AM"
  - app.press: "OK"
  - app.wait: "7:45 AM"
  - app.press: "#habit-edit.save-visibility"
  - app.wait: '"Meditate"'
  - on: has:notifications
    do:
      - app.call:
          command: notifications
          expect: { scheduled.0.title: Meditate, scheduled.0.time: "07:45" }
  - app.press: '"Meditate"'
  - app.press: "Edit"
  - app.wait: "7:45 AM"
  # The button that removes the reminder has no label: in the edit form it is index 15 on iOS, 14 on Android.
  - on: ios
    do:
      - app.press: "15"
  - on: android
    do:
      - app.press: "14"
  - app.see: { text: "Remove this reminder?" }
  - app.press: "confirm"
  - app.wait: '"Reminder"'
  - app.press: "#habit-edit.save-visibility"
  - app.wait: '"Summary"'
  - on: has:notifications
    do:
      - app.call: { command: notifications, expect: { scheduled.0: null } }
teardown:
  - app.press: { target: "Show menu", nth: 0 }
  - app.press: "Delete"
  - app.press: "confirm"
  - app.see: { text: "Deleted habit" }
  # mhabit's undo snackbar stays until it is dismissed (an action makes a SnackBar persist since Flutter 3.47),
  # covering the Android FAB; the deleted habit stays in the list, struck through.
  - app.swipe: { target: "UNDO", direction: down }
expected:
  - The reminder is scheduled at 7:45 for the habit, and removing it from the form cancels it.

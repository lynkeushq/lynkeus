---
id: mhabit-export-import
title: "mhabit: export the habits to a JSON file through the share sheet and import the file back"
description: >
  Exports every habit from Settings. Where the plugin stand-ins run (a host), share_plus reports what was shared,
  file_selector hands the exported file to Import, and the habit is there twice. On a simulator or an
  emulator the share sheet and the file picker are the system's, out of the app's reach: the case opens the export
  dialog and cancels it.
---
steps:
  - app.press: "New Habit"
  - app.wait: "No Group"
  - app.type: "Floss"
  - app.press: "#habit-edit.save-visibility"
  - app.wait: '"Floss"'
  - on: ios
    do:
      - app.press: { target: "Show menu", nth: 0 }
      - app.press: "Settings"
  - on: android
    do:
      - app.press: "#open-settings-action"
  - app.wait: { target: "Export Export habits", scroll: true, timeoutMs: 20000 }
  - app.press: "Export Export habits"
  - app.see: { text: "Export all habits?" }
  - on: "!has:shared"
    do:
      - app.press: "cancel"
      - app.back
  # On a host: the share sheet gets the file, the file picker hands it back to Import, and the import adds the
  # exported habit again beside the one still there.
  - on: has:shared
    do:
      - app.press: "export"
      - app.wait: '"Exported All Habits"'
      - app.call: { command: shared, expect: { shared.0.mimeTypes.0: application/json }, as: exported }
      - app.call: { command: files, params: { open: "{{exported.shared.0.paths.0}}" } }
      - app.wait: { target: "Import Import habits", scroll: true }
      - app.press: "Import Import habits"
      # The file holds every habit the app ever kept, deleted ones too: the count in the title is not this case's.
      - app.wait: "#import-confirm-content"
      - app.press: "confirm"
      - app.wait: "close"
      - app.press: "close"
      - app.back
      - app.wait: { target: '"Floss"', nth: 1 }
      - app.press: { target: '"Floss"', nth: 1 }
      - app.press: { target: "Show menu", nth: 0 }
      - app.press: "Delete"
      - app.press: "confirm"
      - app.see: { text: "Deleted habit" }
      # mhabit's undo snackbar stays until it is dismissed (an action makes a SnackBar persist since Flutter 3.47),
      # covering the Android FAB; the deleted habit stays in the list, struck through.
      - app.swipe: { target: "UNDO", direction: down }
  - app.wait: '"Floss"'
teardown:
  - app.press: '"Floss"'
  - app.press: { target: "Show menu", nth: 0 }
  - app.press: "Delete"
  - app.press: "confirm"
  - app.see: { text: "Deleted habit" }
  - app.swipe: { target: "UNDO", direction: down }
expected:
  - The export hands a JSON file to the share sheet, and importing that file adds the habit again.

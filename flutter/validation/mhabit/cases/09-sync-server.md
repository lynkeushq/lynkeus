---
id: mhabit-sync-server
title: "mhabit: a WebDAV sync server with a password, kept in secure storage and read back"
description: >
  Turns sync on, fills the server editor (path, user name, an obscured password), saves, leaves Settings and comes
  back to find the server and its password read back from flutter_secure_storage, then turns sync off. The server
  is a closed local port, so nothing is synced, on any host.
---
steps:
  - on: ios
    do:
      - app.press: { target: "Show menu", nth: 0 }
      - app.press: "Settings"
  - on: android
    do:
      - app.press: "#open-settings-action"
  - app.press: "#settings-sync-option"
  - app.wait: '"Export Failed Sync Logs"'
  - app.see: { text: "Enabled: false" }
  - app.press: "Enabled"
  - app.wait: { text: "Enabled: true" }
  # "Not Configured" on a first run; the server's address once one is saved.
  - app.press: "Sync Server"
  - app.wait: "#adaptive-modal-app-bar"
  - app.type: { target: "Path", text: "http://127.0.0.1:9/dav/", clear: true }
  - app.type: { target: "Username", text: "ana", clear: true }
  - app.type: { target: "Password", text: "s3cret", clear: true }
  - app.see: { target: "Password", text: "••••••" }
  - app.press: "Save"
  - app.wait: "Sync Server WebDAV http://127.0.0.1:9/dav/"
  - app.back
  - app.back
  - on: ios
    do:
      - app.press: { target: "Show menu", nth: 0 }
      - app.press: "Settings"
  - on: android
    do:
      - app.press: "#open-settings-action"
  - app.press: "#settings-sync-option"
  - app.wait: "Sync Server WebDAV http://127.0.0.1:9/dav/"
  - app.see: { text: "Password: ******" }
  - app.press: "Sync Server"
  - app.wait: "#adaptive-modal-app-bar"
  - app.see: { target: "Username", text: "ana" }
  # The debug panel under the form shows what the editor read from secure storage.
  - app.see: { text: "Password: s3cret" }
  - app.press: "Cancel"
  # The editor counts what it read back as a change and asks before it closes.
  - app.see: { text: "Unsaved Changes" }
  - app.press: "Exit"
  - app.wait: { target: "#adaptive-modal-app-bar", gone: true }
  - app.press: "Enabled"
  - app.wait: { text: "Enabled: false" }
  - app.back
  - app.back
  - app.wait: "New Habit"
expected:
  - The server is saved with its password, which comes back from secure storage when the editor opens again; sync is
    off at the end.

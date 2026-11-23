---
id: mhabit-about-changelog
title: "mhabit: the About page, its links, the license page and the changelog"
description: >
  Opens About from Settings, reads the version and the source link, follows the source link where url_launcher's stand-in
  writes it down (a host), long-presses the version for the changelog of this version, opens the full changelog
  and reads a release's notes, then the license page.
---
steps:
  - on: ios
    do:
      - app.press: { target: "Show menu", nth: 0 }
      - app.press: "Settings"
  - on: android
    do:
      - app.press: "#open-settings-action"
  - app.wait: { target: '"About"', scroll: true }
  - app.press: "About"
  - app.wait: "Table Habit Version"
  - app.see: "Source code https://github.com/FriesI23/mhabit"
  - app.see: { text: "Contributors" }
  # On a device the link opens the browser over the app; on a host url_launcher only writes it down.
  - on: has:launched
    do:
      - app.press: "Source code"
      - app.call: { command: launched, params: { clear: true }, expect: { urls.0: "https://github.com/FriesI23/mhabit" } }
  - app.press: { target: "Table Habit Version", hold: 700 }
  - app.wait: "View Full Changelog"
  - app.see: { text: "Changelog" }
  - app.press: "View Full Changelog"
  - app.wait: { text: "v1.27.22+211-pre" }
  - app.see: { text: "Feature: enable Esperanto in release builds (#717)" }
  - app.press: "Back"
  - app.press: "Close"
  - app.wait: { target: "View Full Changelog", gone: true }
  - app.press: "License"
  - app.wait: { text: "Apache License" }
  - app.back
  - app.back
  - app.back
  - app.wait: "New Habit"
expected:
  - About shows the version, the links and the contributors; the changelog shows release notes; the license opens.

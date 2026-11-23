---
id: mhabit-settings
title: "mhabit: dark theme, a custom date format, and the app in Spanish, each put back"
description: >
  In Settings, picks the dark theme and sees the home menu say so, turns the system date format off for day-month-year
  on a 12-hour clock and reads the preview's pattern, switches the language to Spanish and back to the system's, and
  leaves every setting as it found it.
---
steps:
  - on: ios
    do:
      - app.press: { target: "Show menu", nth: 0 }
      - app.press: "Settings"
  - on: android
    do:
      - app.press: "#open-settings-action"
  - app.wait: "#theme-mode-control"
  # iOS shows the three modes side by side; Android has a menu button that says the current one.
  - on: ios
    do:
      - app.press: { target: "Dark", within: "#theme-mode-control" }
  - on: android
    do:
      - app.press: "#theme-mode-control"
      - app.press: "Dark"
  - app.back
  # The home page's menu offers the next theme mode under the current one's name.
  - app.press: { target: "Show menu", nth: 0 }
  - app.see: "Dark"
  - on: ios
    do:
      - app.press: "Settings"
  - on: android
    do:
      - app.press: { target: "Show menu", nth: 0 }
      - app.wait: { target: '"Display Filter"', gone: true }
      - app.press: "#open-settings-action"
  - app.press: "Date display format"
  - app.wait: "#date-format-preview"
  - app.press: "#date-format-use-system"
  - app.wait: '"Separator"'
  # iOS lists the orders as buttons and the switches with their labels; Android has a menu for the order and a
  # 12-hour switch with no label, index 15 on that page.
  - on: ios
    do:
      - app.press: "Day Month Year"
      - app.press: "Use 12-hour format"
  - on: android
    do:
      - app.press: "#date-format-order"
      - app.press: "Day Month Year"
      - app.press: "15"
  - app.see: { text: "d/M/yyyy h:mm:ss a" }
  - on: ios
    do:
      - app.press: "Use 12-hour format"
      - app.press: "Year Month Day"
  - on: android
    do:
      - app.press: "15"
      - app.press: "#date-format-order"
      - app.press: "Year Month Day"
  - app.see: { text: "yyyy/M/d HH:mm:ss" }
  - app.press: "#date-format-use-system"
  - app.wait: { target: '"Separator"', gone: true }
  - app.back
  - app.wait: { target: "#settings-language", scroll: true }
  - app.see: { target: "#settings-language", text: "Follow System" }
  - app.press: "#settings-language"
  - app.press: "#language-option-es"
  - app.wait: '"Ajustes"'
  - app.see: { text: "Idioma" }
  # The whole app follows, the home page too.
  - app.back
  - on: ios
    do:
      - app.press: { target: "Mostrar menú", nth: 0 }
      - app.press: "Ajustes"
  - on: android
    do:
      - app.press: "#open-settings-action"
  - app.wait: { target: "#settings-language", scroll: true, timeoutMs: 20000 }
  - app.see: { target: "#settings-language", text: "Español" }
  - app.press: "#settings-language"
  - app.press: "#language-option-system"
  - app.wait: '"Settings"'
  - app.wait: { target: "#theme-mode-control", scroll: true, timeoutMs: 20000 }
  - on: ios
    do:
      - app.press: { target: "Auto", within: "#theme-mode-control" }
  - on: android
    do:
      - app.press: "#theme-mode-control"
      - app.press: "Auto"
  - app.back
  - app.press: { target: "Show menu", nth: 0 }
  - app.see: "Auto"
  - app.press: { target: "Show menu", nth: 0 }
  - app.wait: { target: '"Display Filter"', gone: true }
expected:
  - The theme, the date format and the language follow their settings, and are back to automatic, the system's format
    and the system's language at the end.

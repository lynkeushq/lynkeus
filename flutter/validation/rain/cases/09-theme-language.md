---
id: rain-theme-language
title: "Rain: dark theme, then the app in Spanish through the language search, and back to English"
description: >
  Settings' theme dialog picks Dark. The language dialog has a search field with only a hint ("Search..."), found by
  that hint on both looks; Spanish turns every label at once, and English brings them back.
---
steps:
  # Past the onboarding, with Berlin as the place to follow (01-onboarding does it page by page).
  - app.wait: '"Skip"'
  - app.press: Skip
  - app.wait: '"Find your city"'
  - app.type: { target: "Search...", text: "Berlin", clear: true, paste: true }
  - app.press: '"Berlin, State of Berlin"'
  - app.press: Done
  - app.wait: '"Berlin, State of Berlin"'
  - app.press: Settings
  - app.press: "Theme System"
  - app.wait: '"Dark"'
  - app.press: Dark
  - app.wait: '"Theme Dark"'
  - app.wait: { target: "Language English", scroll: true }
  - app.press: "Language English"
  - app.type: { target: "Search...", text: "Esp", paste: true }
  - app.press: '"Español"'
  - app.wait: '"Configuración"'
  - app.see: { text: "Tema Oscuro" }
  - app.see: { text: "Apariencia" }
  # Rain's bottom bar keeps the labels it was built with until it is built again: they stay in English here.
  - app.see: { text: "Settings" }
  - app.press: "Idioma Español"
  # The same field, now hinted in Spanish.
  - app.type: { target: "Buscar...", text: "Engl", paste: true }
  - app.press: '"English"'
  - app.wait: '"Language English"'
  - app.see: { text: "Theme Dark" }
  - app.see: { text: "Appearance" }
expected:
  - The theme turns dark, the labels turn Spanish and back to English.

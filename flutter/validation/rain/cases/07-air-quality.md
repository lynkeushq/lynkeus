---
id: rain-air-quality
title: "Rain: the air-quality card, its pollutants, and the US index from Settings"
description: >
  The forecast's air-quality card shows Open-Meteo's European index for the current hour with its band and advice;
  its pollutants open below it. Settings switches the index to the US one, and the card follows.
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
  - app.see: { testId: "aqi-9", text: "" }
  - app.see: { text: "European AQI" }
  - app.see: { text: "27" }
  - app.see: { text: "Fair" }
  - app.see: { text: "Generally fine. Sensitive people may want to limit long outdoor exertion." }
  - app.press: Pollutants
  - app.see: { text: "PM2.5" }
  - app.see: { text: "3.0 µg/m³" }
  - app.see: { text: "O₃" }
  - app.see: { text: "46 µg/m³" }
  - app.press: Settings
  - app.press: "AQI standard European"
  - app.wait: '"American"'
  - app.press: American
  - app.wait: '"AQI standard American"'
  - app.press: Weather
  - app.wait: '"US AQI"'
  - app.see: { text: "23" }
  - app.see: { text: "Good" }
expected:
  - The card shows the index, its band and pollutants, in the standard picked in Settings.

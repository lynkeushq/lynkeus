---
id: rain-units
title: "Rain: degrees in Fahrenheit and wind in another unit, from Settings"
description: >
  Settings lists the units in its Data section. Fahrenheit converts the forecast already loaded (the app converts,
  it does not fetch again), and the wind unit changes the hourly details.
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
  - app.see: { text: "0.2°C" }
  - app.press: Settings
  - app.wait: { target: "Degrees Celsius", scroll: true }
  - app.press: "Degrees Celsius"
  - app.wait: '"Fahrenheit"'
  - app.press: Fahrenheit
  - app.wait: '"Degrees Fahrenheit"'
  - app.press: "Wind km/h"
  - app.wait: '"m/s"'
  - app.press: '"m/s"'
  - app.wait: '"Wind m/s"'
  - app.press: Weather
  - app.wait: '"32.36°F"'
  - app.see: { text: "↑38.12°F ↓32.36°F" }
  - app.see: { testId: "hour-0-9", text: "37.22°F" }
  - app.press: "Hourly weather variables"
  - app.see: { text: "3.6 m/s Wind" }
  - app.see: { text: "7.8 m/s Gust" }
expected:
  - The forecast reads in the units picked in Settings.

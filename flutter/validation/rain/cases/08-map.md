---
id: rain-map
title: "Rain: the map tab with OpenStreetMap tiles and the city's marker"
description: >
  The map tab draws OpenStreetMap tiles around the followed city (replayed from a recording on a host) and a marker
  with its temperature; the marker opens the city's card, and the card its page.
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
  - app.press: Map
  # The tiles around Berlin at the map's zoom, answered by the recording on a host.
  - app.wait: { request: "GET /8/137/83.png" }
  - app.wait: '"0.2°C"'
  - app.see: { text: "Attributions" }
  - app.press: '"0.2°C"'
  - app.see: { target: "Time in the city", text: "Berlin, State of Berlin" }
  - app.press: "Time in the city"
  - app.wait: route:PlaceInfo
  - app.see: { text: "Mon, Nov 23, 2026" }
  - app.back
  - app.wait: route:/
  - app.see: { target: "Search..." }
expected:
  - The map shows tiles and the city's marker, which opens its weather.

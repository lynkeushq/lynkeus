---
id: rain-network-down
title: "Rain: with the network off, a refresh keeps the saved forecast and says there is no internet"
description: >
  After the first forecast, the network goes off (a host's airplane mode: connectivity reports none and every request
  fails). Pulling to refresh keeps the forecast on screen and shows "No Internet"; a city search finds nothing. With the
  network back, a refresh fetches the forecast again.
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
  # The forecast page slides in over the picker: a pull before it has stopped lands on the route's barrier, as a
  # person's would.
  - app.idle
  - on: has:network
    do:
      - app.call: { command: network, params: { state: "off" } }
      - app.swipe: down
      - app.wait: '"No Internet"'
      - app.see: { text: "0.2°C" }
      - app.see: { text: "Berlin, State of Berlin" }
      # A city search fails too: no suggestion comes.
      - app.press: Cities
      - app.press: "#add-city"
      - app.type: { target: "Find your city", text: "Paris", clear: true, paste: true }
      - app.wait: 1000
      - app.see: { text: "Paris, Île-de-France", absent: true }
      - app.back
      - app.call: { command: network, params: { state: "on" }, expect: { online: true } }
      - app.press: Weather
      - app.swipe: down
      - app.wait: { request: "GET /v1/forecast" }
      - app.see: { text: "No Internet", absent: true }
      - app.see: { text: "0.2°C" }
expected:
  - Offline, the app keeps the saved forecast and says so; online again, it refreshes.

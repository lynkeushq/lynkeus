---
id: rain-hourly-daily
title: "Rain: the hourly strip from the current hour, another hour picked, a day's page and the 12-day list"
description: >
  The forecast opens on the hour the server's clock says it is in Berlin (the recorded answer's Date header, which
  the app corrects the device clock with). Picking another hour moves the details to it; a day of the week opens
  that day's page, and the 12-day forecast lists every day.
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
  - app.see: { text: "Mon, Nov 23, 2026" }
  # Each hour's key ends in the selected hour: 9, the hour it is in Berlin by the server's clock.
  - app.see: { testId: "hour-0-9", text: "00:00 Mon" }
  - app.see: { testId: "aqi-9" }
  - app.press: "#hour-3-9"
  - app.wait: "#aqi-3"
  - app.see: { testId: "hour-3-3", text: "03:00 Mon" }
  - app.press: Tomorrow
  - app.wait: route:DailyCardInfo
  - app.see: { text: "Tue, Nov 24, 2026" }
  - app.see: { text: "Tuesday, November 24" }
  - app.back
  - app.wait: route:/
  - app.press: "12-day weather forecast"
  - app.wait: route:DailyCardList
  - app.see: { text: "Tuesday, November 24" }
  - app.wait: { target: "Thursday, December 3", scroll: true }
  - app.back
  - app.wait: route:/
expected:
  - The hourly strip starts at the recorded hour, a picked hour moves the details, and the daily pages open and close.

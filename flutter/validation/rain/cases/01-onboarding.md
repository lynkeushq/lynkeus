---
id: rain-onboarding
title: "Rain: first launch, the three onboarding pages, then a city found by search"
description: >
  A fresh install shows the onboarding carousel. Next twice reaches the last page, whose button starts; the app asks
  where to show the weather, and a city found by name (Open-Meteo's geocoding API) fills the form. Done saves it and
  the home screen shows that city's weather for the day the forecast was fetched.
---
steps:
  - app.wait: '"Weather application with an up-to-date forecast for each hour, day, and week for any location."'
  - app.see: { text: "Skip" }
  - app.press: Next
  - app.wait: '"Convenient Design"'
  - app.press: Next
  - app.wait: '"Contact Us"'
  - app.see: { text: "Skip", absent: true }
  - app.press: "Get Started"
  - app.wait: route:/geolocation
  - app.see: { text: "Find your city" }
  - app.type: { target: "Search...", text: "Berlin", clear: true, paste: true }
  - app.press: '"Berlin, State of Berlin"'
  - app.see: { target: "City", text: "Berlin" }
  - app.see: { target: "Latitude", text: "52.52437" }
  - app.press: Done
  - app.wait: route:/
  - app.wait: '"Berlin, State of Berlin"'
  - app.see: { text: "Mon, Nov 23, 2026" }
  - app.see: { text: "Air quality" }
expected:
  - The onboarding leads to the city picker, and the picked city's forecast opens on the home screen.

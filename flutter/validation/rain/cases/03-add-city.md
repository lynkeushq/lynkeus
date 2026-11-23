---
id: rain-add-city
title: "Rain: add a city on the Cities tab by searching for it"
description: >
  The Cities tab starts empty. The add button opens a sheet whose search field asks Open-Meteo's geocoding API; a
  suggestion fills the form, and Done adds the city's card with its forecast.
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
  - app.press: Cities
  - app.wait: '"Add a city"'
  - app.press: "#add-city"
  - app.wait: '"Search or enter city data manually"'
  - app.see: { text: "Done" }
  - app.type: { target: "Find your city", text: "Paris", clear: true, paste: true }
  - app.press: '"Paris, Île-de-France"'
  - app.see: { target: "City", text: "Paris" }
  - app.see: { target: "District", text: "Île-de-France" }
  - app.press: Done
  - app.wait: { target: '"Search or enter city data manually"', gone: true }
  - app.wait: '"Paris"'
  - app.see: { text: "Add a city", absent: true }
expected:
  - The searched city is added to the Cities tab with its forecast.

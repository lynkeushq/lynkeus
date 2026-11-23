---
id: rain-reorder-delete
title: "Rain: reorder two cities by dragging, then delete one with a swipe and a confirmation"
description: >
  Adds Paris and Tokyo on the Cities tab, drags Tokyo above Paris (a long press, then a slow drag, as the reorderable
  list wants), swipes Tokyo's card away, confirms the deletion, and sees Paris alone.
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
  - app.type: { target: "Find your city", text: "Paris", clear: true, paste: true }
  - app.press: '"Paris, Île-de-France"'
  - app.press: Done
  - app.wait: '"Paris"'
  - app.press: "#add-city"
  - app.type: { target: "Find your city", text: "Tokyo", clear: true, paste: true }
  - app.press: '"Tokyo, Tokyo"'
  - app.press: Done
  - app.wait: '"Tokyo"'
  # The cards in their order, top first: each says the time in its city.
  - app.see: { target: "Time in the city", nth: 0, text: "Paris" }
  - app.see: { target: "Time in the city", nth: 1, text: "Tokyo" }
  # The list starts a drag on a long press: a slow drag stays within the touch slop for the first half second.
  - app.swipe: { target: "Tokyo", direction: up, distance: 160, duration: 6000 }
  - app.see: { target: "Time in the city", nth: 0, text: "Tokyo" }
  - app.see: { target: "Time in the city", nth: 1, text: "Paris" }
  - app.swipe: { target: "Tokyo", direction: left }
  - app.wait: '"Are you sure you want to delete the city?"'
  - app.press: Delete
  - app.wait: { target: '"Tokyo"', gone: true }
  - app.see: { target: "Time in the city", nth: 0, text: "Paris" }
  - app.see: { target: "Time in the city", nth: 1, absent: true }
expected:
  - The dragged city moves above the other, and a confirmed swipe deletes it.

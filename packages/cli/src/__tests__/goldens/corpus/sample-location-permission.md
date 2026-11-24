---
id: sample-location-permission
title: "The location button with the permission denied, then allowed when asked"
description: >
  On the place picker, the location button asks for the phone's position. With the permission denied (a host's
  location stand-in), the app says it cannot get the location and leaves the form empty. Allowed when asked, the
  position of the Simulator's or the emulator's default place fills the form, and Done shows that place.
---
steps:
  - app.wait: '"Skip"'
  - app.press: Skip
  - app.wait: '"Pick a place"'
  - on: has:location
    do:
      - app.call: { command: location, params: { permission: denied } }
      - app.press: "#locate"
      - app.wait: '"Turn on the location service to use your current place."'
      - app.see: { target: "Latitude", text: "" }
      - app.call: { command: location, params: { permission: denied, request: whileInUse }, expect: { request: whileInUse } }
  - app.press: "#locate"
  - on: ios
    do:
      - app.see: { target: "Latitude", text: "37.33233141" }
      - app.see: { target: "Longitude", text: "-122.0312186" }
      - app.see: { target: "City", text: "Cupertino" }
  - on: android
    do:
      - app.see: { target: "Latitude", text: "37.4219983" }
      - app.see: { target: "City", text: "Mountain View" }
  - on: has:location
    do:
      - app.call: { command: location, expect: { permission: whileInUse } }
  - app.press: Done
  - app.wait: route:/
  - on: ios
    do:
      - app.wait: '"Cupertino, California"'
  - on: android
    do:
      - app.wait: '"Mountain View, California"'
  - app.see: { text: "Mon, Nov 23, 2026" }
expected:
  - Denied, the location button leaves the form empty and says why; allowed, it fills the form with the phone's place.

# Randomness in the app: screens that change between seeded runs

A screen that still changes between seeded runs on an attached device usually draws from `Math.random` or `Date.now()` itself (a picked image, a generated id). Grep the app for them; deriving the value from data (a hash of an id) makes it stable for users too.

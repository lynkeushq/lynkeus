# Headless: stuck on the splash, or an env change has no effect

- Never leaves the splash: a native module nobody mocks (`headless doctor`, `--fix` writes stubs), or a backend on `localhost` that Node reads as IPv6 (use `127.0.0.1`). A jest error you do not know: `headless doctor --explain "<first line>"`.
- An environment variable change has no effect: Babel inlined the old value; remove `.lynkeus/jest-cache/`.

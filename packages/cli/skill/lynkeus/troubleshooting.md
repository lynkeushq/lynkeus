# Troubleshooting

After a failed `press`, `wait`, `type` or `see`, the error already says why; `why <target>` asks again. Read that before reading the screen again.

**A press does nothing.** The element may be covered (`~covered` in `screen`), disabled (`!disabled`) or not presented (counted in the header as hidden; `screen --all` lists them): close what is open or target something inside it.

**`+system` in the header, a view the app did not draw.** A system alert or a native SDK's sheet is in front. When it runs in the app's process its words are listed (`~system`): press its button by text, or add it to `cases.interruptions`. When another process draws it (iOS's "Save Password?"), nothing in the app can tap it: sign in through an app command (`qa.register`) so the suite never meets it. A case that starts under such a view is relaunched before its first step.

**`the app went to the background`.** A control opened a link or another app. `os appstate active` brings it back; in a run, the next case brings the app to the front itself. `crawl` reports such a control and never presses it again.

**A text does not match.** A paragraph matches only by its whole text: `app.see` with `contains: true`. A capitalized bare word is a route (`'"Next"'` is the text). `why` names the closest text on screen.

**A wait times out on a screen that is there.** The route name comes from the navigation adapter: `screen` shows the real one.

**Port already taken / no app attaches.** `status` names the process holding the port (pid, command, its project). Another Lynkeus serving another project cannot drive this app (tokens differ): stop it, or set `LYNKEUS_PORT` on both the app or host and the driver. An app that connects and stays silent was bundled with another token: restart Metro with `--reset-cache`. `lynkeus: the app passed a token and it is empty` means the bundle never got the token: `init` again, then rebuild and restart Metro.

**Two hosts on one port take turns.** Stop the one left running, or give each its own `LYNKEUS_PORT`.

**Headless: native values the host does not know.** Each run lists them with a `nativeMocks` snippet whose value is `null`. Find the real value in the library's native code under `node_modules` (`constantsToExport`, the iOS or Android source), then `{ "value": … }`, `{ "ios": …, "android": … }` or `{ "absent": true }` in `cases.nativeMocks`. Tell the person: it is their call.

**Headless: the app never leaves the splash.** A native module nobody mocks: `headless doctor` (`--fix` writes stubs). A backend on `localhost` that Node reads as IPv6: use `127.0.0.1`. A jest error you do not know: `headless doctor --explain "<first line>"`.

**Headless: an environment variable change has no effect.** Babel inlined the old value: remove `.lynkeus/jest-cache/`.

**Cases see each other's state.** On a shared headless host (`--host`, `--keep-hosts`) state at module scope survives the reset between cases: use `--host-command` without `--keep-hosts`, a host per case.

**A long run.** `case status` says where it is; `case stop` stops it. A run with `--host` restarts a host that died; the failed case's reasons carry its last words and log.

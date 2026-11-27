# Headless: hosts, --host-command, --jobs, limits

`headless init` installs jest, Testing Library and `lynkeus-headless` and writes the entry (an Expo Router app too); `headless doctor` lists native modules still to mock. Then:

- `case run --host`: starts a host for the run and stops it after; with `--jobs N`, one host per job. Each dials a free port of its own, so a device app attached on the configured port is never mixed in.
- `case run --jobs 4 --host-command 'LYNKEUS_PORT={port} npx lynkeus headless start'`: a fresh host per case (`{port}` is where it dials, `{job}` the job). `--keep-hosts` starts each job's host once (faster; reset before each case, but module-scope state survives: drop it if cases see each other).
- A host that dies or passes `--host-heap` percent of its heap is started again before the next case.

Headless cannot tell you about real native views and gestures, a WebView's content, native crashes or pixels: run those cases on a device.

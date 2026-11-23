# Conformance cases

The cases every runtime's sample app passes headless, from this one folder: the same files, unchanged, whatever the
runtime. A runtime is supported when its sample passes them on its own host in its own workflow; adding a runtime
means passing these, not running the other runtimes' suites again.

The sample app they expect (see `flutter/sample` for one):

- Home: a text `Count: <n>`, buttons `#increment`, `#send`, `#open-list`, `#open-settings`, `#delete`; an input
  `#name`. `#send` shows `Code sent to <name>` and `Resend in <n>`, counting down from 3 s to a `Resend now` button.
- `#open-list` opens `Items` with rows `Item 1` to `Item 50` (at least); pressing a row goes back and shows
  `Picked <row>`. The system back leaves the list.
- `#delete` opens a dialog (layer test id `confirm-delete`) that asks `Delete everything?` and hides the screen under
  it; `#confirm` closes it and shows `Everything was deleted`.
- `#open-settings`: `Remember me: off|on` toggled by `#remember` and kept across leaving the screen; `#check-link`
  shows `Help link: available`, and on a host `#open-help` shows `Opened help` and records the URL for the `launched`
  command.
- Commands: `reset` (back to Home, count 0) and, on a host, `launched` (`{ urls: [...] }`).

Who runs them: `.github/workflows/flutter.yml` (`headless-e2e`) for Flutter. React Native's example app (`example/`)
is a different app and does not run them yet.

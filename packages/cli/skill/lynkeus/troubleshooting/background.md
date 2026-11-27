# The app went to the background, or is gone

A control opened a link or another app. `os appstate active` brings it back; in a run, the next case brings the app to the front itself. `crawl` reports such a control and never presses it again.

`the app is still running but its JavaScript has not attached again`: commands wait up to 60 s for an app that is reloading (its process still runs) or that Lynkeus relaunched; past that, look at Metro (still bundling, a red screen). `the app is gone`: its process exited; open the app again.

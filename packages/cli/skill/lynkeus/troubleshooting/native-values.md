# Native values the host does not know

On FastSim and headless, each run lists the native constants the app read that the host could not answer (FastSim answers a constant as true, headless as undefined), each as `Module.name` with a `nativeMocks` snippet whose value is `null`. A member the app read and never called, which the library's TurboModule spec declares a method, is left out: nothing is wrong with it. The same list is `nativeValues` in the run's `run.json`.

Find the real value in the library's native code under `node_modules` (`constantsToExport`, the iOS or Android source that defines it), then put `{ "value": … }`, `{ "ios": …, "android": … }` or `{ "absent": true }` in `cases.nativeMocks` and run again. Tell the person: it is their call.

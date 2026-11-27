# Headless: native values the host does not know

Each run lists them with a `nativeMocks` snippet whose value is `null`. Find the real value in the library's native code under `node_modules` (`constantsToExport`, the iOS or Android source), then `{ "value": … }`, `{ "ios": …, "android": … }` or `{ "absent": true }` in `cases.nativeMocks`. Tell the person: it is their call.

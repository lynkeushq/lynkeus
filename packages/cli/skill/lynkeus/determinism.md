# Same run, same result

## Launch facts

The facts the app would take from the machine, pinned per run:

| Flag | Config (`launch` in `lynkeus.config.json`) | Environment |
|---|---|---|
| `--seed <text>` | `seed` | `LYNKEUS_SEED` |
| `--locale <tag>` (es-AR) | `locale` | `LYNKEUS_LOCALE` |
| `--time-zone <zone>` (Europe/Madrid) | `timeZone` | `LYNKEUS_TIME_ZONE` |
| `--epoch <iso or ms>` | `epoch` | `LYNKEUS_EPOCH` |

```json
"launch": { "seed": "suite-1", "locale": "en-US", "timeZone": "UTC", "epoch": "2026-01-15T12:00:00Z" }
```

- They reach the app on a host the run starts (`--host`, `--host-command`, `--on headless|fastsim`). Headless feeds the locale and time zone to expo-localization, react-native-localize and `Intl`, and starts the clock at the epoch.
- A host started for one case gets the seed made the case's own (`<seed>:<case id>`), so the app's `Math.random` differs between cases, as fresh installs would, and repeats between runs.
- An attached Simulator or emulator keeps its own language, zone, clock and `Math.random`; `run.json` lists what it could not apply under `launch.unsupported`. Pin its language with `os language <tag>`.
- With a seed, `{{random.letters}}` and `{{random.digits}}` in a case repeat run to run.

## Randomness in the app

A screen that still changes between seeded runs on an attached device usually draws from `Math.random` or `Date.now()` itself (a picked image, a generated id). Grep the app for them; deriving the value from data (a hash of an id) makes it stable for users too.

## Frames two runs are compared by

```sh
npx lynkeus case run --out run-a --screenshots --frames png --settle 700 --still 300
```

`--settle` waits for the app to stop committing before a frame; `--still` takes it again until two in a row match (a native transition the agent cannot see). A Simulator still differs in animations, blur and system banners; pixel-stable frames need FastSim.

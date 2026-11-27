# Launch facts: seed, locale, time zone, epoch

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
- A host started for one case gets the seed made the case's own (`<seed>:<case id>`): `Math.random` differs between cases, as fresh installs would, and repeats between runs.
- An attached Simulator or emulator keeps its own language, zone, clock and `Math.random`; `run.json` lists what it could not apply under `launch.unsupported`. Pin its language with `os language <tag>`: every relaunch Lynkeus makes keeps it (iOS gets the same launch arguments again; Android keeps the app's locale itself).
- With a seed, `{{random.letters}}` and `{{random.digits}}` in a case repeat run to run.

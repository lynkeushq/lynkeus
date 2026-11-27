# Where a case must pass: cases.targets and --on targets

The project decides, once, in `lynkeus.config.json`:

```json
"cases": { "targets": ["fastsim:ios", "fastsim:android"] }
```

Targets: `headless`, `fastsim:ios`, `fastsim:android`, `ios` (the app on the iOS Simulator or an iPhone), `android` (the app on the Android emulator or a phone). A case that needs something else (a device-only feature) says so in its frontmatter: `targets: [ios]`. With none declared, ask the person which matter; `status` proposes a value and `init` writes that proposal.

```sh
npx lynkeus case run cases/sign-out.md --on targets   # each case on its declared targets, at once
```

One line per case per target. A declared target this machine cannot run on is named with why and the check is incomplete (the run fails): never call such a case done. Do not run other targets to be thorough.

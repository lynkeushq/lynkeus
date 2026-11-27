# --on all, or named targets

```sh
npx lynkeus case run cases/sign-out.md --on all      # or --on ios,headless
```

`--on all` runs every target this machine has, instead of the project's (a missing one is named and fails nothing); `--on ios,headless` names them. One line per case per target. `ios` and `android` run side by side (both apps dial the driver port; each gets its own connection); `simulator` is whichever device app is attached; `fastsim` the last bundle. `--on` starts its own hosts, so it refuses `--host`, `--host-command`, `--keep-hosts` and `--ports`; `--jobs` gives each target that many.

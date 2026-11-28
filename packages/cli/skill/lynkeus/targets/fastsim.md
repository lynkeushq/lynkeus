# FastSim: install, bundle, run, refusals

Optional and paid (Team plan); use it when the person asks or the organization has it. `fastsim install --platform ios|android` needs the sign-in a member saved with `lynkeus login` in a terminal (you cannot: ask) or, in CI, `LYNKEUS_CLOUD_KEY`. Then read the README in the folder it answers:

- `bin/fastsim-bundle` makes a release bundle (`__DEV__` false, so `qa.register` must not sit inside `if (__DEV__)`).
- `case run --on fastsim:ios` (or `fastsim:android`; it finds the kit and that platform's last bundle) and `--host-command '<kit>/bin/fastsim-run <bundle> {port}'` give every case a FastSim host of its own: nothing carries over from the case before, `--keep-hosts` or not. A bundle whose inputs changed, or with no token, is bundled again first (in this environment: set `EXPO_PUBLIC_` vars), or the run is refused with the command: never report on old code.
- `fastsim start <bundle folder>` starts a host on its own port to look around: until `fastsim stop` the session drives only it (answers start `[FastSim iOS]`).
- iOS matches the simulator only on a Mac.
- No network past this machine: mock other servers (`app.mock`).

When the service refuses (no FastSim in the plan, no seat, a key without "May download Lynkeus FastSim"), tell the person what it said and carry on with headless or a device; never retry with other credentials.

# Cases see each other's state, or a long run

- On a shared headless host (`--host`, `--keep-hosts`) module-scope state survives the reset between cases: use `--host-command` without `--keep-hosts`, a host per case. FastSim always starts a host per case.
- A long run: `case status` says where it is; `case stop` stops it. A run with `--host` restarts a host that died; the failed case's reasons carry its last words and log.

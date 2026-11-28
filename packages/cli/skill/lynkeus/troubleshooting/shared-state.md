# Cases see each other's state, or a long run

- On a shared headless host (`--host`, `--keep-hosts`) module-scope state survives the reset between cases: use `--host-command` without `--keep-hosts`, a host per case. FastSim always starts a host per case.
- A long run: `case status` says where it is; `case stop` stops it, as cancelling the MCP call does. Over MCP a run stops after `budget` seconds (1500 unless given) and names the cases it did not reach: run those in another call. A step stuck past its `timeoutMs` plus 30 s (else 180 s, `cases.stepCeilingMs`) fails. A run with `--host` restarts a host that died; the failed case's reasons carry its last words and log.

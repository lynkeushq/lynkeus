# lynkeus ci: a CI job with backend, hosts, report

`lynkeus ci` runs the suite as a CI job: the backend up with the project's command, N hosts, the cases spread across them, the report, a job summary (`$GITHUB_STEP_SUMMARY`), teardown, and the suite's exit code.

```json
"ci": {
  "backend": { "up": "./scripts/backend up", "down": "./scripts/backend down", "ready": "http://127.0.0.1:3000/health" },
  "hosts": { "count": 4 },
  "push": true
}
```

```yaml
- uses: actions/checkout@v4
  with: { fetch-depth: 0 }                # --affected diffs against the base
- run: npx lynkeus ci --affected --base origin/${{ github.base_ref }}
  env:
    LYNKEUS_TOKEN: ${{ secrets.LYNKEUS_TOKEN }}             # .lynkeus/token is kept out of git
    LYNKEUS_REPORTS_KEY: ${{ secrets.LYNKEUS_REPORTS_KEY }} # only with push
```

- With `cases.targets`, each case runs on its declared `headless` and FastSim targets, one after the other (`<out>/<target>`); a declared FastSim target CI cannot start fails the job as incomplete. `ios` and `android` need a device: listed, not run.
- Without it, hosts are headless unless `ci.hosts.command` starts another (`{port}` is where it dials); `ci.run` adds `case run` flags.
- `--affected` runs only the cases the changes reach; `--dry-run` says what it would do.
- FastSim in CI needs `LYNKEUS_CLOUD_KEY` (an owner's key with "May download Lynkeus FastSim").

# Changes and CI

## The cases a change reaches

After changing the app's code, or to review a branch:

```sh
npx lynkeus case impact --base main                     # the cases the diff reaches, and reached screens no case covers
npx lynkeus case run $(npx lynkeus case impact --base main --files)
```

It crosses the screens the diff touches or imports with the screens each case covers (`case run` keeps those in `.lynkeus/seen`). A change to a string table counts only for the keys and texts it changed; a change that is only testIDs or accessibility labels reaches only the cases that name them. Run what it lists, fix what broke, and write a case for each reached screen no case covers (`case new`).

## In CI

`lynkeus ci` runs the suite the way a CI job wants: the project's backend up with the project's own command, N hosts of the app, the cases spread across them, the report, a job summary (`$GITHUB_STEP_SUMMARY`), everything torn down, and the suite's exit code.

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

- With `cases.targets`, each case runs on its declared `headless` and FastSim targets, one after the other (`<out>/<target>`); a declared FastSim target CI cannot start fails the job as incomplete. `ios` and `android` need a device and are listed, not run.
- Without it, hosts are headless unless `ci.hosts.command` starts another (`{port}` is where it dials); `ci.run` adds `case run` flags.
- `--affected` runs only the cases the changes reach; `--dry-run` says what it would do.
- FastSim in CI needs `LYNKEUS_CLOUD_KEY` (an owner's key with "May download Lynkeus FastSim").

`lynkeus map ci` writes `.github/workflows/lynkeus-map-check.yml`: on each pull request it builds the route map from source (no app, no device) and keeps one comment saying which screens the diff reaches. `map ci --cases` adds a job that runs `lynkeus ci --affected` on the project's CI targets (installing and bundling FastSim first); it needs `LYNKEUS_TOKEN`, `LYNKEUS_CLOUD_KEY` for FastSim and `LYNKEUS_REPORTS_KEY` with `ci.push` as secrets, and a backend (`ci.backend`). Suggest it; adding it is the person's call.

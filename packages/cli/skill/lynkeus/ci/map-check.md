# map ci: a route-map check on each pull request

`lynkeus map ci` writes `.github/workflows/lynkeus-map-check.yml`: on each pull request it builds the route map from source (no app, no device) and keeps one comment saying which screens the diff reaches.

`map ci --cases` adds a job that runs `lynkeus ci --affected` on the project's CI targets (installing and bundling FastSim first). It needs `LYNKEUS_TOKEN`, `LYNKEUS_CLOUD_KEY` for FastSim and `LYNKEUS_REPORTS_KEY` with `ci.push` as secrets, and a backend (`ci.backend`). Suggest it; adding it is the person's call.

# Contributing

Lynkeus is published for anyone to use under the [MIT license](LICENSE), but the repository does not take contributions. Issues are disabled and pull requests are closed automatically. If you need a change, fork the repository.

## Development

The repository is a pnpm workspace:

- `packages/protocol`, `packages/client`, `packages/agent`, `packages/headless` and `packages/cli`: the published packages.
- `example/`: a React Native app that mounts the agent from source.
- `website/`: the documentation site.

Use the Node version in [`.nvmrc`](.nvmrc) and the pnpm version `packageManager` names in `package.json`
(Node 26 ships without corepack: `npm install -g pnpm@<that version>`, or `mise use pnpm@<that version>`), then:

```sh
pnpm install       # install every workspace
pnpm lint          # Biome
pnpm typecheck     # builds the packages, then type-checks each one
pnpm test          # builds the packages, then runs each one's tests
pnpm build         # builds every package
```

The example app picks up JavaScript changes through Metro. Native changes in `packages/agent/ios` or `packages/agent/android` need a rebuild: `pnpm example ios` or `pnpm example android`.

`docs/COMMANDS.md` is generated from the CLI: run `pnpm --filter lynkeus docs` after changing a command.

A release has to be a week old before an install takes it (`minimumReleaseAge` in `pnpm-workspace.yaml`); Dependabot proposes
updates weekly with the same cooldown.

## Releasing the Dart packages

The npm packages go out from CI when a `v*` tag is pushed (`.github/workflows/release.yml`). The three Dart packages in
`flutter/` (`lynkeus_agent`, `lynkeus_headless`, `lynkeus_plugins`) share that version line and are published to pub.dev
by hand, because pub.dev needs a maintainer's login and no workflow holds one.

1. In the release commit, set `version:` to the new version in the three `pubspec.yaml` files, change the two dependents'
   `lynkeus_agent: ^x.y.z` to the same version, and rename the `## 0.7.5` heading of each `CHANGELOG.md` (the first
   entry) or add a heading for the new version.
2. Tag the release commit `vX.Y.Z`, check that CI is green on it, and `dart pub login` once.
3. Run `hack/release/publish-flutter-packages.sh --dry-run`, then `hack/release/publish-flutter-packages.sh --yes-publish`.
   It refuses without a clean tree on a tagged commit, publishes in dependency order and waits for `lynkeus_agent` to be
   listed before it publishes the other two.

`lynkeus_headless` and `lynkeus_plugins` ask pub.dev for `lynkeus_agent`; their `pubspec_overrides.yaml` points that at the
sibling folder for development and CI, and pub leaves it out of the published package. Until `lynkeus_agent` is on pub.dev,
their `dart pub publish --dry-run` runs with the override and reports a hint about it. Once the packages are published,
`lynkeus init` can stop writing git dependencies (`gitDependency` in `packages/cli/src/commands/initFlutter.ts`).

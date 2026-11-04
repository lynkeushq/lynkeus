# Contributing

lynkeus is published for anyone to use under the [MIT license](LICENSE), but the repository does not take contributions. Issues are disabled and pull requests are closed automatically. If you need a change, fork the repository.

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

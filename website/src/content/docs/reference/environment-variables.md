---
title: Environment variables
description: Every environment variable lynkeus reads or sets, which part reads it, and what it changes.
---

lynkeus reads a small number of environment variables. Most of them carry what differs between machines and should not be committed: a secret, a port, a key. This page lists each one, says which part of lynkeus reads it, and what it does.

Three parts can read the environment, and it matters which:

- The **CLI**: the `lynkeus` command, on your machine or in CI.
- The **headless host**: the app running in Node, started by `lynkeus headless start`.
- **Your app**: the agent itself reads no environment variable. It receives its options from your code (`auto({ token, port })`), and your code decides where those values come from. React Native gives the app no environment at all, so a variable reaches the app only if something writes its value into the bundle when the bundle is made. For the token, the `lynkeus-agent/babel` plugin does that.

## Summary

| Variable | Read by | Purpose |
|---|---|---|
| [`LYNKEUS_TOKEN`](#lynkeus_token) | CLI, headless host, Metro through `lynkeus-agent/babel` | The shared secret between the app and its driver. |
| [`LYNKEUS_PORT`](#lynkeus_port) | CLI, headless host | The port the driver listens on. |
| [`LYNKEUS_HOST`](#lynkeus_host) | headless host | Where the driver is listening. |
| [`LYNKEUS_DEVICE`](#lynkeus_device) | CLI | The simulator to use. |
| [`LYNKEUS_APP_ID`](#lynkeus_app_id) | CLI | The app's bundle id. |
| [`LYNKEUS_ATTACH_TIMEOUT_MS`](#lynkeus_attach_timeout_ms) | CLI | How long to wait for the app to attach. |
| [`LYNKEUS_CONFIG`](#lynkeus_config) | CLI | A second configuration file. |
| [`LYNKEUS_SEED`](#lynkeus_seed) | CLI | Makes random values in cases repeatable. |
| [`LYNKEUS_RECORD_SCREENS`](#lynkeus_record_screens) | CLI | Records the structure of every screen read. |
| [`LYNKEUS_REPORTS_URL`](#lynkeus_reports_url-and-lynkeus_reports_key) | CLI | The address of the hosted report service. |
| [`LYNKEUS_REPORTS_KEY`](#lynkeus_reports_url-and-lynkeus_reports_key) | CLI | The organization's API key for that service. |

Where a value can also be given as a flag or in `lynkeus.config.json`, flags win over the environment, and the environment wins over the file.

## Connection

### `LYNKEUS_TOKEN`

The shared secret between the app and its driver. When the app was mounted with a token, it serves only a driver that presents the same one.

- The **CLI** reads it and presents it to the app when the app attaches.
- **`lynkeus headless start`** requires it and refuses to start without it. The hosted app uses its value as the agent's token.
- **Your app** gets the token from your code. The common form is `auto({ token: process.env.LYNKEUS_TOKEN })`. Inside a React Native bundle that expression is `undefined` unless something writes the value there.
- **Metro**, when `babel.config.js` lists the `lynkeus-agent/babel` plugin, reads it while it transforms your code and writes its value wherever the app reads `process.env.LYNKEUS_TOKEN`. It does so in a development bundle only, never a release one. `lynkeus init` adds the plugin. Since 0.3.0.

```bash
export LYNKEUS_TOKEN=$(openssl rand -hex 16)
```

Set it in the shell that starts Metro as well as in the one that runs the CLI. Metro keeps what it has transformed, so after the value changes, start Metro once with `--reset-cache`.

Both ends must hold the same value. When they do not, the app never attaches. See [Security](/security/) for what the token protects.

:::caution[Since 0.3.0]
If the app passes a token and the value arrives empty, because Metro was started without the variable, the plugin is missing, or Metro's cache is stale, the agent stays off and the app logs `lynkeus: the app passed a token and it is empty`. It never falls back to serving any driver. See [Troubleshooting](/troubleshooting/#the-app-logs-lynkeus-the-app-passed-a-token-and-it-is-empty).
:::

:::note
In an Expo app, only variables that start with `EXPO_PUBLIC_` are inlined into the bundle. The app reads the token from `EXPO_PUBLIC_LYNKEUS_TOKEN`, and the CLI still reads `LYNKEUS_TOKEN`. Set both to the same value. An Expo app does not need the Babel plugin.
:::

### `LYNKEUS_PORT`

The port the driver listens on and the app dials. Default: `port` in `lynkeus.config.json`, else `8123`.

- The **CLI** listens on it.
- **`lynkeus headless start`** writes it into the host it starts, so the host and its driver move together.
- **Your app** on a simulator or an emulator dials the `port` you pass to `auto()` or `<Lynkeus>`. To move it, change that option too.

Use it to run several app and driver pairs on one machine: each pair gets its own port.

```bash
LYNKEUS_PORT=8124 LYNKEUS_TOKEN=secret lynkeus headless start
LYNKEUS_PORT=8124 LYNKEUS_TOKEN=secret lynkeus screen
```

### `LYNKEUS_HOST`

Read by the headless host. It says where the driver is listening, for a host that does not run in the same place as its driver, such as a container dialing out. Without it, the host dials the agent's default address.

### `LYNKEUS_DEVICE`

Read by the CLI. The simulator to use, by udid or by name. The same as `--device` and as `device` in `lynkeus.config.json`. Without any of them, the CLI takes the first booted simulator.

### `LYNKEUS_APP_ID`

Read by the CLI. The app's bundle id (iOS) or application id (Android), used to launch the app and by the simulator commands. The same as `--app` and as `app` in `lynkeus.config.json`.

### `LYNKEUS_ATTACH_TIMEOUT_MS`

Read by the CLI. How long, in milliseconds, a command waits for the app to attach before it gives up. The same as `--attach-timeout` and as `attachTimeout` in `lynkeus.config.json`. Default: `15000`.

## Configuration and cases

### `LYNKEUS_CONFIG`

Read by the CLI. The path of a second configuration file, read after the app's own `lynkeus.config.json`. Each top-level key it defines replaces the app's key of the same name, and the paths under its `cases` are relative to it.

Use it when tests and fixtures live in a repository of their own:

```bash
LYNKEUS_CONFIG=../myapp-tests/lynkeus.config.json lynkeus case run
```

See [Configuration](/reference/configuration/).

### `LYNKEUS_SEED`

Read by the CLI when it runs cases. With it set to anything, `{{random.letters}}` and `{{random.digits}}` give the same values on every run of a case. Each case still draws different values from the case beside it. Without it, the values are new on every run.

Use it when you compare the screens of two runs: the names and numbers on them are then the same.

```bash
LYNKEUS_SEED=1 lynkeus case run --out run --screenshots
```

:::note[Since 0.3.0]
`LYNKEUS_SEED` arrived in version 0.3.0.
:::

### `LYNKEUS_RECORD_SCREENS`

Read by the CLI. Set to `1`, every `lynkeus screen` read keeps the screen's structure under `.lynkeus/screens/` and reports what changed since the last read, as `lynkeus screen --record` does. `lynkeus map changes` reads what was kept.

Any value other than `1` leaves it off.

## Hosted reports

### `LYNKEUS_REPORTS_URL` and `LYNKEUS_REPORTS_KEY`

Read by the CLI, for `lynkeus case run --push` and every `lynkeus report` command. `LYNKEUS_REPORTS_URL` is the address of the report service. `LYNKEUS_REPORTS_KEY` is your organization's API key.

Both are required. Without them, those commands stop with:

```text
set LYNKEUS_REPORTS_URL and LYNKEUS_REPORTS_KEY (the organisation’s API key)
```

```bash
export LYNKEUS_REPORTS_URL=https://lynkeus.io
export LYNKEUS_REPORTS_KEY=lk_…
lynkeus case run --out run --screenshots --push
```

The key is a secret: in CI, keep it in the CI's secret store. See [Reports](/guides/reports/).

## Variables that are not lynkeus's own

lynkeus reads or sets a few variables that belong to other tools.

| Variable | Read or set by | What happens |
|---|---|---|
| `GITHUB_HEAD_REF`, `GITHUB_REF_NAME` | CLI, `case run --out` | The branch written into `run.json`, in that order of preference. Outside GitHub Actions, the branch comes from `git`. |
| `NODE_OPTIONS` | CLI, `headless start` | The CLI appends `--dns-result-order=ipv4first` for the host it starts, because Node resolves `localhost` to IPv6 first and local backends usually listen on IPv4 only. What you set is kept. |
| `CI` | CLI, `headless start` | Set to `1` for the jest process that hosts the app. |
| The variable named by `apiEnv` (default `API_URL`) | The generated headless entry | The entry refuses to start unless this variable points at `localhost`, `127.0.0.1` or `10.0.2.2`. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Your backend | Not read by lynkeus. With `case run --traces`, point your backend's exporter at `http://localhost:4318` (or the port given with `--traces-port`). |
| `EXPO_PUBLIC_LYNKEUS_TOKEN` | Your Expo app | Not read by lynkeus. It is how an Expo app receives the token: Expo inlines it, with no Babel plugin. Start the development server with it set to the value of `LYNKEUS_TOKEN`. |

Three more places hand the environment through:

- `{{env.NAME}}` in a case reads any variable of the process running `lynkeus case run`.
- The fixtures command and `exec` steps inherit the CLI's environment. `cases.fixtures.env` in `lynkeus.config.json` adds to it for the fixtures command.
- The headless host inherits the CLI's environment, so the variables your app reads are the ones you exported before `lynkeus headless start`.

:::caution
If your babel configuration inlines environment variables, jest's transform cache keeps the first value it saw. After changing a variable the hosted app reads, remove the cache directory your jest configuration points at.
:::

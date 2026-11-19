---
title: Run cases on Lynkeus FastSim
description: Run your cases on Lynkeus FastSim, a simulator that draws the app on a Mac or Linux without Xcode's simulator or an emulator, and install it for the platform you test.
---

Lynkeus FastSim runs your React Native app without Xcode's simulator or an Android emulator. It loads the app's JavaScript, lays it out with React Native's own renderer and draws it, much faster than a simulator does. Lynkeus drives it exactly as it drives a simulator, so the same cases run on both.

## When to use it

Use FastSim when a suite takes too long on a simulator, when you want many cases side by side, or when the machine has no simulator at all, such as a Linux server or a CI runner.

It is optional and paid: Lynkeus FastSim is part of the Team plan ([plans](https://lynkeus.io/pricing)). The headless host and the simulator or emulator stay free and cover the same cases. It is available to organizations whose plan includes it, and the organization's owner decides who downloads it. You need `LYNKEUS_CLOUD_KEY` set to an API key an owner made with **May download Lynkeus FastSim** checked (on the API keys page of [lynkeus.io](https://lynkeus.io)). A key made only for reports cannot download it, so give CI a key of its own. Owners see every download, by whom and when, on the Members page, where they also give seats to members.

A member with a seat does not need a key. Run `lynkeus fastsim install` in a terminal and, when it finds no key and no saved sign-in, it opens your browser by itself (the same step as `lynkeus login`) and then goes on with the install. You can also sign in first:

```bash
lynkeus login
```

The sign-in page is lynkeus.io in your browser, where you sign in and pick the organization. The sign-in is saved in `~/.config/lynkeus/credentials.json`, readable only by you, and `lynkeus fastsim install` uses it whenever `LYNKEUS_CLOUD_KEY` is not set. It renews itself as it expires. `lynkeus logout` removes it. On a machine with no browser, `lynkeus login --no-browser` prints the address to open elsewhere. The browser only opens when you are at a terminal (stdin and stderr are terminals and `CI` is not set); a script, CI or the MCP server never waits for one: they need a key, and without one the command exits with code 2. If the saved sign-in has ended or was revoked, the install says so and signs you in once more. Pass `--no-browser` to `fastsim install` to print the address instead of opening it.

## Install it

Run the install once for each platform you test:

```bash
lynkeus fastsim install --platform ios
lynkeus fastsim install --platform android
```

The command downloads the build that fits the machine it runs on. It checks the SHA-256 and the signature and unpacks the build into `~/.cache/lynkeus/fastsim/<version>/<variant>/`. Set `LYNKEUS_FASTSIM_DIR` to move that folder.

| Machine | iOS | Android |
|---|---|---|
| Apple Silicon Mac | `darwin-arm64-ios` (about 8 MB) | `darwin-arm64-android` (about 65 MB) |
| Linux x64 or arm64 | `linux-<arch>-ios` | `linux-<arch>-android` |
| Windows | Run Lynkeus inside WSL2, where it installs the Linux build | Same |
| Intel Mac | Not supported | Not supported |

`--variant <name>` installs a build by name instead of the one for this machine. See the [command reference](/reference/cli/#lynkeus-fastsim-install) for every flag.

## Signed packages and grants

Lynkeus signs every FastSim package, and `lynkeus fastsim install` checks the signature before it unpacks anything. A package with no signature, or one that was changed after signing, is refused and nothing is written.

Each FastSim host also needs a fresh grant from lynkeus.io before it starts. `lynkeus case run` (and `case_run` over MCP) fetches it before starting the hosts, with the same key or sign-in as the install, and hands it to them, so lynkeus does not need to be installed in the project or globally: `npx -y lynkeus mcp` is enough. The grant is kept for an hour, so a suite of many cases asks the service once an hour, not once per case. If it cannot be had (no key or sign-in, no FastSim in the plan, no connection), the run stops with the reason instead of starting hosts. Running `bin/fastsim-run` by hand falls back to `npx --no-install lynkeus fastsim grant`, which does need lynkeus installed, or you can set `FASTSIM_GRANT` yourself. This means FastSim needs to reach lynkeus.io when a host starts, even on a machine where the package is already installed. You can run `lynkeus fastsim grant --platform ios` yourself to check that it works.

The Team plan includes FastSim on 5 developer machines and 4 parallel CI hosts; more cost $15 and $20 a month. The CLI sends a random id for each install (kept in `~/.config/lynkeus/machine-id`) so lynkeus.io can count them: a machine is an install that asked for a grant or a download in the last 30 days, and a CI host is one that was issued a grant in the last hour. A machine already counted keeps working. Past the limit you get a warning for now, and later a refusal that says where to add more ([plans](https://lynkeus.io/pricing), or Members). Give each CI runner its own home folder, or the same id will count as one host.

## Bundle the app and run cases

The app needs its dependencies installed and the Lynkeus agent mounted, as for a simulator. The folder the install printed has a `README.md` with the details. Two commands do the work.

Bundle the app, again after each change to its JavaScript:

```bash
<install folder>/bin/fastsim-bundle <app folder> <bundle folder> ios
```

Use `android` in place of `ios` for an Android bundle. Run it in a shell that has the environment your development build uses, such as `EXPO_PUBLIC_` variables and the backend's address. They are written into the bundle.

Then run the cases, one host per case:

```bash
npx lynkeus case run <cases> --host-command "<install folder>/bin/fastsim-run <bundle folder> {port}"
```

Lynkeus starts a host on a free port for each case, waits for the app to attach and stops the host when the case ends. `--jobs <n>` runs `n` cases side by side, each on its own host. `case run` also gives each host the run's [launch facts](/reference/cli/#launch-facts): `--seed`, `--locale`, `--time-zone` and `--epoch` reach it as environment variables, and FastSim starts with that language, zone and clock.

A host's output goes to `<bundle folder>/hosts/<port>.out` and `.err`; JavaScript errors and console lines are in the `.err` file.

## From an AI agent over MCP

The [MCP server](/guides/ai-agents/) has the same steps as tools. The agent calls `fastsim_install` with `platform` set to `ios` or `android`, with `LYNKEUS_CLOUD_KEY` in the environment the server was started in, or with the sign-in you saved by running `lynkeus login` in a terminal. The server never opens a browser: if there is no key and no saved sign-in, run `lynkeus fastsim install` or `lynkeus login` yourself in a terminal. It reads the `README.md` in the folder the tool answers, runs `bin/fastsim-bundle` to bundle the app, and calls `case_run` with `host_command` set to `<install folder>/bin/fastsim-run <bundle folder> {port}`. Add `jobs` to run cases side by side.

## What it stands in for, and its limits

FastSim has no phone's operating system under it, so it replaces the native side:

- JavaScript-only libraries run as they are.
- React Native's core components and APIs, react-native-reanimated, react-native-svg, lottie-react-native, rive-react-native, react-native-screens and the common Expo modules run on FastSim's own native side.
- A native module that FastSim has no stand-in for reads as absent, as on a phone without it. For an Expo package's module, the host's `.err` file names it with a `[fastsim] <name> has no stand-in yet` line.
- Native views FastSim does not draw, such as maps, web views and camera previews, take their place and size but show nothing.

How closely it matches a real device depends on the platform:

- **Android** is drawn by Skia, the library Android itself draws with.
- **iOS** matches the simulator pixel for pixel only on a Mac, where Apple's frameworks and fonts draw it. On Linux it is drawn with another font, so it is close but not identical.

Install and compare per platform: an iOS build tells you nothing about Android.

## Troubleshooting

**`set LYNKEUS_CLOUD_KEY to an API key an owner of your organization made with "May download Lynkeus FastSim"`.** Exit code 2. The command found neither a key nor a sign-in. Export a key, or put it under `[env]` in `mise.local.toml`, or, if you are a member with a seat, run it again from a terminal: it signs you in. This code is what a script, CI or MCP gets when there is nothing to sign in with.

**`this key may not download Lynkeus FastSim`.** The key was made without **May download Lynkeus FastSim**. Ask an owner of the organization for a key made with it.

**`you have no Lynkeus FastSim seat`.** You are signed in as a member without a seat. An owner gives seats on the Members page.

**`this sign-in may not download Lynkeus FastSim: sign in again with lynkeus login`** (or **`the sign-in was refused`**). The saved sign-in is not accepted, for example because it expired or was made before your seat. Run `lynkeus login` again.

**`this organization has no Lynkeus FastSim entitlement`** (or **has expired**). Your organization's plan does not include FastSim. Ask the organization's owner or write to lynkeus.io support.

**`Lynkeus FastSim runs on Windows inside WSL2`.** Open a WSL2 shell, install Lynkeus there and run the install again. It installs the Linux build.

**`Lynkeus FastSim runs on Apple Silicon Macs only`.** Intel Macs have no build. Use a simulator, or run FastSim on a Linux machine.

**`no Lynkeus FastSim release ... for <variant>`.** The service has no such build for your organization. The message lists what it can install.

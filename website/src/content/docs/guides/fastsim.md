---
title: Run cases on fastsim
description: Run your cases on fastsim, a simulator that draws the app on a Mac or Linux without Xcode's simulator or an emulator, and install it for the platform you test.
---

fastsim runs your React Native app without Xcode's simulator or an Android emulator. It loads the app's JavaScript, lays it out with React Native's own renderer and draws it, much faster than a simulator does. lynkeus drives it exactly as it drives a simulator, so the same cases run on both.

## When to use it

Use fastsim when a suite takes too long on a simulator, when you want many cases side by side, or when the machine has no simulator at all, such as a Linux server or a CI runner.

It is available to organizations whose plan includes it, and the organization's owner decides who downloads it. You need `LYNKEUS_CLOUD_KEY` set to an API key an owner made with **May download fastsim** checked (on the API keys page of [lynkeus.io](https://lynkeus.io)). A key made only for reports cannot download it, so give CI a key of its own. Owners see every download, by whom and when, on the Members page, where they also give seats to members.

A member with a seat does not need a key: sign in once from your terminal.

```bash
lynkeus login
```

It opens lynkeus.io in your browser, where you sign in and pick the organization. The sign-in is saved in `~/.config/lynkeus/credentials.json`, readable only by you, and `lynkeus fastsim install` uses it whenever `LYNKEUS_CLOUD_KEY` is not set. It renews itself as it expires. `lynkeus logout` removes it. On a machine with no browser, `lynkeus login --no-browser` prints the address to open elsewhere. CI should keep using a key, since nobody is there to sign in.

## Install it

Run the install once for each platform you test:

```bash
lynkeus fastsim install --platform ios
lynkeus fastsim install --platform android
```

The command downloads the build that fits the machine it runs on. It checks the SHA-256 and unpacks the build into `~/.cache/lynkeus/fastsim/<version>/<variant>/`. Set `LYNKEUS_FASTSIM_DIR` to move that folder.

| Machine | iOS | Android |
|---|---|---|
| Apple Silicon Mac | `darwin-arm64-ios` (about 8 MB) | `darwin-arm64-android` (about 65 MB) |
| Linux x64 or arm64 | `linux-<arch>-ios` | `linux-<arch>-android` |
| Windows | Run lynkeus inside WSL2, where it installs the Linux build | Same |
| Intel Mac | Not supported | Not supported |

`--variant <name>` installs a build by name instead of the one for this machine. See the [command reference](/reference/cli/#lynkeus-fastsim-install) for every flag.

## Bundle the app and run cases

The app needs its dependencies installed and the lynkeus agent mounted, as for a simulator. The folder the install printed has a `README.md` with the details. Two commands do the work.

Bundle the app, again after each change to its JavaScript:

```bash
<install folder>/bin/fastsim-bundle <app folder> <bundle folder> ios
```

Use `android` in place of `ios` for an Android bundle. Run it in a shell that has the environment your development build uses, such as `EXPO_PUBLIC_` variables and the backend's address. They are written into the bundle.

Then run the cases, one host per case:

```bash
npx lynkeus case run <cases> --host-command "<install folder>/bin/fastsim-run <bundle folder> {port}"
```

lynkeus starts a host on a free port for each case, waits for the app to attach and stops the host when the case ends. `--jobs <n>` runs `n` cases side by side, each on its own host. A host's output goes to `<bundle folder>/hosts/<port>.out` and `.err`; JavaScript errors and console lines are in the `.err` file.

## From an AI agent over MCP

The [MCP server](/guides/ai-agents/) has the same steps as tools. The agent calls `fastsim_install` with `platform` set to `ios` or `android`, with `LYNKEUS_CLOUD_KEY` in the environment the server was started in, or with the sign-in you saved by running `lynkeus login` in a terminal. An agent cannot sign in for you: the browser step is yours. It reads the `README.md` in the folder the tool answers, runs `bin/fastsim-bundle` to bundle the app, and calls `case_run` with `host_command` set to `<install folder>/bin/fastsim-run <bundle folder> {port}`. Add `jobs` to run cases side by side.

## What it stands in for, and its limits

fastsim has no phone's operating system under it, so it replaces the native side:

- JavaScript-only libraries run as they are.
- React Native's core components and APIs, react-native-reanimated, react-native-svg, lottie-react-native, rive-react-native, react-native-screens and the common Expo modules run on fastsim's own native side.
- A native module that fastsim has no stand-in for reads as absent, as on a phone without it. For an Expo package's module, the host's `.err` file names it with a `[fastsim] <name> has no stand-in yet` line.
- Native views fastsim does not draw, such as maps, web views and camera previews, take their place and size but show nothing.

How closely it matches a real device depends on the platform:

- **Android** is drawn by Skia, the library Android itself draws with.
- **iOS** matches the simulator pixel for pixel only on a Mac, where Apple's frameworks and fonts draw it. On Linux it is drawn with another font, so it is close but not identical.

Install and compare per platform: an iOS build tells you nothing about Android.

## Troubleshooting

**`set LYNKEUS_CLOUD_KEY to an API key an owner of your organization made with "May download fastsim"`.** Exit code 2. The command found neither a key nor a sign-in. Export a key, or put it under `[env]` in `mise.local.toml`, or run `lynkeus login` if you are a member with a seat, and run it again.

**`this key may not download fastsim`.** The key was made without **May download fastsim**. Ask an owner of the organization for a key made with it.

**`you have no fastsim seat`.** You are signed in as a member without a seat. An owner gives seats on the Members page.

**`this sign-in may not download fastsim: sign in again with lynkeus login`** (or **`the sign-in was refused`**). The saved sign-in is not accepted, for example because it expired or was made before your seat. Run `lynkeus login` again.

**`this organization has no fastsim entitlement`** (or **has expired**). Your organization's plan does not include fastsim. Ask the organization's owner or write to lynkeus.io support.

**`fastsim runs on Windows inside WSL2`.** Open a WSL2 shell, install lynkeus there and run the install again. It installs the Linux build.

**`fastsim runs on Apple Silicon Macs only`.** Intel Macs have no build. Use a simulator, or run fastsim on a Linux machine.

**`no fastsim release ... for <variant>`.** The service has no such build for your organization. The message lists what it can install.

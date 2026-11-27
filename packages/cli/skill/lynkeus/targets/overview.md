# Targets compared, and where to write a case

| Target | What it is | Needs |
|---|---|---|
| Simulator or emulator | a development build attached on the driver port (8123 unless `LYNKEUS_PORT`) | `init`, a build, Metro |
| Headless | the app in Node under jest, native side mocked; no device, seconds per case | `lynkeus headless init`, a local backend (`apiUrl` in `lynkeus.config.json`) |
| Lynkeus FastSim | a simulator that runs a bundle of the app on a Mac or Linux without Xcode or an emulator; pixel-stable | the organization's Team plan, `fastsim install` |

`status` lists which this machine has and the one fix for each missing. Write a case where it is cheapest and most reliable (FastSim when the organization has it, else headless), and on a Simulator or emulator when it needs what only a device has: real native views, system prompts, pixels, a camera.

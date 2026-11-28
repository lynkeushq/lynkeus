# Frames two runs can be compared by

```sh
npx lynkeus case run --out run-a --screenshots --frames png --settle 700 --still 300
```

Over MCP: `case_run` with `out`, `screenshots: true`, `frames: "png"`, `settle: 700`, `still: 300` (the CLI cannot run beside a `lynkeus mcp` server, which holds the driver port).

`--settle` waits for the app to stop committing before a frame; `--still` takes it again until two in a row match (a native transition the agent cannot see). A Simulator still differs in animations, blur and system banners; pixel-stable frames need FastSim.

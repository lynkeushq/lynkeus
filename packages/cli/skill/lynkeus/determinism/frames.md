# Frames two runs can be compared by

```sh
npx lynkeus case run --out run-a --screenshots --frames png --settle 700 --still 300
```

`--settle` waits for the app to stop committing before a frame; `--still` takes it again until two in a row match (a native transition the agent cannot see). A Simulator still differs in animations, blur and system banners; pixel-stable frames need FastSim.

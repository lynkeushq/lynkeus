# A slow step: where its time went

Each step in `cases.jsonl` has `phases`: its `ms` by what it waited on (`marks`, `target` for its target to be listed and clear, `action` for the command with the agent's wait for the target to hold still, `settle` for the app to go quiet, `wait`, `look`, `events`), a macro's steps summed. The console writes them after any step of 500 ms or more (`548ms: target 66 · action 420 · settle 62`). Read them before guessing where time went.

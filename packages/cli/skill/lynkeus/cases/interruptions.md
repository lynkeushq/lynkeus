# Interruptions: what may get in the way of any step

`cases.interruptions` in `lynkeus.config.json` names what may cover any step (a lock screen, a consent sheet) and how to get past it: `{ "see": "#unlock-keypad", "do": ["app.unlock"], "unless": "keypad" }`.

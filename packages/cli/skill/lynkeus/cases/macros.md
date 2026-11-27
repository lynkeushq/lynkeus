# Macros: one step for steps several cases repeat

`cases.macros` in `lynkeus.config.json` names a step and the steps it stands for; a case calls it as one step (`- app.signedIn: { user: u }`). Steps several cases open with belong in one: `case coverage` suggests it.

```json
"macros": {
  "app.signedIn": [
    { "app.call": { "command": "signIn", "params": { "user": "{{param.user}}" } } },
    { "when": "wait", "do": { "app.wait": "{{param.wait}}" } },
    { "on": "device", "do": [{ "app.press": { "target": "#dismiss-banner", "optional": true } }] }
  ]
}
```

`when` runs a block only if the case passed that parameter (or `"x=value"`), `unless` the opposite, `on` keeps it to one target; `do` is one step or a list.

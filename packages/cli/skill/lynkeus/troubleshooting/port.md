# Port already taken, no app attaches, hosts taking turns

- `status` names the process holding the port (pid, command, its project). Another Lynkeus serving another project cannot drive this app (tokens differ): stop it, or set `LYNKEUS_PORT` on both the app or host and the driver.
- An app that connects and stays silent was bundled with another token: restart Metro with `--reset-cache`. `lynkeus: the app passed a token and it is empty`: the bundle never got the token; `init` again, then rebuild and restart Metro.
- Two hosts on one port take turns: stop the one left running, or give each its own `LYNKEUS_PORT`.
- Two device apps on one port: the session drives the one attached first; `status` lists both. `case_run`/`why` take `on: ios|android`; else close the driven app.

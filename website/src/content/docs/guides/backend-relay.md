---
title: Backend relay
description: Let an app on a remote device or a cloud runner call a backend that listens only on your own machine, without opening a port or sharing a long-lived token.
---

Your backend runs on your laptop and listens on `127.0.0.1`. The app that has to talk to it runs somewhere else: a device in a cloud farm, a runner on another network, a colleague's phone. From there, your loopback address is not reachable, and opening a port to the internet for a test is a poor trade.

`lynkeus relay` solves this with one outbound connection. Your machine dials the hosted service, the service gives the app a URL, and each request the app sends to that URL travels back down the connection to your backend. Nothing listens for inbound traffic on your side.

## When to use it

Use the relay when the app cannot reach your backend directly and you do not want to expose the backend.

Do not use it when the app already reaches your machine. A simulator on the same Mac, an Android emulator (which sees the Mac as `10.0.2.2`) and the [headless host](/platforms/headless/) all talk to `127.0.0.1` or the host machine without help.

The relay needs the hosted service at [lynkeus.io](https://lynkeus.io) and an API key of your organization. It carries only the app's calls to your API. It does not carry the Lynkeus driver connection.

## Before you start

- Your backend is running and listening on loopback, for example `http://127.0.0.1:3000`.
- Its mobile API lives under `/api/mobile/`. The relay forwards nothing outside that prefix.
- `LYNKEUS_REPORTS_KEY` holds your organization's API key. `LYNKEUS_CLOUD_KEY` is read as a fallback. See [Environment variables](/reference/environment-variables/#lynkeus_reports_url-and-lynkeus_reports_key).

## The command

```bash
lynkeus relay --backend http://127.0.0.1:3000
```

The command stays in the foreground. On stderr it prints one line:

```text
relay listening: https://lynkeus.io/relay/relay_<64 hex>/api/mobile/ (expires 2026-11-16T15:30:00.000Z)
```

Give that URL to the app as its API address, in whatever setting your app reads: an environment variable such as `API_URL`, a build constant, a launch argument. The app calls it exactly as it would call your backend, and your backend sees the same paths it always sees.

Stop the relay with Ctrl-C, or let it expire. Either way the command exits and the URL stops answering.

| Option | Default | Meaning |
|---|---|---|
| `--backend <url>` | `http://127.0.0.1:3000` | The backend to forward to. Must be HTTP or HTTPS on `localhost`, `127.0.0.1` or `::1`, with no credentials in the URL. |
| `--prefix <path>` | `/api/mobile/` | The path prefix the relay allows. It must start with `/api/mobile/`, so you can narrow it (`/api/mobile/v2/`) but not widen it. |
| `--ttl <seconds>` | `900` | How long the session lives. The service allows at most `3600`. |
| `--cloud <url>` | `LYNKEUS_REPORTS_URL`, else `https://lynkeus.io` | The relay service. It must use TLS unless it is on loopback, which is how you test against a local service. |

## The two secrets

Creating a session returns two values, both random and both shown once:

- **The token**, `relay_…`. It names the session and is part of the URL the app calls. That means it ends up wherever URLs end up: the app's configuration, request logs, a crash report.
- **The socket secret**, `relaysock_…`. Only the CLI has it, and it never leaves your machine except to authenticate the connection to the service.

The service accepts the CLI's connection only with the socket secret. The token alone cannot do it. This matters: if the token were enough, anyone who read it from a log could connect in your place and answer the app's requests with whatever they liked, including data the app would trust and show. With two secrets, the token lets someone ask a question of the session, and only the CLI can answer.

A second connection with the right secret replaces the first and fails the requests the first one still had in flight. That is what lets the CLI reconnect, and it is why you should run one relay per session.

## Limits

The relay is deliberately narrow.

- **Lifetime.** 15 minutes unless you ask for more, 1 hour at most.
- **Prefix.** Only paths under `/api/mobile/` are forwarded, with no `..`, backslashes or null bytes. Anything else is refused, and the backend never sees it.
- **Loopback only.** The CLI never forwards to another host and never follows a redirect from your backend.
- **Size.** Request bodies up to 1 MiB, responses up to 8 MiB, and your backend has 30 seconds to answer.
- **Volume.** 1,000 requests per session and 8 at once. At most 20 sessions are active per organization.
- **Headers.** The app's `accept`, `content-type`, `x-api-key`, `x-version`, `x-bundleversion`, `user-agent`, `traceparent`, `tracestate` and its own `authorization` cross the relay. Cookies, `host` and your Lynkeus credentials do not.
- **Answers are inert.** The service serves them with headers that stop a browser from running or rendering them, so a backend answering `text/html` cannot run script on the service's origin. The app reads them as data and is not affected.

## What the service stores

The service keeps what it needs to run the session and nothing of what passes through it:

- SHA-256 hashes of the token and of the socket secret, never the values.
- The organization, the prefix, the expiration time and a request count.

Request and response bodies, headers and the token itself are not logged and not stored. Requests pass through a short-lived worker that holds the connection to your CLI and forgets them as it answers.

## Common problems

**`set LYNKEUS_REPORTS_KEY (or LYNKEUS_CLOUD_KEY) … to create a relay session`.** Exit code 2. The command has no key. Export one and run it again.

**`could not create the relay session (401)` or another status.** Exit code 1. The service refused the key (401) or the organization is over its limit (429, too many active sessions). Check the key, and stop relays you no longer use.

**`the relay service is older than this CLI: it gave no socket secret`.** The service you point at does not support the two-secret protocol yet. Update the service, or point `--cloud` at one that does.

**`the relay backend must be an HTTP(S) loopback URL`.** `--backend` names a host other than `localhost`, `127.0.0.1` or `::1`. The relay never forwards off your machine; run the backend locally.

**`the relay prefix must stay under /api/mobile/`.** Pick a prefix that starts with it.

**`the relay could not connect`.** The CLI could not open its connection to the service. Check the network and that `--cloud` is right. Behind a proxy that blocks WebSockets the connection will not open.

**The app gets 403 for a path that works locally.** The path is outside the prefix. Everything the app calls through the relay must start with `/api/mobile/`.

**The app gets 503.** The CLI is not connected: it was stopped, or it lost its connection. Run it again and give the app the new URL.

**The app gets 504 or 502.** 504 means your backend took more than 30 seconds. 502 means the CLI could not reach it or got an unusable answer: check that the backend is running at the `--backend` address.

**The app gets 413 or 429.** 413 is a request over 1 MiB. 429 is a session past 1,000 requests or 8 at once. For a new session, start a new relay.

**The URL stopped answering.** The session expired or you pressed Ctrl-C. Run the command again: you get a new token and a new URL, so give the app the new one.

## Next steps

- [Security](/security/): what Lynkeus exposes and to whom.
- [Running on CI](/guides/ci/): a job that runs the app next to its backend.
- [CLI reference](/reference/cli/#lynkeus-relay): every option of the command.

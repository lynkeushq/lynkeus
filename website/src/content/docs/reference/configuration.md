---
title: Configuration
description: Every key of lynkeus.config.json, with its type, its default and what it changes.
---

`lynkeus.config.json` holds what you would otherwise repeat as flags or environment variables on every invocation, and the few things only your project knows: which controls a crawl must never press, how tests prepare the backend, what language the app speaks. This page lists every key.

The file is optional. Every key is optional too.

## Where the file lives

The CLI reads `lynkeus.config.json` from the app's folder: the current folder, or the one given with `--root`.

A second file can be layered on top. When `LYNKEUS_CONFIG` names a file, lynkeus reads it after the app's own, and each top-level key it defines replaces the app's key of the same name. This is for teams that keep tests and fixtures in a repository of their own. Paths under `cases` are relative to the file that declares them.

A file that is not valid JSON stops the command with the file's path and the parser's message.

## Precedence

For a value that can come from three places, flags win over the environment, and the environment wins over the file.

| Value | Flag | Environment variable | Config key | Default |
|---|---|---|---|---|
| Simulator | `--device` | `LYNKEUS_DEVICE` | `device` | the first booted simulator |
| App id | `--app` | `LYNKEUS_APP_ID` | `app` | none |
| Attach timeout | `--attach-timeout` | `LYNKEUS_ATTACH_TIMEOUT_MS` | `attachTimeout` | `15000` |
| Driver port | none | `LYNKEUS_PORT` | `port` | `8123` |
| Headless entry | `--entry` | none | `entry` | `qa/headless.tsx` |
| API variable | `--api-env` | none | `apiEnv` | `API_URL` |
| Lint baseline | `--baseline` | none | `lintBaseline` | none |

## A full example

```json title="lynkeus.config.json"
{
  "entry": "qa/headless.tsx",
  "apiEnv": "API_URL",
  "port": 8123,
  "device": "iPhone 16",
  "app": "com.example.myapp",
  "attachTimeout": 15000,
  "language": "de",
  "locale": { "languageTag": "de-DE", "country": "DE" },
  "lintBaseline": ".lynkeus/lint.json",
  "lint": {
    "i18nKeyPatterns": ["^[a-z]+(\\.[a-z0-9_]+){2,}$"],
    "minTouchTarget": 44,
    "contrast": { "normal": 4.5, "large": 3, "ignore": ["^watermark$"] }
  },
  "errorCopy": ["Something went wrong", "Try again later"],
  "live": ["^countdown-", "^clock$"],
  "strictMode": false,
  "crawl": {
    "never": ["delete-account", "^Sign out$"],
    "close": ["^close-button$"],
    "back": ["^header-back$"]
  },
  "cases": {
    "dir": "cases",
    "flows": "flows",
    "fixtures": {
      "command": "node cases/fixtures.mjs",
      "cwd": ".",
      "env": { "RAILS_ENV": "test" },
      "timeoutMs": 120000
    },
    "inspect": "inspect",
    "refs": { "user": "user_id" },
    "macros": {
      "app.login": [
        { "app.call": { "command": "reset" } },
        { "app.deeplink": "myapp://dev-login?user={{param.as.user_id}}" },
        { "when": "wait", "do": { "app.wait": "{{param.wait}}" } }
      ]
    },
    "interruptions": [
      { "see": "#unlock-keypad", "do": ["app.unlock"], "unless": "keypad" }
    ],
    "nativeMocks": {
      "IdScanner.start": { "result": { "status": "approved" } }
    }
  }
}
```

The values above are examples. `app.unlock` and `IdScanner.start` stand for a macro and a native module of your own.

## Connection and app

| Key | Type | Default | Meaning |
|---|---|---|---|
| `port` | number | `8123` | The port the driver listens on and the app dials. `LYNKEUS_PORT` overrides it. |
| `device` | string | the first booted simulator | The simulator to use, by udid or by name. A name matches when the simulator's name contains it. |
| `app` | string | none | The app's bundle id (iOS) or application id (Android), for `launch`, `--launch` and the simulator commands. |
| `attachTimeout` | number (ms) | `15000` | How long a command waits for the app to attach before it gives up. |

When no simulator is booted and no device was asked for, the CLI assumes a headless host will dial in. Physical devices are not supported: `device` names a simulator or an emulator.

The token is not a configuration key. It is a secret, so the CLI reads it only from the `LYNKEUS_TOKEN` environment variable. See [Environment variables](/reference/environment-variables/#lynkeus_token).

## Headless host

| Key | Type | Default | Meaning |
|---|---|---|---|
| `entry` | string | `qa/headless.tsx` | The headless entry: the file that exports your `App` for `lynkeus headless start`. |
| `apiEnv` | string | `API_URL` | The environment variable your app reads its API base from. `headless init` writes a guard into the entry that refuses to start unless this variable points at a local backend. |
| `live` | string[] | none | Regular expressions for the `testID`s of controls whose content changes on its own: a ticking clock, a countdown. Their text stops counting as a commit. Without this, `idle` waits out its whole timeout on every screen that shows one. |
| `strictMode` | boolean | `false` | Keep `React.StrictMode` in the headless host. It is off by default because its double renders inflate every request, commit and millisecond the host measures. |

## Language

lynkeus never reads your copy. It passes these values on, and three things use them: `lynkeus os language` defaults to them, the entry that `headless init` generates mocks this locale, and `lynkeus mcp` reports them so that a model reading the screens knows their language.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `language` | string | none | The language the app speaks, such as `de`. |
| `locale` | object | none | The locale the app is built for. |
| `locale.languageTag` | string | none | A language tag such as `de-DE`. `os language` uses this first, then `language`. |
| `locale.country` | string | none | A country code such as `DE`. |

## Lint

| Key | Type | Default | Meaning |
|---|---|---|---|
| `lintBaseline` | string | none | The baseline file `lynkeus lint` compares against when `--baseline` is not given. A finding matches the baseline by its rule, its `testID` and what it is about, not by its message. A file saved before 0.3.0 still matches on the message until it is saved again with `lint --save`. |
| `lint.i18nKeyPatterns` | string[] | keys shaped like `a.b.c` and like `snake_case_key` | Regular expressions (case-insensitive) for what an untranslated key looks like in your app. An empty array turns the rule off. |
| `lint.minTouchTarget` | number (points) | `44` | The smallest acceptable touch target. |
| `lint.contrast` | `false` or object | on | How text contrast is judged. `false` turns the check off. |
| `lint.contrast.normal` | number | `4.5` | The least contrast ratio for ordinary text. |
| `lint.contrast.large` | number | `3` | The least contrast ratio for large text (18 points, or 14 and bold). |
| `lint.contrast.ignore` | string[] | none | Regular expressions for the `testID`s to leave out of the contrast check. |

The defaults for contrast are the figures of WCAG 2 level AA.

:::note[Since 0.3.0]
`lint.contrast` arrived in version 0.3.0.
:::

## Smoke and crawl

`smoke` and `crawl` open and press things on their own, so they need to be told what your app considers broken and what it considers dangerous. lynkeus ships no list of its own for either.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `errorCopy` | string[] | none | Regular expressions for the text your app shows when it is broken. `smoke` and `crawl` report a screen that matches. |
| `crawl.never` | string[] | none | Controls the crawl must never press. |
| `crawl.close` | string[] | none | Controls that close an overlay the app raises. Without them, the crawl closes an overlay by tapping its backdrop, then by swiping down. |
| `crawl.back` | string[] | none | Controls that go back. Without them, the crawl takes a small control in the top-left corner for one. |

The three `crawl` lists are regular expressions matched, without regard to case, against a control's `testID` and its label.

:::caution
`crawl.never` starts empty. A read-only crawl already stops at the first press that makes the app write, but a control that does something irreversible without a request, or one you never want pressed, has to be listed here.
:::

## Cases

Everything under `cases` configures `lynkeus case run`. The file format itself is in the [Case format reference](/reference/case-format/). `lynkeus case init` writes a starting `cases` section.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `cases.dir` | string | `cases` | The folder of case files. `case run` without arguments runs every `.md` file directly in it, except `README.md`, `FORMAT.md`, `CATALOG.md` and files that start with a dot. |
| `cases.flows` | string | `flows` | The folder of the flows an `app.run` step names. |
| `cases.fixtures` | object | none | The command that answers fixture steps. Without it, a case can only use `app.*` and `exec` steps. |
| `cases.fixtures.command` | string | required | A shell command. lynkeus starts it once per run and speaks JSON lines to it: one line in per step, one line out. |
| `cases.fixtures.cwd` | string | `.` | The folder the command starts in, relative to the config file. |
| `cases.fixtures.env` | object of strings | none | Environment variables added to the command's environment. |
| `cases.fixtures.timeoutMs` | number (ms) | `120000` | How long to wait for an answer to one step. |
| `cases.inspect` | string | `inspect` | The fixture that an `assert` step reads the backend through. |
| `cases.refs` | object of strings | none | Which step parameters point at what an earlier step made. See below. |
| `cases.macros` | object | none | Steps of your own: a name, and the list of steps it stands for. |
| `cases.interruptions` | array | none | What the app may put in the way of any step, and the steps that get past it. |
| `cases.nativeMocks` | object | none | What native SDKs answer on a host that cannot run them. |

### `cases.refs`

`refs` maps a parameter name to a field of a fixture's answer. With `"refs": { "user": "user_id" }`:

- A step that says `user: u` reaches the fixture as `user_id`, read from what the step with `as: u` answered.
- A step that names no user gets the `user_id` of the latest answer that had one.

### `cases.macros`

Each key is a step name, and its value is the list of steps the name stands for. Inside a macro, `{{param.x}}` is what the case passed. An entry can be a plain step, or an object with `do` and a condition: `when`, `unless` or `on`. The full rules are under [Macros](/reference/case-format/#macros).

### `cases.interruptions`

Each entry has three keys.

| Key | Type | Meaning |
|---|---|---|
| `see` | string | A target. When it is on screen, the interruption is in the way. |
| `do` | array of steps | The steps that get past it. |
| `unless` | string | Optional. A regular expression (case-insensitive). A step whose own words match it is about the interruption, and is left alone. |

### `cases.nativeMocks`

Each key is `Module.method`: the native module's name as `NativeModules` has it, a dot, and the method. Each value says what the call answers.

| Key | Type | Meaning |
|---|---|---|
| `result` | any | What the call resolves with. |
| `screen` | object | A stand-in page shown in place of the SDK's own screen. |
| `screen.title` | string | The page's title. |
| `screen.subtitle` | string | Optional. A second line. |
| `screen.image` | string | Optional. An image URI. |
| `screen.buttons` | object | Buttons, as label to result. Each one can be pressed as `#native-mock-<label>`. |

The mocks are sent to the app at the start of every case, so one case cannot leak its changes into the next. A step changes them during a case with `app.call: { command: nativeMocks, params: { set: { … } } }`; a value of `null` takes a key's mock away.

Native mocks need a host whose app answers the `nativeMocks` command. Where it does not, they have no effect.

---
title: Lint and contrast
description: Run lynkeus lint on a screen to find unlabeled controls, small touch targets, untranslated text and low-contrast text, and report only what a branch added.
---

Some problems are visible on every screen and caught on almost none: a button with no label for a screen reader, a tap target too small for a thumb, a translation key shown instead of its text, gray text on a slightly lighter gray. Reviewers know these rules and do not check them on every build.

`lynkeus lint` reads the screen the app is showing and reports them. It is a review pass on the usual suspects, not an accessibility certification.

## Before you start

- The app is running with the agent and you can drive it. See [Driving the app](/guides/driving-the-app/).
- For the contrast check: a simulator, an emulator, or another host that can take a screenshot.

## Step 1: Lint the current screen

Navigate to the screen you want to check, then:

```bash
npx lynkeus lint
```

You should see a header with the route and the counts, then one line per finding, warnings first:

```text
Settings.Main: 2 warn, 2 info
  ⚠ [unlabeled-control] #7 button with no text, label or testId
  ⚠ [low-contrast] #14 "Available balance" 2.9:1 (#8a8a8f on #ffffff), needs 4.5:1
  · [small-target] #9 32×32pt target (< 44) close-button
  · [duplicate-testid] #3 testId "row" is on 4 elements (3, 5, 8, 11)
```

The number after `#` is the element's index in `npx lynkeus screen`, so you can find it there. A screen with nothing to report prints `Settings.Main: clean`.

`lint` checks one screen: the one on display. To check several, navigate to each and run it again.

## The rules

Each finding has a severity. A **warning** (`⚠`) is something a reviewer would ask you to fix. **Information** (`·`) is something worth a look that is often fine.

| Rule | Severity | What it finds |
|---|---|---|
| `unlabeled-control` | warn | A button or switch with no text, no accessibility label and no testID. |
| `small-target` | warn or info | An enabled button or switch narrower or shorter than 44 points. A warning when the control is an icon with no text or label; information when it has one. |
| `untranslated` | warn | Text that looks like a translation key instead of copy, such as `settings.profile.title` or `error_network_timeout`. |
| `low-contrast` | warn or info | Text that does not stand out enough from what is behind it. See [Contrast](#contrast). |
| `covered-control` | info | An enabled button, input or switch that something covers, so a tap would not reach it. |
| `offscreen` | info | A named element that extends past the window. |
| `zero-size` | info | Text whose box has no width or no height. |
| `duplicate-testid` | info | One testID on more than one element. |

Elements the app is not presenting, such as those on another tab or under a sheet, are not checked.

Two notes on the rules that depend on a threshold.

`small-target` is information, not a warning, for a control with text, because such a control is usually measured at its label and not at its touchable area. A tab bar item is the common example.

`untranslated` uses two default shapes: three or more dot-separated segments (`a.b.c`) and three or more underscore-separated segments (`snake_case_key`). Text with spaces, URLs and numbers never match.

## Contrast

On a host that can take a picture of the screen, `lint` also measures how well each text stands out from its background.

It reads the pixels of a screenshot, not the styles. The colors an app declares say nothing about a label over a photo, a gradient or a translucent sheet. The pixels show the text as a person sees it.

```text
⚠ [low-contrast] #14 "Available balance" 2.9:1 (#8a8a8f on #ffffff), needs 4.5:1
```

The line gives the measured ratio, the text color, the background color and the ratio required.

The required ratios are those of WCAG 2 level AA:

| Text | Least ratio |
|---|---|
| Ordinary text | 4.5 to 1 |
| Large text: 18 points or more, or 14 points and bold | 3 to 1 |

What is measured, and what is not:

- Text, buttons and inputs that show text, a value or a placeholder are measured.
- A disabled control is not judged, since the guideline leaves it out. Neither is an element that is hidden, covered or off-screen.
- Text over a background that is not one flat color is reported as information, with the note `over a varied background`. The background is then a guess, so the decision is left to a person.

:::note
A low figure is a finding. A high one is not a certificate. Whatever else sits in the text's box, such as an icon beside a label, can only raise the measured ratio.
:::

### Check light and dark

Light and dark are two different screens, and a color that passes in one often fails in the other. Check both:

```bash
npx lynkeus os appearance light && npx lynkeus lint
npx lynkeus os appearance dark  && npx lynkeus lint
```

`os appearance` switches the simulator or emulator between light and dark.

### Skip or tune contrast

`--no-contrast` skips the measurement for one run. It is also the faster run, since contrast takes a screenshot.

```bash
npx lynkeus lint --no-contrast
```

On a host that takes no screenshots, such as the headless host, the other rules still run and the output ends with `contrast not measured: this host takes no screenshots`.

## Step 2: Fail a script on warnings

`lint` exits with code 0 by default, whatever it finds. `--strict` exits with code 1 when there is any warning. Information never fails it.

```bash
npx lynkeus lint --strict
```

## Step 3: Report only what a branch added

An existing app has findings on day one, and nobody will fix them all before adopting a check. A **baseline** is a file of the findings you already know about. Against it, `lint` prints only what is new.

On your main branch, save the findings of each screen you care about:

```bash
npx lynkeus nav Home.Main
npx lynkeus lint --save .lynkeus/lint/home.json
```

You should see `saved 4 finding(s) for Home.Main → .lynkeus/lint/home.json`.

On the branch, compare against it:

```bash
npx lynkeus nav Home.Main
npx lynkeus lint --baseline .lynkeus/lint/home.json --strict
```

You should see either `nothing new on Home.Main against .lynkeus/lint/home.json`, or the count of new findings followed by only those.

A baseline file is keyed by route, so one file can hold several screens: `--save` to the same file from each screen adds or replaces that route's entry and keeps the others.

To avoid repeating the path, name the file in the configuration. `lint` then compares against that file whenever it exists, with no flag.

```json title="lynkeus.config.json"
{
  "lintBaseline": ".lynkeus/lint.json"
}
```

## Configuration

```json title="lynkeus.config.json"
{
  "lintBaseline": ".lynkeus/lint.json",
  "lint": {
    "minTouchTarget": 44,
    "i18nKeyPatterns": ["^[a-z]+(\\.[a-z0-9]+){2,}$"],
    "contrast": { "normal": 4.5, "large": 3, "ignore": ["^watermark$"] }
  }
}
```

| Key | Default | Meaning |
|---|---|---|
| `lintBaseline` | none | The baseline file `lint` compares against when `--baseline` is not given. |
| `lint.minTouchTarget` | `44` | The smallest acceptable touch target, in points. |
| `lint.i18nKeyPatterns` | the two shapes above | Regular expressions for what an untranslated key looks like in your app. `[]` turns the rule off. |
| `lint.contrast.normal` | `4.5` | The least ratio for ordinary text. |
| `lint.contrast.large` | `3` | The least ratio for large text. |
| `lint.contrast.ignore` | none | Regular expressions for testIDs to leave out: a watermark, a brand color nobody may change. |
| `lint.contrast` | on | Set it to `false` to turn the contrast check off. |

## How it works

The rules other than contrast read the same structure `screen` prints: each element's kind, label, frame, and whether a touch would reach it. They need no screenshot and run on every host.

For contrast, `lint` takes one screenshot and looks at the rectangle of each text element. The color that fills most of the rectangle is taken as the background. Among the remaining colors with enough pixels to be glyphs, the one that stands furthest from the background is taken as the text. The ratio between the two is WCAG's contrast ratio, from 1 (the same color) to 21 (black on white). When the background color fills less than half of the rectangle, the background is treated as varied and the finding becomes information.

## Common problems

**`contrast not measured: this host takes no screenshots`.** You are on the headless host or another host with no picture. Run the contrast pass on a simulator or an emulator.

**A contrast finding on text over a photo.** That is the `over a varied background` case. It is information because the measurement cannot be exact; look at the screen and decide.

**The same finding appears on every screen.** It usually belongs to a shared component, such as a header button. Fix it once, or save it in the baseline.

**`untranslated` flags real copy.** Your product has identifiers that look like keys. Narrow `lint.i18nKeyPatterns` to the shape of your own keys.

**A finding you saved comes back as new.** A finding matches the baseline when its rule, its testID and its message are all the same. The message carries the measurement, so a target that went from 32 to 30 points, or a contrast ratio that moved from 2.9 to 2.8, is a new finding. So is an element whose testID changed.

**The contrast check is not available.** It is new and may not be in the version you have installed. Run `npx lynkeus help lint`: if `--no-contrast` is not listed, your version predates it.

## Next steps

- [Running on CI](/guides/ci/): run lint against a baseline on every pull request.
- [Recording and snapshots](/guides/recording-and-snapshots/): catch structural changes to a screen.
- [Configuration reference](/reference/configuration/): every key in `lynkeus.config.json`.

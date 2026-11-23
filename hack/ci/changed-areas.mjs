#!/usr/bin/env node
// Which suites a change needs, from the files it touches. One list for every workflow, read with
// docs/ARCHITECTURE.md ("Runtimes"). The cheap jobs (lint, the CLI's unit tests with the React Native goldens and the
// runtime boundary check) run on every change; these decide the heavy ones.
//
//   node hack/ci/changed-areas.mjs <base> <head>   writes key=true|false to $GITHUB_OUTPUT (or stdout)
//   node hack/ci/changed-areas.mjs --self-test
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

// The shared core: what every runtime runs through. A change here runs every runtime's suites.
const CORE = [
  /^packages\/cli\/(?!src\/runtimes\/[^/]+\/)/,
  /^packages\/(protocol|client)\//,
  /^conformance\//,
  /^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|turbo\.json)$/,
  /^\.github\/actions\//,
  /^hack\/ci\//,
];

// Each runtime's own paths. A change only here cannot reach another runtime: nothing outside a runtime's directory
// imports it but the CLI's loader (scripts/check-runtime-boundary.mjs), and its app and packages are its own.
const RUNTIMES = {
  'react-native': [/^packages\/(agent|headless)\//, /^example\//, /^packages\/cli\/src\/runtimes\/react-native\//, /^\.github\/workflows\/ci\.yml$/],
  flutter: [/^flutter\//, /^packages\/cli\/src\/runtimes\/flutter\//, /^\.github\/workflows\/flutter[^/]*\.yml$/],
};

// The heavy suites, by what they build. React Native's native builds compile the agent and the example app against
// the protocol; they do not run the CLI, whose React Native behavior the goldens pin in the unit tests.
const SUITES = {
  rn_native: (f) => /^packages\/(agent|protocol)\//.test(f) || /^example\//.test(f) || /^(package\.json|pnpm-lock\.yaml)$/.test(f) || /^\.github\/(actions\/|workflows\/ci\.yml$)/.test(f),
  flutter_dart: (f) => /^flutter\//.test(f) || /^\.github\/workflows\/flutter\.yml$/.test(f),
  flutter_e2e: (f) => RUNTIMES.flutter.some((r) => r.test(f)) || CORE.some((r) => r.test(f)),
};

const areasOf = (files) => {
  const touched = (rules) => files.some((f) => rules.some((r) => r.test(f)));
  const out = { core: touched(CORE) };
  for (const [id, rules] of Object.entries(RUNTIMES)) out[id] = touched(rules);
  for (const [name, test] of Object.entries(SUITES)) out[name] = files.some(test);
  return out;
};

const selfTest = () => {
  const cases = [
    [['flutter/lynkeus_agent/lib/src/agent.dart', 'packages/cli/src/runtimes/flutter/host.ts'], { core: false, 'react-native': false, flutter: true, rn_native: false, flutter_dart: true, flutter_e2e: true }],
    [['packages/cli/src/cases/runner.ts'], { core: true, 'react-native': false, flutter: false, rn_native: false, flutter_dart: false, flutter_e2e: true }],
    [['packages/cli/src/runtimes/react-native/index.ts'], { core: false, 'react-native': true, flutter: false, rn_native: false, flutter_dart: false, flutter_e2e: false }],
    [['packages/agent/src/index.ts'], { core: false, 'react-native': true, flutter: false, rn_native: true, flutter_dart: false, flutter_e2e: false }],
    [['packages/protocol/src/index.ts'], { core: true, 'react-native': false, flutter: false, rn_native: true, flutter_dart: false, flutter_e2e: true }],
    [['docs/CASES.md', 'website/src/content/docs/index.mdx'], { core: false, 'react-native': false, flutter: false, rn_native: false, flutter_dart: false, flutter_e2e: false }],
    [['.github/workflows/flutter.yml'], { core: false, 'react-native': false, flutter: true, rn_native: false, flutter_dart: true, flutter_e2e: true }],
  ];
  for (const [files, want] of cases) {
    const got = areasOf(files);
    if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${files.join(', ')}: ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
  }
  console.log(`changed-areas: ${cases.length} cases hold`);
};

if (process.argv[2] === '--self-test') selfTest();
else {
  const [base, head] = process.argv.slice(2);
  const all = !base || !head;
  const files = all ? [] : execFileSync('git', ['diff', '--name-only', `${base}...${head}`], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const areas = all ? Object.fromEntries(Object.keys(areasOf([])).map((k) => [k, true])) : areasOf(files);
  const lines = Object.entries(areas).map(([k, v]) => `${k}=${v}`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  console.log(all ? 'not a pull request: every suite runs' : `${files.length} files changed`);
  console.log(lines.join('\n'));
}

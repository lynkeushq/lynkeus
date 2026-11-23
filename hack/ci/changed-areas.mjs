#!/usr/bin/env node
// Which suites a change needs, from the files it touches. One list for every workflow, read with
// docs/ARCHITECTURE.md ("Runtimes"). The cheap jobs (lint with the runtime boundary check, every package's unit tests
// with the React Native goldens) run on every change; these decide the heavy ones.
//
//   node hack/ci/changed-areas.mjs <base> <head>   writes key=true|false to $GITHUB_OUTPUT (or stdout)
//   node hack/ci/changed-areas.mjs --self-test
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

// The shared core: what every runtime runs through. A change here runs every runtime's suites.
const CORE = [
  /^packages\/cli\/(?!src\/runtimes\/[^/]+\/)/,
  /^packages\/(protocol|client)\//,
  /^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|turbo\.json)$/,
  /^\.github\/actions\//,
  /^hack\/ci\//,
];

// Each runtime's own paths. A change only here cannot reach another runtime: nothing outside a runtime's directory
// imports it but the CLI's loader (scripts/check-runtime-boundary.mjs), and its app and packages are its own.
const RUNTIMES = {
  'react-native': [/^packages\/(agent|headless)\//, /^example\//, /^packages\/cli\/src\/runtimes\/react-native\//, /^\.github\/workflows\/ci\.yml$/],
};

// The heavy suites, by what they build. React Native's native builds compile the agent and the example app against
// the protocol; they do not run the CLI, whose React Native behavior the goldens pin in the unit tests.
const SUITES = {
  rn_native: (f) =>
    /^packages\/(agent|protocol)\//.test(f) || /^example\//.test(f) || /^(package\.json|pnpm-lock\.yaml)$/.test(f) || /^\.github\/(actions\/|workflows\/ci\.yml$)/.test(f),
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
    [['packages/cli/src/cases/runner.ts'], { core: true, 'react-native': false, rn_native: false }],
    [['packages/cli/src/runtimes/react-native/index.ts'], { core: false, 'react-native': true, rn_native: false }],
    [['packages/agent/src/index.ts'], { core: false, 'react-native': true, rn_native: true }],
    [['packages/headless/src/index.ts'], { core: false, 'react-native': true, rn_native: false }],
    [['packages/protocol/src/index.ts'], { core: true, 'react-native': false, rn_native: true }],
    [['example/src/App.tsx'], { core: false, 'react-native': true, rn_native: true }],
    [['pnpm-lock.yaml'], { core: true, 'react-native': false, rn_native: true }],
    [['.github/workflows/ci.yml'], { core: false, 'react-native': true, rn_native: true }],
    [['docs/CASES.md', 'website/src/content/docs/index.mdx'], { core: false, 'react-native': false, rn_native: false }],
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

/**
 * React Native behaves as on main: case parsing and step resolution, the messages the runner sends a React Native
 * app, the CLI's help, errors and MCP tools, and which runtime each kind of folder is. The goldens are made by
 * running main's CLI (`pnpm --filter lynkeus goldens:rn`); a difference passes only when goldens/rn/allowed.json
 * names it, says why, and pins what it is now.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { type Allowed, differences, readJson, sectionFile } from './goldens/compare.js';
import { CORPUS, GOLDENS, benchStepOverhead, probeDetect, probeParse, probeSurface, probeWire } from './goldens/probe.js';

const allowed = readJson<Allowed>(path.join(GOLDENS, 'allowed.json'));

const check = async (section: string, now: Record<string, unknown>) => {
  let golden = readJson<Record<string, unknown>>(sectionFile(GOLDENS, section));
  // A folder another runtime now takes keeps only its runtime, which allowed.json must name; the rest is that runtime's.
  if (section === 'detect')
    golden = Object.fromEntries(
      Object.entries(golden).filter(([key]) => key.endsWith('/runtime') || now[`${key.slice(0, key.lastIndexOf('/'))}/runtime`] === 'react-native'),
    );
  const problems = differences(section, golden, now, allowed);
  assert.equal(problems.length, 0, `React Native ${section} differs from main:\n\n${problems.join('\n\n')}`);
};

test('case files parse and resolve to the same commands as on main', async () => check('parse', await probeParse([CORPUS])));

test('the runner sends a React Native app the same messages as on main', async () => check('wire', await probeWire()));

test('help, errors and MCP tools read as on main', async () => check('surface', await probeSurface()));

test('each kind of folder is the runtime it was on main, and the commands that branch on it agree', async () => check('detect', await probeDetect()));

test('every allowed difference names a key the goldens have', () => {
  const sections = ['parse', 'wire', 'surface', 'detect'];
  const keys = new Set(sections.flatMap((s) => Object.keys(readJson<Record<string, unknown>>(sectionFile(GOLDENS, s))).map((k) => `${s}/${k}`)));
  for (const [key, leave] of Object.entries(allowed)) {
    assert.ok(keys.has(key) || sections.some((s) => key.startsWith(`${s}/`)), `allowed.json: ${key} is in no section`);
    assert.ok(leave.why.length > 20, `allowed.json: ${key} needs a reason a reader understands`);
  }
});

// The runner's own cost per step against an app that answers at once, in units of a fixed piece of work on the same
// machine, so a laptop and a CI runner compare. Twice main's is a regression worth a look before it reaches a device.
test('the runner costs no more per step than twice what it did on main', async () => {
  const baseline = readJson<{ units: number; msPerStep: number }>(sectionFile(GOLDENS, 'perf'));
  // A busy machine (other jobs, a laptop on battery) only adds time: the best of three runs is the runner's cost.
  let now = benchStepOverhead();
  for (let i = 0; i < 2 && now.units > baseline.units * 2; i++) {
    const again = benchStepOverhead();
    if (again.units < now.units) now = again;
  }
  assert.ok(
    now.units <= baseline.units * 2,
    `the runner now costs ${now.msPerStep.toFixed(4)} ms a step (${now.units.toFixed(5)} units), main ${baseline.msPerStep.toFixed(4)} ms (${baseline.units.toFixed(5)} units)`,
  );
});

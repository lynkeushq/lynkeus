/**
 * Writes the React Native goldens from the CLI this file sits in. scripts/goldens-rn.mjs copies the goldens folder
 * into a checkout of main and runs it there, so the goldens are what main does; nobody edits them by hand.
 *
 *   node --import tsx src/__tests__/goldens/generate.ts --out <dir> [--ref <name>]
 */
import fs from 'node:fs';
import path from 'node:path';

import { CORPUS, GOLDENS, cheapestStepOverhead, probeDetect, probeParse, probeSurface, probeWire } from './probe.js';

const flag = (name: string) => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
const out = path.resolve(flag('--out') ?? GOLDENS);
const ref = flag('--ref') ?? 'working tree';

const sorted = (entries: Record<string, unknown>) => Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)));
const save = (name: string, value: unknown) => fs.writeFileSync(path.join(out, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);

fs.mkdirSync(out, { recursive: true });
save('parse', sorted(await probeParse([CORPUS])));
save('wire', sorted(await probeWire()));
save('surface', sorted(await probeSurface()));
save('detect', sorted(await probeDetect()));
const budget = cheapestStepOverhead(3);
save('perf', { ref, ...budget });
console.error(`goldens from ${ref} in ${out}; ${budget.msPerStep.toFixed(3)} ms per step (${budget.units.toFixed(3)} calibration units)`);
process.exit(0);

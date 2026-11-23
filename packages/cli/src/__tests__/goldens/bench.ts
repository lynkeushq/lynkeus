/**
 * Prints the runner's per-step cost as JSON, in a process of its own: a test runner's async bookkeeping would
 * otherwise be measured with it, and main's baseline is measured the same way.
 */
import { measureStepOverhead } from './probe.js';

console.log(JSON.stringify(await measureStepOverhead()));
process.exit(0);

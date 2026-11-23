#!/usr/bin/env node
// The runtime boundary, checked on every change (CI's lint job). What it guarantees: a change made only inside one
// runtime's directory cannot run in another runtime's code path, because nothing outside that directory imports it
// except the loader, and the loader loads it only for a folder detected as that runtime.
//
//   - The core (everything under src/ but src/runtimes/) imports from src/runtimes/ only index.ts (the loader and
//     detection), detect.ts and api.ts. It never asks which runtime a folder is by name: no `=== 'flutter'`, no
//     `flutterProject(...)`; it asks the runtime's adapter.
//   - src/runtimes/index.ts is the only file that imports a runtime's directory, and only its index.ts, lazily.
//   - A runtime's directory (src/runtimes/<id>/) imports only its own files, `../api.js` (the core's single entry
//     point for runtimes), node: modules and packages. Never another runtime, never the core's internals.
//
// Tests (__tests__) are exempt: they may reach anywhere to set a case up.
// KNOWN lists what is still on the wrong side, each with why; an entry that no longer matches fails too, so the list
// only shrinks.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const runtimesDir = path.join(src, 'runtimes');
const BOUNDARY = new Set(['index.ts', 'detect.ts', 'api.ts'].map((f) => path.join(runtimesDir, f)));

const KNOWN = [
  {
    file: 'cases/runner.ts',
    match: "startsWith('flutter')",
    why: 'settlesFirst reads the attached app hello (a Flutter agent settles before its frame); the Flutter capture work is changing it',
  },
  {
    file: 'device/agentVersion.ts',
    match: "=== 'flutter-headless'",
    why: 'hostedHeadless names the hello.app.runtime values a hosted app sends (protocol vocabulary, not the folder)',
  },
];

// A runtime check by name: comparing with a runtime id, switching on one, or calling a runtime's own detection.
const CHECKS = [
  /[=!]==?\s*['"](react-native|flutter|exact)[\w-]*['"]/,
  /['"](react-native|flutter|exact)[\w-]*['"]\s*[=!]==?/,
  /\bcase\s+['"](react-native|flutter|exact)[\w-]*['"]/,
  /startsWith\(\s*['"](react-native|flutter|exact)/,
  /\b(flutterProject|hasReactNative|isFlutterPubspec|projectRuntime|isFlutter|isReactNative)\s*\(/,
];

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' ? [] : walk(full);
    return e.name.endsWith('.ts') ? [full] : [];
  });

// Comments say what a runtime does; only code is checked.
const code = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((line) => (/^\s*\/\//.test(line) ? '' : line));

const runtimeOf = (file) => {
  const rel = path.relative(runtimesDir, file);
  return rel.startsWith('..') || !rel.includes(path.sep) ? undefined : rel.split(path.sep)[0];
};

const IMPORT = /(?:\bfrom\s+|\bimport\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/g;

const problems = [];
const used = new Set();
for (const file of walk(src)) {
  const rel = path.relative(src, file);
  const lines = code(fs.readFileSync(file, 'utf8'));
  const mine = runtimeOf(file);
  lines.forEach((line, i) => {
    for (const m of line.matchAll(IMPORT)) {
      const spec = m[1];
      if (!spec.startsWith('.')) continue;
      const target = path.resolve(path.dirname(file), spec).replace(/\.js$/, '.ts');
      const theirs = runtimeOf(target);
      const where = `${rel}:${i + 1}`;
      if (mine) {
        if (theirs === mine) continue;
        if (target === path.join(runtimesDir, 'api.ts')) continue;
        problems.push(`${where}: the ${mine} runtime imports ${spec}; a runtime imports only its own files and ../api.js`);
      } else if (theirs) {
        const loader = file === path.join(runtimesDir, 'index.ts') && target === path.join(runtimesDir, theirs, 'index.ts') && m[0].includes('import(');
        if (!loader) problems.push(`${where}: imports ${spec} from the ${theirs} runtime; only runtimes/index.ts loads a runtime, lazily, by its id`);
      } else if (target.startsWith(runtimesDir + path.sep) && !BOUNDARY.has(target)) {
        problems.push(`${where}: imports ${spec}; the core reaches runtimes only through runtimes/index.js, detect.js and api.js`);
      }
    }
    if (mine || file === path.join(runtimesDir, 'detect.ts') || file === path.join(runtimesDir, 'index.ts')) return;
    for (const check of CHECKS) {
      if (!check.test(line)) continue;
      const known = KNOWN.find((k) => k.file === rel && line.includes(k.match));
      if (known) {
        used.add(known);
        continue;
      }
      problems.push(`${rel}:${i + 1}: asks which runtime this is by name (${line.trim().slice(0, 100)}); ask the runtime's adapter instead`);
    }
  });
}
for (const k of KNOWN) if (!used.has(k)) problems.push(`${k.file}: KNOWN lists "${k.match}", which is gone: remove the entry`);

if (problems.length) {
  console.error(`The runtime boundary is crossed (packages/cli/scripts/check-runtime-boundary.mjs):\n${problems.map((p) => `  ${p}`).join('\n')}`);
  process.exit(1);
}
console.log(`runtime boundary holds (${KNOWN.length} known exceptions: ${KNOWN.map((k) => k.file).join(', ')})`);

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

/*
 * Everything the package exports, as the declarations a consumer compiles against: every wire type of the agent
 * protocol, the run folder and the fixtures protocol, and every constant. shape.test.ts guards the version; this
 * shows any change at all, comments aside, as a diff in review. Record a deliberate one with UPDATE_PROTOCOL_API=1.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..');
const goldenFile = path.join(here, 'api.golden.d.ts.txt');

const declarations = (file: string): string => {
  const { outputText } = ts.transpileDeclaration(fs.readFileSync(path.join(src, file), 'utf8'), {
    fileName: file,
    compilerOptions: { removeComments: true, module: ts.ModuleKind.NodeNext, target: ts.ScriptTarget.ES2022 },
  });
  return `// ${file}\n${outputText.trim()}\n`;
};

test('the exported wire types change only on purpose', () => {
  const files = fs
    .readdirSync(src)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
    .sort();
  const now = files.map(declarations).join('\n');
  if (process.env.UPDATE_PROTOCOL_API === '1') fs.writeFileSync(goldenFile, now);
  assert.equal(
    now,
    fs.readFileSync(goldenFile, 'utf8'),
    'the protocol package exports something else now. Check that an agent, a driver and a report of the last release still read it, then record it with UPDATE_PROTOCOL_API=1.',
  );
});

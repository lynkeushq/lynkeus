// The site is published from a release tag. A page that says a feature exists
// since a version newer than that release describes something nobody can install.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const released = JSON.parse(readFileSync(join(root, '../packages/cli/package.json'), 'utf8')).version;
const parts = (version) => version.split('.').map(Number);
const newer = (a, b) => {
  const [x, y] = [parts(a), parts(b)];
  const at = x.findIndex((n, i) => n !== y[i]);
  return at !== -1 && x[at] > y[at];
};

const mention = /\b(?:since|desde|arrived in)(?: version| la versión)? (\d+\.\d+\.\d+)\b/gi;
const ahead = [];
for (const file of readdirSync(join(root, 'src/content/docs'), { recursive: true })) {
  if (!file.endsWith('.md')) continue;
  readFileSync(join(root, 'src/content/docs', file), 'utf8')
    .split('\n')
    .forEach((line, at) => {
      for (const [, version] of line.matchAll(mention)) {
        if (newer(version, released)) ahead.push(`${file}:${at + 1} names ${version}`);
      }
    });
}

if (ahead.length) {
  console.error(`lynkeus is at ${released}, and these pages describe a later version:\n${ahead.join('\n')}`);
  process.exit(1);
}
console.log(`every version the pages name is ${released} or earlier`);

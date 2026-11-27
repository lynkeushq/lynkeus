import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { headlessCommands } from '../commands/headless.js';
import { GUIDE_TOPICS, guideText, installSkill, SKILL_DIR, skillCommands } from '../commands/skill.js';
import { CLI_VERSION } from '../device/agentVersion.js';
import { schemaFor } from '../mcp/server.js';
import type { Ctx } from '../registry.js';

const tmpApp = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-skill-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'demo', dependencies: { 'react-native': '0.83.0' } }));
  fs.writeFileSync(path.join(root, 'index.js'), "import { AppRegistry } from 'react-native'\nAppRegistry.registerComponent('demo', () => () => null)\n");
  return root;
};

const shipped = (root: string) => fs.readdirSync(path.join(root, SKILL_DIR)).filter((f) => f.endsWith('.md'));

test('the skill installs with every topic, then reads as current', () => {
  const root = tmpApp();
  const first = installSkill(root);
  assert.equal(first.state, 'installed');
  assert.match(first.text, new RegExp(`skill ${CLI_VERSION.replace(/\./g, '\\.')} in .claude/skills/lynkeus`));
  assert.deepEqual(shipped(root).sort(), ['SKILL.md', ...GUIDE_TOPICS.map((t) => `${t}.md`)].sort());
  const skill = fs.readFileSync(path.join(root, SKILL_DIR, 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: lynkeus\ndescription: .*React Native/);
  assert.equal(installSkill(root).state, 'current');
});

test('an edited skill is left alone unless forced', () => {
  const root = tmpApp();
  installSkill(root);
  const file = path.join(root, SKILL_DIR, 'cases.md');
  fs.appendFileSync(file, '\nOur own rule.\n');
  const kept = installSkill(root);
  assert.equal(kept.state, 'kept');
  assert.match(kept.text, /cases\.md changed/);
  assert.match(fs.readFileSync(file, 'utf8'), /Our own rule/);
  assert.equal(installSkill(root, { force: true }).state, 'updated');
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /Our own rule/);
});

test('a removed topic counts as an edit, and a skill Lynkeus did not write is kept', () => {
  const root = tmpApp();
  installSkill(root);
  fs.rmSync(path.join(root, SKILL_DIR, 'ci.md'));
  assert.equal(installSkill(root).state, 'kept');

  const other = tmpApp();
  fs.mkdirSync(path.join(other, SKILL_DIR), { recursive: true });
  fs.writeFileSync(path.join(other, SKILL_DIR, 'SKILL.md'), '---\nname: lynkeus\ndescription: ours\n---\n');
  const kept = installSkill(other);
  assert.equal(kept.state, 'kept');
  assert.match(kept.text, /Lynkeus did not write it/);
  assert.equal(fs.readFileSync(path.join(other, SKILL_DIR, 'SKILL.md'), 'utf8'), '---\nname: lynkeus\ndescription: ours\n---\n');
});

test('an unedited skill from another release is updated, and a topic it no longer ships goes', () => {
  const root = tmpApp();
  installSkill(root);
  const dir = path.join(root, SKILL_DIR);
  const markerFile = path.join(dir, '.lynkeus-skill.json');
  const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8')) as { version: string; files: Record<string, string> };
  fs.writeFileSync(path.join(dir, 'old.md'), 'gone');
  marker.files['old.md'] = createHash('sha256').update('gone').digest('hex');
  marker.version = '0.0.1';
  fs.writeFileSync(markerFile, JSON.stringify(marker));
  const updated = installSkill(root);
  assert.equal(updated.state, 'updated');
  assert.match(updated.text, /was 0\.0\.1/);
  assert.equal(fs.existsSync(path.join(dir, 'old.md')), false);
});

const ctxFor = (root: string, flags: Record<string, boolean>): Ctx =>
  ({ root, config: {}, args: [], flags, passthrough: [], err: () => undefined, attached: false }) as unknown as Ctx;

test('init installs the skill and says so; --no-skill leaves it out', async () => {
  const init = headlessCommands.find((c) => c.name === 'init')!;
  const root = tmpApp();
  const said = (await init.run(ctxFor(root, { 'no-install': true }))) as { text: string };
  assert.match(said.text, /installed the Lynkeus skill/);
  assert.ok(fs.existsSync(path.join(root, SKILL_DIR, 'SKILL.md')));

  const without = tmpApp();
  const quiet = (await init.run(ctxFor(without, { 'no-install': true, 'no-skill': true }))) as { text: string };
  assert.doesNotMatch(quiet.text, /skill/);
  assert.equal(fs.existsSync(path.join(without, '.claude')), false);
});

test('guide answers each topic over MCP, links named as topics, and refuses one it lacks', async () => {
  const guide = skillCommands.find((c) => c.name === 'guide')!;
  assert.equal(guide.mcp, 'core');
  assert.deepEqual(schemaFor(guide).properties.topic?.enum, [...GUIDE_TOPICS]);
  for (const topic of GUIDE_TOPICS) assert.match(guideText(topic), /^# /, topic);
  const index = guideText();
  assert.doesNotMatch(index, /^---|\]\(\w+\.md\)/m);
  assert.match(index, /`targets` \(guide topic\)/);
  const answer = (await guide.run(ctxFor(tmpApp(), {}))) as { text: string };
  assert.equal(answer.text, index);
  const wrong = (await guide.run({ ...ctxFor(tmpApp(), {}), args: ['nope'] })) as { code: number };
  assert.equal(wrong.code, 2);
});

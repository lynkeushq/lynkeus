import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { headlessCommands } from '../commands/headless.js';
import { AGENTS_DIR, GUIDE_TOPICS, guideSections, guideText, installSkill, SKILL_DIR, shippedAgents, skillCommands } from '../commands/skill.js';
import { CLI_VERSION } from '../device/agentVersion.js';
import { schemaFor } from '../mcp/server.js';
import type { Ctx } from '../registry.js';

const tmpApp = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-skill-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'demo', dependencies: { 'react-native': '0.83.0' } }));
  fs.writeFileSync(path.join(root, 'index.js'), "import { AppRegistry } from 'react-native'\nAppRegistry.registerComponent('demo', () => () => null)\n");
  return root;
};

const shipped = (root: string) =>
  (fs.readdirSync(path.join(root, SKILL_DIR), { recursive: true }) as string[]).filter((f) => f.endsWith('.md')).map((f) => f.split(path.sep).join('/'));

const everySection = () => GUIDE_TOPICS.flatMap((topic) => guideSections(topic).map((id) => `${topic}/${id}.md`));

test('the skill installs with every section and its subagents, then reads as current', () => {
  const root = tmpApp();
  const first = installSkill(root);
  assert.equal(first.state, 'installed');
  assert.equal(first.agents.state, 'installed');
  assert.match(first.text, new RegExp(`skill ${CLI_VERSION.replace(/\./g, '\\.')} in .claude/skills/lynkeus`));
  assert.match(first.text, /subagents lynkeus-runner, lynkeus-setup in \.claude\/agents/);
  assert.deepEqual(shipped(root).sort(), ['SKILL.md', ...everySection()].sort());
  for (const name of shippedAgents()) assert.ok(fs.existsSync(path.join(root, AGENTS_DIR, `${name}.md`)), name);
  const skill = fs.readFileSync(path.join(root, SKILL_DIR, 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: lynkeus\ndescription: .*React Native/);
  const again = installSkill(root);
  assert.equal(again.state, 'current');
  assert.equal(again.agents.state, 'current');
  assert.doesNotMatch(again.text, /commit them/);
});

test('the subagents are Claude Code subagents on a cheaper model with Lynkeus tools only', () => {
  assert.deepEqual(shippedAgents(), ['lynkeus-runner', 'lynkeus-setup']);
  for (const name of shippedAgents()) {
    const text = fs.readFileSync(new URL(`../../skill/agents/${name}.md`, import.meta.url), 'utf8');
    const front = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? '';
    const fields = Object.fromEntries(front.split('\n').map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()]));
    assert.deepEqual(Object.keys(fields).sort(), ['description', 'model', 'name', 'tools'], name);
    assert.equal(fields.name, name);
    assert.match(fields.model!, /^(sonnet|haiku)$/, name);
    assert.match(fields.tools!, /^mcp__lynkeus__\*(, (Bash|Read))*$/, name);
  }
});

test('an edited subagent is kept while the skill still updates, and one Lynkeus did not write is left alone', () => {
  const root = tmpApp();
  installSkill(root);
  const runner = path.join(root, AGENTS_DIR, 'lynkeus-runner.md');
  fs.appendFileSync(runner, '\nAlso run lint.\n');
  const skillMarker = path.join(root, SKILL_DIR, '.lynkeus-skill.json');
  fs.writeFileSync(skillMarker, fs.readFileSync(skillMarker, 'utf8').replace(CLI_VERSION, '0.0.1'));
  const done = installSkill(root);
  assert.equal(done.state, 'updated');
  assert.equal(done.agents.state, 'kept');
  assert.match(done.text, /lynkeus-runner\.md changed/);
  assert.match(fs.readFileSync(runner, 'utf8'), /Also run lint/);

  const other = tmpApp();
  fs.mkdirSync(path.join(other, AGENTS_DIR), { recursive: true });
  fs.writeFileSync(path.join(other, AGENTS_DIR, 'lynkeus-setup.md'), '---\nname: lynkeus-setup\ndescription: ours\n---\n');
  fs.writeFileSync(path.join(other, AGENTS_DIR, 'reviewer.md'), 'theirs');
  const kept = installSkill(other);
  assert.equal(kept.state, 'installed');
  assert.equal(kept.agents.state, 'kept');
  assert.match(kept.text, /are not Lynkeus's/);
  assert.equal(fs.readFileSync(path.join(other, AGENTS_DIR, 'lynkeus-setup.md'), 'utf8'), '---\nname: lynkeus-setup\ndescription: ours\n---\n');
  assert.equal(installSkill(other, { force: true }).agents.state, 'installed');
  assert.equal(fs.readFileSync(path.join(other, AGENTS_DIR, 'reviewer.md'), 'utf8'), 'theirs');
});

test('an edited skill is left alone unless forced', () => {
  const root = tmpApp();
  installSkill(root);
  const file = path.join(root, SKILL_DIR, 'cases', 'mocks.md');
  fs.appendFileSync(file, '\nOur own rule.\n');
  const kept = installSkill(root);
  assert.equal(kept.state, 'kept');
  assert.match(kept.text, /cases\/mocks\.md changed/);
  assert.match(fs.readFileSync(file, 'utf8'), /Our own rule/);
  assert.equal(installSkill(root, { force: true }).state, 'updated');
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /Our own rule/);
});

test('a removed topic counts as an edit, and a skill Lynkeus did not write is kept', () => {
  const root = tmpApp();
  installSkill(root);
  fs.rmSync(path.join(root, SKILL_DIR, 'ci', 'impact.md'));
  assert.equal(installSkill(root).state, 'kept');

  const other = tmpApp();
  fs.mkdirSync(path.join(other, SKILL_DIR), { recursive: true });
  fs.writeFileSync(path.join(other, SKILL_DIR, 'SKILL.md'), '---\nname: lynkeus\ndescription: ours\n---\n');
  const kept = installSkill(other);
  assert.equal(kept.state, 'kept');
  assert.match(kept.text, /Lynkeus did not write it/);
  assert.equal(fs.readFileSync(path.join(other, SKILL_DIR, 'SKILL.md'), 'utf8'), '---\nname: lynkeus\ndescription: ours\n---\n');
});

test('an unedited skill from another release is updated, and a file it no longer ships goes', () => {
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

test('init installs the skill and subagents and says so; --no-skill and LYNKEUS_NO_SKILL leave both out', async () => {
  const init = headlessCommands.find((c) => c.name === 'init')!;
  const root = tmpApp();
  const said = (await init.run(ctxFor(root, { 'no-install': true }))) as { text: string };
  assert.match(said.text, /installed the Lynkeus skill/);
  assert.match(said.text, /installed its Claude Code subagents/);
  assert.ok(fs.existsSync(path.join(root, SKILL_DIR, 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(root, AGENTS_DIR, 'lynkeus-setup.md')));

  const without = tmpApp();
  const quiet = (await init.run(ctxFor(without, { 'no-install': true, 'no-skill': true }))) as { text: string };
  assert.doesNotMatch(quiet.text, /skill|subagent/);
  assert.equal(fs.existsSync(path.join(without, '.claude')), false);

  const byEnv = tmpApp();
  process.env.LYNKEUS_NO_SKILL = '1';
  try {
    await init.run(ctxFor(byEnv, { 'no-install': true }));
  } finally {
    delete process.env.LYNKEUS_NO_SKILL;
  }
  assert.equal(fs.existsSync(path.join(byEnv, '.claude')), false);
});

test('guide answers a topic with its section list and a section alone, and refuses what it lacks', async () => {
  const guide = skillCommands.find((c) => c.name === 'guide')!;
  assert.equal(guide.mcp, 'core');
  const schema = schemaFor(guide).properties;
  assert.deepEqual(schema.topic?.enum, [...GUIDE_TOPICS]);
  assert.equal(schema.section?.type, 'string');
  assert.equal(schema.section?.enum, undefined);
  const skill = fs.readFileSync(new URL('../../skill/lynkeus/SKILL.md', import.meta.url), 'utf8');
  for (const topic of GUIDE_TOPICS) {
    const list = guideText(topic);
    assert.ok(list.length < 700, `${topic} list is ${list.length} bytes`);
    for (const id of guideSections(topic)) {
      assert.match(list, new RegExp(`^- ${id}: `, 'm'));
      assert.ok(skill.includes(`](${topic}/${id}.md)`), `SKILL.md routes to ${topic}/${id}`);
      const section = guideText(topic, id);
      assert.match(section, /^# /, `${topic}/${id}`);
      // A section is read whole into a context that is paid for on every later call.
      assert.ok(section.length <= 1400, `${topic}/${id} is ${section.length} bytes`);
    }
  }
  const index = guideText();
  assert.doesNotMatch(index, /^---|\]\([\w/-]+\.md\)/m);
  assert.match(index, /targets: `overview`/);
  assert.match(index, /not up front/);
  assert.match(index, /`lynkeus-setup`.*`lynkeus-runner`/);
  const answer = (await guide.run(ctxFor(tmpApp(), {}))) as { text: string };
  assert.equal(answer.text, index);
  const one = (await guide.run({ ...ctxFor(tmpApp(), {}), args: ['cases', 'mocks'] })) as { text: string };
  assert.equal(one.text, guideText('cases', 'mocks'));
  const wrong = (await guide.run({ ...ctxFor(tmpApp(), {}), args: ['nope'] })) as { code: number };
  assert.equal(wrong.code, 2);
  const missing = (await guide.run({ ...ctxFor(tmpApp(), {}), args: ['cases', '../SKILL'] })) as { code: number; text: string };
  assert.equal(missing.code, 2);
  assert.match(missing.text, /- mocks: /);
});

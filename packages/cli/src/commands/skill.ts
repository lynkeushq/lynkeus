import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CLI_VERSION } from '../device/agentVersion.js';
import { define } from '../registry.js';

// The same depth from src/commands and lib/commands: the skill ships beside both, in the package.
const SOURCE = fileURLToPath(new URL('../../skill/lynkeus/', import.meta.url));

/** Where a project keeps it: Claude Code and other clients that read Agent Skills look there. */
export const SKILL_DIR = path.join('.claude', 'skills', 'lynkeus');

/** What was installed, so an update can tell the files Lynkeus wrote from files the person changed since. */
const MARKER = '.lynkeus-skill.json';

type Marker = { version: string; files: Record<string, string> };

export const GUIDE_TOPICS = ['cases', 'targets', 'evidence', 'ci', 'determinism', 'troubleshooting'] as const;

const shipped = (): string[] =>
  fs
    .readdirSync(SOURCE)
    .filter((f) => f.endsWith('.md'))
    .sort();

const digest = (body: Buffer | string): string => createHash('sha256').update(body).digest('hex');

const readMarker = (dir: string): Marker | undefined => {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8')) as Partial<Marker>;
    return typeof parsed.version === 'string' && parsed.files && typeof parsed.files === 'object' ? (parsed as Marker) : undefined;
  } catch {
    return undefined;
  }
};

/** The files the person changed or removed since Lynkeus wrote them. */
const editedFiles = (dir: string, marker: Marker): string[] =>
  Object.entries(marker.files)
    .filter(([file, hash]) => {
      try {
        return digest(fs.readFileSync(path.join(dir, file))) !== hash;
      } catch {
        return true;
      }
    })
    .map(([file]) => file);

export type SkillInstall = { state: 'installed' | 'updated' | 'current' | 'kept'; dir: string; text: string };

/**
 * Copies the skill this CLI ships into the project, at this CLI's version. A skill the person edited, or one
 * Lynkeus did not write, is theirs: it is left as it is unless `force`.
 */
export const installSkill = (root: string, { force = false }: { force?: boolean } = {}): SkillInstall => {
  const dir = path.join(root, SKILL_DIR);
  const shown = SKILL_DIR.split(path.sep).join('/');
  const marker = readMarker(dir);
  const exists = fs.existsSync(dir);
  if (exists && !force) {
    if (!marker) return { state: 'kept', dir, text: `left ${shown} as it is: Lynkeus did not write it (\`lynkeus skill install --force\` replaces it)` };
    const edited = editedFiles(dir, marker);
    if (edited.length)
      return {
        state: 'kept',
        dir,
        text: `left the Lynkeus skill in ${shown} as it is: ${edited.join(', ')} changed since Lynkeus wrote it (\`lynkeus skill install --force\` replaces it with ${CLI_VERSION}'s)`,
      };
  }
  const files = shipped();
  const bodies = new Map(files.map((file) => [file, fs.readFileSync(path.join(SOURCE, file))]));
  if (marker && marker.version === CLI_VERSION && files.every((file) => marker.files[file] === digest(bodies.get(file)!)) && !force)
    return { state: 'current', dir, text: `the Lynkeus skill in ${shown} is ${CLI_VERSION}'s already` };
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, body] of bodies) fs.writeFileSync(path.join(dir, file), body);
  // A topic an older release shipped and this one does not would be read as current.
  for (const file of Object.keys(marker?.files ?? {})) if (!bodies.has(file)) fs.rmSync(path.join(dir, file), { force: true });
  const next: Marker = { version: CLI_VERSION, files: Object.fromEntries([...bodies].map(([file, body]) => [file, digest(body)])) };
  fs.writeFileSync(path.join(dir, MARKER), `${JSON.stringify(next, null, 2)}\n`);
  const state = exists ? 'updated' : 'installed';
  const was = marker && marker.version !== CLI_VERSION ? ` (was ${marker.version})` : '';
  return {
    state,
    dir,
    text: `${state} the Lynkeus skill ${CLI_VERSION} in ${shown}${was}: how to write, run and debug cases, read by Claude Code and other clients that load Agent Skills when a task needs it; commit it with the project (\`--no-skill\` leaves it out)`,
  };
};

/** One topic of the skill, or its index, as a client without skills reads it: links to topics name the topic. */
export const guideText = (topic?: string): string => {
  const file = topic ? `${topic}.md` : 'SKILL.md';
  const body = fs.readFileSync(path.join(SOURCE, file), 'utf8');
  return body
    .replace(/^---\n[\s\S]*?\n---\n+/, '')
    .replace(/\[([\w-]+)\.md\]\(\1\.md\)/g, (_, name: string) => `\`${name}\` (guide topic)`)
    .trimEnd();
};

export const skillCommands = [
  define({
    name: 'guide',
    group: 'drive',
    summary: "How to work with Lynkeus, one short topic per call: the Lynkeus skill's text, for what the MCP instructions leave out",
    details: `Without a topic, the index: the cheap way to write a case and what each topic holds. Topics: ${GUIDE_TOPICS.join(', ')}.`,
    positionals: [{ name: 'topic', help: 'none for the index', choices: [...GUIDE_TOPICS] }],
    needs: 'nothing',
    mcp: 'core',
    run: async (ctx) => {
      const topic = ctx.args[0];
      if (topic !== undefined && !(GUIDE_TOPICS as readonly string[]).includes(topic))
        return { text: `no topic ${topic}: ${GUIDE_TOPICS.join(', ')}, or none for the index`, code: 2 };
      return { text: guideText(topic) };
    },
  }),
  define({
    name: 'skill install',
    group: 'drive',
    summary: "Install or update the Lynkeus skill in this project's .claude/skills/lynkeus, at this CLI's version",
    details:
      '`lynkeus init` does it too. A skill whose files changed since Lynkeus wrote them, or that Lynkeus did not write, is left as it is unless --force. The same topics are served over MCP by the `guide` tool.',
    flags: { force: { type: 'boolean', help: 'replace the skill even when its files were changed' } },
    needs: 'nothing',
    run: async (ctx) => {
      const done = installSkill(ctx.root, { force: !!ctx.flags.force });
      return { text: done.text, json: done };
    },
  }),
];

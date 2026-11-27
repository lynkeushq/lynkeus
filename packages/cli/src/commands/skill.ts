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

type Marker = { version: string; files: Record<string, string> };

export const GUIDE_TOPICS = ['cases', 'targets', 'evidence', 'ci', 'determinism', 'troubleshooting'] as const;

/** Every markdown file under `dir`, as forward-slash paths relative to it. */
const markdownUnder = (dir: string, prefix = ''): string[] =>
  fs
    .readdirSync(path.join(dir, prefix), { withFileTypes: true })
    .flatMap((entry) => {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) return markdownUnder(dir, rel);
      return entry.name.endsWith('.md') ? [rel] : [];
    })
    .sort();

const digest = (body: Buffer | string): string => createHash('sha256').update(body).digest('hex');

const readMarker = (file: string): Marker | undefined => {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Marker>;
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

type Bundle = {
  source: string;
  /** Relative to the project. */
  dir: string;
  /** What was installed, so an update can tell the files Lynkeus wrote from files the person changed since. */
  marker: string;
  files: string[];
  /** Whether something Lynkeus did not write is there already: then it is the person's. */
  foreign: (dir: string) => boolean;
};

type BundleInstall = { state: 'installed' | 'updated' | 'current' | 'kept'; dir: string; was?: string; edited?: string[] };

/**
 * Copies a bundle this CLI ships into the project, at this CLI's version. One the person edited, or one Lynkeus did
 * not write, is theirs: it is left as it is unless `force`.
 */
const installBundle = (root: string, bundle: Bundle, force: boolean): BundleInstall => {
  const dir = path.join(root, bundle.dir);
  const markerFile = path.join(dir, bundle.marker);
  const marker = readMarker(markerFile);
  if (!force) {
    if (!marker && bundle.foreign(dir)) return { state: 'kept', dir };
    const edited = marker ? editedFiles(dir, marker) : [];
    if (edited.length) return { state: 'kept', dir, edited };
  }
  const bodies = new Map(bundle.files.map((file) => [file, fs.readFileSync(path.join(bundle.source, file))]));
  if (!force && marker && marker.version === CLI_VERSION && bundle.files.every((file) => marker.files[file] === digest(bodies.get(file)!)))
    return { state: 'current', dir };
  for (const [file, body] of bodies) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), body);
  }
  // A file an older release shipped and this one does not would be read as current.
  for (const file of Object.keys(marker?.files ?? {})) if (!bodies.has(file)) fs.rmSync(path.join(dir, file), { force: true });
  const next: Marker = { version: CLI_VERSION, files: Object.fromEntries([...bodies].map(([file, body]) => [file, digest(body)])) };
  fs.writeFileSync(markerFile, `${JSON.stringify(next, null, 2)}\n`);
  return { state: marker ? 'updated' : 'installed', dir, ...(marker && marker.version !== CLI_VERSION ? { was: marker.version } : {}) };
};

const skillBundle = (): Bundle => ({
  source: SOURCE,
  dir: SKILL_DIR,
  marker: '.lynkeus-skill.json',
  files: markdownUnder(SOURCE),
  foreign: (dir) => fs.existsSync(dir),
});

export type SkillInstall = BundleInstall & { text: string };

const shown = (dir: string) => dir.split(path.sep).join('/');

/** Installs the Lynkeus skill this CLI ships into the project. */
export const installSkill = (root: string, { force = false }: { force?: boolean } = {}): SkillInstall => {
  const skill = installBundle(root, skillBundle(), force);
  const forced = '`lynkeus skill install --force` replaces';
  const text = () => {
    if (skill.state === 'kept')
      return skill.edited
        ? `left the Lynkeus skill in ${shown(SKILL_DIR)} as it is: ${skill.edited.join(', ')} changed since Lynkeus wrote it (${forced} it with ${CLI_VERSION}'s)`
        : `left ${shown(SKILL_DIR)} as it is: Lynkeus did not write it (${forced} it)`;
    if (skill.state === 'current') return `the Lynkeus skill in ${shown(SKILL_DIR)} is ${CLI_VERSION}'s already`;
    return `${skill.state} the Lynkeus skill ${CLI_VERSION} in ${shown(SKILL_DIR)}${skill.was ? ` (was ${skill.was})` : ''}: how to write, run and debug cases, read by Claude Code and other clients that load Agent Skills when a task needs it; commit it with the project (\`--no-skill\` leaves it out)`;
  };
  return { ...skill, text: text() };
};

const linkToSection = /\[([\w-]+)\]\(([\w-]+)\/([\w-]+)\.md\)/g;

const body = (file: string): string =>
  fs
    .readFileSync(file, 'utf8')
    .replace(/^---\n[\s\S]*?\n---\n+/, '')
    .trimEnd();

/** A topic's section ids, in the order SKILL.md lists them. */
export const guideSections = (topic: string): string[] => {
  const order = [...fs.readFileSync(path.join(SOURCE, 'SKILL.md'), 'utf8').matchAll(linkToSection)].filter((m) => m[2] === topic).map((m) => m[3]!);
  const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
  return markdownUnder(path.join(SOURCE, topic))
    .map((file) => file.replace(/\.md$/, ''))
    .sort((a, b) => rank(a) - rank(b));
};

/**
 * The skill as a client without skills reads it: no topic gives SKILL.md, a topic gives its sections one line each
 * (the heading names what the section answers), a section gives only that section.
 */
export const guideText = (topic?: string, section?: string): string => {
  if (!topic) return body(path.join(SOURCE, 'SKILL.md')).replace(linkToSection, (_, id: string) => `\`${id}\``);
  if (section) return body(path.join(SOURCE, topic, `${section}.md`));
  const lines = guideSections(topic).map((id) => {
    const heading = fs
      .readFileSync(path.join(SOURCE, topic, `${id}.md`), 'utf8')
      .split('\n', 1)[0]!
      .replace(/^#\s*/, '');
    return `- ${id}: ${heading}`;
  });
  return [`${topic}: call guide with this topic and one section.`, ...lines].join('\n');
};

export const skillCommands = [
  define({
    name: 'guide',
    group: 'drive',
    summary: "How to work with Lynkeus, one short section per call: the Lynkeus skill's text, for what the MCP instructions leave out",
    details: `A topic alone lists its sections; a topic and a section answer that section only. Neither gives the index. Topics: ${GUIDE_TOPICS.join(', ')}.`,
    positionals: [
      { name: 'topic', help: 'none for the index', choices: [...GUIDE_TOPICS] },
      { name: 'section', help: "a section id from the topic's list" },
    ],
    needs: 'nothing',
    mcp: 'core',
    run: async (ctx) => {
      const [topic, section] = ctx.args;
      if (topic !== undefined && !(GUIDE_TOPICS as readonly string[]).includes(topic))
        return { text: `no topic ${topic}: ${GUIDE_TOPICS.join(', ')}, or none for the index`, code: 2 };
      if (topic && section !== undefined && !guideSections(topic).includes(section))
        return { text: `no section ${section} in ${topic}.\n${guideText(topic)}`, code: 2 };
      return { text: guideText(topic, section) };
    },
  }),
  define({
    name: 'skill install',
    group: 'drive',
    summary: "Install or update the Lynkeus skill in this project's .claude/skills/lynkeus, at this CLI's version",
    details:
      '`lynkeus init` does it too. A skill whose files changed since Lynkeus wrote them, or that Lynkeus did not write, is left as it is unless --force. The same sections are served over MCP by the `guide` tool.',
    flags: { force: { type: 'boolean', help: 'replace the skill even when its files were changed' } },
    needs: 'nothing',
    run: async (ctx) => {
      const done = installSkill(ctx.root, { force: !!ctx.flags.force });
      return { text: done.text, json: done };
    },
  }),
];

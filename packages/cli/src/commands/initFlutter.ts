import fs from 'node:fs';
import path from 'node:path';

import { ensureToken } from '../config.js';
import { installAgent, mountAgent } from './init.js';

export type Runtime = 'react-native' | 'flutter';

/** Where `lynkeus_agent` comes from. One place to change when the package is published on pub.dev (`['lynkeus_agent: ^x.y.z']`). */
const gitDependency = (name: string): string[] => [`${name}:`, '  git:', '    url: https://github.com/lynkeushq/lynkeus.git', `    path: flutter/${name}`];

export const AGENT_DEPENDENCY: string[] = gitDependency('lynkeus_agent');
export const HEADLESS_DEPENDENCY: string[] = gitDependency('lynkeus_headless');

const AGENT_IMPORT = "import 'package:lynkeus_agent/lynkeus_agent.dart';";
const AGENT_URI = 'package:lynkeus_agent/lynkeus_agent.dart';

/** `app.name` is what the CLI shows for the app; the agent takes it from #149's `start(app: {...})`. */
const agentStart = (appName?: string): string => `LynkeusAgent.start(${appName ? `app: {'name': '${appName}'}` : ''});`;

export type Edit = { text: string; note: string; done: boolean };

const eolOf = (text: string): string => (text.includes('\r\n') ? '\r\n' : '\n');

/** The top-level `dependencies:` block of a pubspec: its header line and the index where the next top-level key starts. */
const dependenciesBlock = (lines: string[]): { header: number; end: number } | undefined => {
  const header = lines.findIndex((line) => /^dependencies:\s*(#.*)?$/.test(line));
  if (header < 0) return undefined;
  let end = lines.length;
  for (let i = header + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i]!) && !lines[i]!.startsWith('#')) {
      end = i;
      break;
    }
  }
  return { header, end };
};

export const isFlutterPubspec = (text: string): boolean => {
  const lines = text.split(/\r?\n/);
  const block = dependenciesBlock(lines);
  if (!block) return false;
  const body = lines.slice(block.header + 1, block.end).join('\n');
  return /^[ \t]+flutter:\s*(\n[ \t]+sdk:\s*flutter\b|\{\s*sdk:\s*flutter\s*\})/m.test(body);
};

const byHand = (section: string, lines: string[]): string => `add this under ${section} in pubspec.yaml:\n    ${lines.join('\n    ')}`;

/** The package's name, as `pubspec.yaml` gives it. */
export const pubspecName = (text: string): string | undefined => /^name:\s*['"]?([A-Za-z_]\w*)['"]?\s*(#.*)?$/m.exec(text)?.[1];

/**
 * Adds a dependency right under its section's header, so comments and the rest of the file stay as they are. A
 * `dev_dependencies` section that is missing is added at the end; one with nothing but comments gets the usual indent.
 */
const addDependency = (text: string, section: 'dependencies' | 'dev_dependencies', name: string, lines: string[]): Edit => {
  const eol = eolOf(text);
  const all = text.split(/\r?\n/);
  const header = all.findIndex((line) => new RegExp(`^${section}:\\s*(#.*)?$`).test(line));
  if (header < 0) {
    if (section === 'dependencies') return { text, done: false, note: byHand(section, lines) };
    const body = [`${section}:`, ...lines.map((line) => `  ${line}`)].join(eol);
    return { text: `${text}${text.endsWith('\n') ? '' : eol}${eol}${body}${eol}`, done: true, note: `added ${name} to pubspec.yaml (new ${section} section)` };
  }
  let end = all.length;
  for (let i = header + 1; i < all.length; i++) {
    if (/^\S/.test(all[i]!) && !all[i]!.startsWith('#')) {
      end = i;
      break;
    }
  }
  const body = all.slice(header + 1, end);
  if (body.some((line) => new RegExp(`^[ \\t]+${name}:`).test(line))) return { text, done: true, note: `pubspec.yaml already depends on ${name}` };
  const first = body.find((line) => /^[ \t]+\S/.test(line) && !line.trim().startsWith('#'));
  const indent = first ? /^[ \t]*/.exec(first)![0] : '  ';
  all.splice(header + 1, 0, ...lines.map((line) => `${indent}${line}`));
  return { text: all.join(eol), done: true, note: `added ${name} to pubspec.yaml` };
};

export const addAgentToPubspec = (text: string): Edit => addDependency(text, 'dependencies', 'lynkeus_agent', AGENT_DEPENDENCY);
export const addHeadlessToPubspec = (text: string): Edit => addDependency(text, 'dev_dependencies', 'lynkeus_headless', HEADLESS_DEPENDENCY);

/** The index just past the `)` that closes the call whose `(` is at `open`, skipping string literals. */
const closeOf = (text: string, open: number): number => {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (c === "'" || c === '"') {
      for (i++; i < text.length && text[i] !== c && text[i] !== '\n'; i++) if (text[i] === '\\') i++;
    } else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i + 1;
  }
  return -1;
};

export const mainByHand = (appName?: string): string =>
  `add to lib/main.dart:\n    ${AGENT_IMPORT}\n  and, in main(), before runApp(...):\n    ${agentStart(appName)}`;

/** Puts the agent's import where `directives_ordering` wants it: among the `package:` imports, sorted by URI. */
const withImport = (text: string, eol: string): string => {
  const imports = [...text.matchAll(/^import\s+['"]([^'"]+)['"][^;]*;[ \t]*$/gm)].map((m) => ({ uri: m[1]!, start: m.index!, end: m.index! + m[0].length }));
  const packages = imports.filter((i) => i.uri.startsWith('package:'));
  const after = packages.find((i) => i.uri > AGENT_URI);
  if (after) return `${text.slice(0, after.start)}${AGENT_IMPORT}${eol}${text.slice(after.start)}`;
  const last = packages[packages.length - 1] ?? imports.filter((i) => i.uri.startsWith('dart:')).pop();
  if (last) return `${text.slice(0, last.end)}${eol}${last.uri.startsWith('dart:') ? eol : ''}${AGENT_IMPORT}${text.slice(last.end)}`;
  // Only relative imports, or none: the package import leads them, with a blank line between.
  const first = imports[0];
  return first ? `${text.slice(0, first.start)}${AGENT_IMPORT}${eol}${eol}${text.slice(first.start)}` : `${AGENT_IMPORT}${eol}${eol}${text}`;
};

/** Imports the agent and starts it before `runApp(`, in a block `main` or in an arrow `main` that becomes one. */
export const addAgentToMain = (text: string, appName?: string): Edit => {
  const AGENT_START = agentStart(appName);
  if (text.includes('LynkeusAgent.start(')) return { text, done: true, note: 'lib/main.dart already starts the agent' };
  const eol = eolOf(text);
  const arrow = /^([ \t]*)((?:Future<void>|void)\s+main\s*\(\s*\)\s*)(async\s*)?=>\s*runApp\(/m.exec(text);
  const plain = /^([ \t]*)runApp\(/m.exec(text);
  let next: string;
  if (arrow) {
    const open = arrow.index + arrow[0].length - 1;
    const close = closeOf(text, open);
    if (close < 0 || text[close] !== ';') return { text, done: false, note: `could not read main() in lib/main.dart; ${mainByHand(appName)}` };
    const indent = arrow[1]!;
    const call = text.slice(open - 'runApp'.length, close);
    const head = `${indent}${arrow[2]!.trimEnd()}${arrow[3] ? ' async' : ''} {`;
    next = `${text.slice(0, arrow.index)}${head}${eol}${indent}  ${AGENT_START}${eol}${indent}  ${call};${eol}${indent}}${text.slice(close + 1)}`;
  } else if (plain) {
    next = `${text.slice(0, plain.index)}${plain[1]}${AGENT_START}${eol}${text.slice(plain.index)}`;
  } else {
    return { text, done: false, note: `no runApp( in lib/main.dart; ${mainByHand(appName)}` };
  }
  next = withImport(next, eol);
  return { text: next, done: true, note: 'added the import and LynkeusAgent.start() to lib/main.dart' };
};

const readIfExists = (file: string): string | undefined => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined);

const hasReactNative = (root: string): boolean => {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return !!(manifest.dependencies?.['react-native'] ?? manifest.devDependencies?.['react-native']);
  } catch {
    return false;
  }
};

/** The flag wins; otherwise a Flutter pubspec, unless the folder is also a React Native app, which keeps its behavior. */
export const detectRuntime = (root: string, requested?: string): Runtime => {
  if (requested !== undefined && requested !== 'react-native' && requested !== 'flutter')
    throw new Error(`--runtime is react-native or flutter, not ${requested}`);
  if (requested === 'react-native') return 'react-native';
  const pubspec = readIfExists(path.join(root, 'pubspec.yaml'));
  const flutter = pubspec !== undefined && isFlutterPubspec(pubspec);
  if (requested === 'flutter') {
    if (!flutter)
      throw new Error(
        '--runtime flutter needs a pubspec.yaml here whose dependencies include flutter (sdk: flutter); run from the app’s folder or pass --root',
      );
    return 'flutter';
  }
  return flutter && !hasReactNative(root) ? 'flutter' : 'react-native';
};

const GIT_NOTE = [
  'lynkeus_agent (and lynkeus_headless) are git dependencies on github.com/lynkeushq/lynkeus until they are on pub.dev, so `flutter pub get` needs that',
  '      repository to have them. From a checkout of Lynkeus, point at it instead in pubspec.yaml:',
  '        dependency_overrides:',
  '          lynkeus_agent:',
  '            path: /path/to/lynkeus/flutter/lynkeus_agent',
];

/** Flutter setup: the dependency, the start call in `lib/main.dart`, the token. Changes only what is missing. */
export const initFlutter = (root: string, opts: { install: boolean; headless?: boolean }): string[] => {
  const notes: string[] = [];
  const pubspecFile = path.join(root, 'pubspec.yaml');
  const pubspec = fs.readFileSync(pubspecFile, 'utf8');
  if (opts.install) {
    let text = pubspec;
    for (const add of [addAgentToPubspec, ...(opts.headless ? [addHeadlessToPubspec] : [])]) {
      const edit = add(text);
      text = edit.text;
      notes.push(edit.note);
    }
    if (text !== pubspec) fs.writeFileSync(pubspecFile, text);
  } else if (opts.headless) {
    notes.push('--headless adds lynkeus_headless to pubspec.yaml, so it does nothing with --no-install');
  }
  const mainFile = path.join(root, 'lib', 'main.dart');
  const main = readIfExists(mainFile);
  const name = pubspecName(pubspec);
  if (main === undefined) {
    notes.push(`no lib/main.dart; ${mainByHand(name)}`);
  } else {
    const edit = addAgentToMain(main, name);
    if (edit.text !== main) fs.writeFileSync(mainFile, edit.text);
    notes.push(edit.note);
  }
  if (ensureToken(root).made) notes.push('made a token for this project in .lynkeus/token (kept out of git); the CLI, the MCP server and the app all read it');
  notes.push('next: flutter pub get, then run the app with the token:');
  notes.push('      flutter run --dart-define=LYNKEUS_TOKEN=$(cat .lynkeus/token)');
  notes.push('      the agent runs in debug builds; `lynkeus status` says whether it attached');
  if (opts.headless) notes.push('      or with no simulator: lynkeus case run --host  (needs flutter on PATH or FLUTTER_ROOT)');
  if (AGENT_DEPENDENCY.includes('  git:')) {
    notes.push(...GIT_NOTE);
    if (opts.headless) notes.push('          lynkeus_headless:', '            path: /path/to/lynkeus/flutter/lynkeus_headless');
  }
  return notes;
};

/** `lynkeus init`: Flutter or React Native, by `--runtime` or by what the folder is. */
export const setupApp = (root: string, opts: { runtime?: string; install: boolean; headless?: boolean }): string[] => {
  if (detectRuntime(root, opts.runtime) === 'flutter') return initFlutter(root, opts);
  const lines = [...(opts.install ? [installAgent(root)] : []), ...mountAgent(root)];
  if (opts.headless) lines.push('--headless is for Flutter; a React Native app runs headless with `lynkeus headless init`');
  lines.push('next: build the app again and open it, then `lynkeus status` (over MCP: the status tool) to see that it attaches');
  lines.push('      or, with no native build at all: `lynkeus headless init` runs the app in Node in a minute');
  return lines;
};

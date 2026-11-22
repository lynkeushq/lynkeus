import fs from 'node:fs';
import path from 'node:path';

import { ensureToken } from '../config.js';
import { installAgent, mountAgent } from './init.js';

export type Runtime = 'react-native' | 'flutter';

/** Where `lynkeus_agent` comes from. One place to change when the package is published on pub.dev (`['lynkeus_agent: ^x.y.z']`). */
export const AGENT_DEPENDENCY: string[] = ['lynkeus_agent:', '  git:', '    url: https://github.com/lynkeushq/lynkeus.git', '    path: flutter/lynkeus_agent'];

const AGENT_IMPORT = "import 'package:lynkeus_agent/lynkeus_agent.dart';";
const AGENT_START = 'LynkeusAgent.start();';

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

const dependencyByHand = (): string => `add this under dependencies in pubspec.yaml:\n    ${AGENT_DEPENDENCY.join('\n    ')}`;

/** Adds the agent to `dependencies` right under its header, so comments and the rest of the file stay as they are. */
export const addAgentToPubspec = (text: string): Edit => {
  const eol = eolOf(text);
  const lines = text.split(/\r?\n/);
  const block = dependenciesBlock(lines);
  if (!block) return { text, done: false, note: dependencyByHand() };
  const body = lines.slice(block.header + 1, block.end);
  if (body.some((line) => /^[ \t]+lynkeus_agent:/.test(line))) return { text, done: true, note: 'pubspec.yaml already depends on lynkeus_agent' };
  const first = body.find((line) => /^[ \t]+\S/.test(line) && !line.trim().startsWith('#'));
  if (!first) return { text, done: false, note: dependencyByHand() };
  const indent = /^[ \t]*/.exec(first)![0];
  lines.splice(block.header + 1, 0, ...AGENT_DEPENDENCY.map((line) => `${indent}${line}`));
  return { text: lines.join(eol), done: true, note: 'added lynkeus_agent to pubspec.yaml' };
};

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

export const mainByHand = (): string => `add to lib/main.dart:\n    ${AGENT_IMPORT}\n  and, in main(), before runApp(...):\n    ${AGENT_START}`;

/** Imports the agent and starts it before `runApp(`, in a block `main` or in an arrow `main` that becomes one. */
export const addAgentToMain = (text: string): Edit => {
  if (text.includes('LynkeusAgent.start(')) return { text, done: true, note: 'lib/main.dart already starts the agent' };
  const eol = eolOf(text);
  const arrow = /^([ \t]*)((?:Future<void>|void)\s+main\s*\(\s*\)\s*)(async\s*)?=>\s*runApp\(/m.exec(text);
  const plain = /^([ \t]*)runApp\(/m.exec(text);
  let next: string;
  if (arrow) {
    const open = arrow.index + arrow[0].length - 1;
    const close = closeOf(text, open);
    if (close < 0 || text[close] !== ';') return { text, done: false, note: `could not read main() in lib/main.dart; ${mainByHand()}` };
    const indent = arrow[1]!;
    const call = text.slice(open - 'runApp'.length, close);
    const head = `${indent}${arrow[2]!.trimEnd()}${arrow[3] ? ' async' : ''} {`;
    next = `${text.slice(0, arrow.index)}${head}${eol}${indent}  ${AGENT_START}${eol}${indent}  ${call};${eol}${indent}}${text.slice(close + 1)}`;
  } else if (plain) {
    next = `${text.slice(0, plain.index)}${plain[1]}${AGENT_START}${eol}${text.slice(plain.index)}`;
  } else {
    return { text, done: false, note: `no runApp( in lib/main.dart; ${mainByHand()}` };
  }
  // After the last import or export, so the file keeps its order; with none, at the top.
  const imports = [...next.matchAll(/^(?:import|export) [^;]*;[ \t]*$/gm)];
  const last = imports[imports.length - 1];
  next = last
    ? `${next.slice(0, last.index! + last[0].length)}${eol}${AGENT_IMPORT}${next.slice(last.index! + last[0].length)}`
    : `${AGENT_IMPORT}${eol}${eol}${next}`;
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

/** Flutter setup: the dependency, the start call in `lib/main.dart`, the token. Changes only what is missing. */
export const initFlutter = (root: string, opts: { install: boolean }): string[] => {
  const notes: string[] = [];
  if (opts.install) {
    const file = path.join(root, 'pubspec.yaml');
    const before = fs.readFileSync(file, 'utf8');
    const edit = addAgentToPubspec(before);
    if (edit.text !== before) fs.writeFileSync(file, edit.text);
    notes.push(edit.note);
  }
  const mainFile = path.join(root, 'lib', 'main.dart');
  const main = readIfExists(mainFile);
  if (main === undefined) {
    notes.push(`no lib/main.dart; ${mainByHand()}`);
  } else {
    const edit = addAgentToMain(main);
    if (edit.text !== main) fs.writeFileSync(mainFile, edit.text);
    notes.push(edit.note);
  }
  if (ensureToken(root).made) notes.push('made a token for this project in .lynkeus/token (kept out of git); the CLI, the MCP server and the app all read it');
  notes.push('next: flutter pub get, then run the app with the token:');
  notes.push('      flutter run --dart-define=LYNKEUS_TOKEN=$(cat .lynkeus/token)');
  notes.push('      the agent runs in debug builds; `lynkeus status` says whether it attached');
  return notes;
};

/** `lynkeus init`: Flutter or React Native, by `--runtime` or by what the folder is. */
export const setupApp = (root: string, opts: { runtime?: string; install: boolean }): string[] => {
  if (detectRuntime(root, opts.runtime) === 'flutter') return initFlutter(root, { install: opts.install });
  const lines = [...(opts.install ? [installAgent(root)] : []), ...mountAgent(root)];
  lines.push('next: build the app again and open it, then `lynkeus status` (over MCP: the status tool) to see that it attaches');
  lines.push('      or, with no native build at all: `lynkeus headless init` runs the app in Node in a minute');
  return lines;
};

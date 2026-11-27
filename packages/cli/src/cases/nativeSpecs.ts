/**
 * What a native module's members are, as its TurboModule spec declares them: a method, or a constant of
 * `getConstants()`. Lynkeus FastSim answers a member it does not know with a function, so a read the app never called
 * is either a method the app only took a reference to (`setFocusTo: Native.setFocusTo`), which is fine, or a constant
 * that read as true. The spec tells the two apart; without one nothing can.
 *
 * The specs are found where codegen finds them: the folder `codegenConfig.jsSrcsDir` names in the package.json of the
 * app and of each package in its node_modules.
 */
import fs from 'node:fs';
import path from 'node:path';

export type NativeMemberKind = 'method' | 'constant';

/** Module name, then member name. */
export type NativeSpecs = Map<string, Map<string, NativeMemberKind>>;

const MAX_SPEC_BYTES = 256 * 1024;

const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** The text between the brace at `open` and the one that closes it. */
const braced = (text: string, open: number): string | undefined => {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(open + 1, i);
  }
  return undefined;
};

/** The members of an object type's body, split where a member ends at the top level. */
const members = (body: string): string[] => {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if ('{([<'.includes(c)) depth++;
    else if ('})]'.includes(c) || (c === '>' && body[i - 1] !== '=')) depth--;
    else if (depth === 0 && (c === ';' || c === ',' || c === '\n')) {
      out.push(body.slice(start, i));
      start = i + 1;
    }
  }
  out.push(body.slice(start));
  return out.map((m) => m.trim()).filter(Boolean);
};

const MEMBER = /^(?:readonly\s+)?\+?([A-Za-z_$][\w$]*)\??\s*(\(|:)/;

const constantsOf = (member: string): string[] => {
  const arrow = member.search(/=>|\)\s*:/);
  const open = arrow < 0 ? -1 : member.indexOf('{', arrow);
  const body = open < 0 ? undefined : braced(member, open);
  if (body === undefined) return [];
  return members(body.replace(/^\|/, '').replace(/\|$/, ''))
    .map((m) => MEMBER.exec(m)?.[1])
    .filter((name): name is string => name !== undefined);
};

/** The module a spec file registers and the kind of each member, from its source; undefined when it registers none. */
export const parseSpec = (source: string): { module: string; members: Map<string, NativeMemberKind> } | undefined => {
  const text = withoutComments(source);
  const registered = /TurboModuleRegistry\.(?:get|getEnforcing)\s*<\s*([\w$]+)\s*>\s*\(\s*['"]([^'"]+)['"]/.exec(text);
  if (!registered) return undefined;
  const [, specName, module] = registered;
  const declared = new RegExp(`(?:interface|type)\\s+${specName}\\b[^{]*\\{`).exec(text);
  const body = declared ? braced(text, declared.index + declared[0].length - 1) : undefined;
  if (body === undefined) return undefined;
  const kinds = new Map<string, NativeMemberKind>();
  for (const member of members(body.replace(/^\|/, '').replace(/\|$/, ''))) {
    const found = MEMBER.exec(member);
    if (!found) continue;
    const name = found[1]!;
    if (name === 'getConstants') {
      for (const constant of constantsOf(member)) kinds.set(constant, 'constant');
      continue;
    }
    const type = found[2] === '(' ? '(' : member.slice(found[0].length).trimStart();
    kinds.set(name, type.startsWith('(') ? 'method' : 'constant');
  }
  return { module: module!, members: kinds };
};

const specDir = (pkgDir: string): string | undefined => {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as { codegenConfig?: { jsSrcsDir?: unknown } };
    const dir = manifest.codegenConfig?.jsSrcsDir;
    return typeof dir === 'string' ? path.join(pkgDir, dir) : undefined;
  } catch {
    return undefined;
  }
};

const packageDirs = (root: string): string[] => {
  const modules = path.join(root, 'node_modules');
  const out = [root];
  let names: string[] = [];
  try {
    names = fs.readdirSync(modules);
  } catch {
    return out;
  }
  for (const name of names) {
    if (name.startsWith('.')) continue;
    if (!name.startsWith('@')) {
      out.push(path.join(modules, name));
      continue;
    }
    try {
      for (const scoped of fs.readdirSync(path.join(modules, name))) out.push(path.join(modules, name, scoped));
    } catch {
      // A scope folder that cannot be read has no specs to offer.
    }
  }
  return out;
};

const specFiles = (dir: string, depth = 2): string[] => {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((e) => {
    const file = path.join(dir, e.name);
    if (e.isDirectory()) return depth > 0 && e.name !== 'node_modules' && e.name !== '__tests__' ? specFiles(file, depth - 1) : [];
    return /\.(ts|tsx|js|jsx)$/.test(e.name) && !e.name.endsWith('.d.ts') ? [file] : [];
  });
};

/** The members of `modules` as the specs under `root` declare them; a module with no spec found is left out. */
export const readNativeSpecs = (root: string, modules: Iterable<string>): NativeSpecs => {
  const wanted = new Set(modules);
  const specs: NativeSpecs = new Map();
  if (wanted.size === 0) return specs;
  for (const pkg of packageDirs(root)) {
    const dir = specDir(pkg);
    if (!dir) continue;
    for (const file of specFiles(dir)) {
      let source: string;
      try {
        if (fs.statSync(file).size > MAX_SPEC_BYTES) continue;
        source = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      if (!source.includes('TurboModuleRegistry')) continue;
      const spec = parseSpec(source);
      if (spec && wanted.has(spec.module) && !specs.has(spec.module)) specs.set(spec.module, spec.members);
    }
  }
  return specs;
};

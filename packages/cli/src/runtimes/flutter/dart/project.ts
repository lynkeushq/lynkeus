/**
 * An app's Dart files read together: names resolved across them, constant strings evaluated (consts, static fields,
 * enum values and their fields, string interpolation, functions that switch over an enum), and the call sites of a
 * function, so a route built inside a helper is read once per call with that call's arguments.
 */
import fs from 'node:fs';
import path from 'node:path';

import { type Arg, type ClassDecl, type Code, calleeOf, DartFile, fragment, type Member, type Range, splitItems } from './library.js';

export type Env = {
  code: Code;
  owner?: ClassDecl;
  self?: Value;
  bindings?: Map<string, Bound>;
  /** The call that entered this context, for walking out of a helper to what holds the call. */
  callSite?: { code: Code; at: number; env: Env };
  depth: number;
};

export type Bound = { range: Range; env: Env };

export type Value =
  /** `exact` is false when a piece could not be known; each unknown piece is a NUL. */
  | { kind: 'string'; text: string; exact: boolean }
  | { kind: 'enum'; decl: ClassDecl; file: DartFile; name: string }
  | { kind: 'class'; decl: ClassDecl; file: DartFile }
  | { kind: 'function'; member: Member; file: DartFile; env: Env }
  /** Not a constant: a closure, a list, an object being built. */
  | { kind: 'code'; range: Range; env: Env }
  | { kind: 'unknown' };

export const HOLE = '\u0000';
const UNKNOWN: Value = { kind: 'unknown' };
const MAX_DEPTH = 40;

// What a widget can extend from outside the app; anything else outside it is judged by its name.
const WIDGET_BASES = new Set([
  'Widget',
  'StatelessWidget',
  'StatefulWidget',
  'ConsumerWidget',
  'ConsumerStatefulWidget',
  'HookWidget',
  'HookConsumerWidget',
  'StatefulHookWidget',
  'StatefulHookConsumerWidget',
  'GetView',
  'GetWidget',
  'StatelessObserverWidget',
  'ProxyWidget',
  'InheritedWidget',
]);
const NOT_WIDGETS = /(^|[^A-Za-z])(Page|MaterialPage|CupertinoPage|CustomTransitionPage|NoTransitionPage|PageRoute|Route|State|ChangeNotifier|Cubit|Bloc)$/;

type Located<T> = { item: T; file: DartFile };

export class DartProject {
  readonly files = new Map<string, DartFile>();
  private readonly classIndex = new Map<string, Located<ClassDecl>[]>();
  private readonly topIndex = new Map<string, Located<Member>[]>();
  private readonly refCache = new Map<string, { file: DartFile; at: number }[]>();
  private readonly libraries = new Map<DartFile, DartFile[]>();

  constructor(
    readonly root: string,
    /** The app's package, for `package:<name>/` imports. */
    readonly packageName: string,
    sources: { rel: string; text: string }[],
  ) {
    for (const { rel, text } of sources) this.files.set(rel, new DartFile(rel, text));
    for (const file of this.files.values()) {
      for (const decl of file.classes) push(this.classIndex, decl.name, { item: decl, file });
      for (const member of file.topLevel) push(this.topIndex, member.name, { item: member, file });
    }
  }

  static read(root: string, packageName: string, dir = 'lib'): DartProject {
    const sources: { rel: string; text: string }[] = [];
    const walk = (abs: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(abs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(abs, entry.name);
        if (entry.isDirectory()) {
          if (!entry.name.startsWith('.')) walk(full);
        } else if (entry.name.endsWith('.dart')) sources.push({ rel: path.relative(root, full), text: fs.readFileSync(full, 'utf8') });
      }
    };
    walk(path.join(root, dir));
    sources.sort((a, b) => a.rel.localeCompare(b.rel));
    return new DartProject(root, packageName, sources);
  }

  /** The app's file an import, export or part URI names; undefined for packages and the SDK. */
  resolveUri(from: DartFile, uri: string): DartFile | undefined {
    if (uri.startsWith('dart:')) return undefined;
    const prefix = `package:${this.packageName}/`;
    let rel: string;
    if (uri.startsWith(prefix)) rel = path.join('lib', uri.slice(prefix.length));
    else if (uri.startsWith('package:')) return undefined;
    else rel = path.normalize(path.join(path.dirname(from.rel), uri));
    return this.files.get(rel);
  }

  /** The file and the parts that share its library: private names are visible across them. */
  library(file: DartFile): DartFile[] {
    const known = this.libraries.get(file);
    if (known) return known;
    const ownerUri = file.directives.find((d) => d.kind === 'part of')?.uris[0];
    const owner = ownerUri ? (this.resolveUri(file, ownerUri) ?? file) : file;
    const parts = owner.directives.filter((d) => d.kind === 'part').flatMap((d) => d.uris.map((u) => this.resolveUri(owner, u)));
    const all = [owner, ...parts.filter((p): p is DartFile => !!p)];
    if (!all.includes(file)) all.push(file);
    this.libraries.set(file, all);
    return all;
  }

  private visible<T>(list: Located<T>[] | undefined, name: string, from: DartFile): Located<T> | undefined {
    if (!list?.length) return undefined;
    const lib = this.library(from);
    const local = list.find((l) => lib.includes(l.file));
    if (local) return local;
    if (name.startsWith('_')) return undefined;
    return list[0];
  }

  classNamed(name: string, from: DartFile): Located<ClassDecl> | undefined {
    return this.visible(this.classIndex.get(name), name, from);
  }

  topLevelNamed(name: string, from: DartFile): Located<Member> | undefined {
    return this.visible(this.topIndex.get(name), name, from);
  }

  /** A class of the app that renders: what a route's builder returns, or what a push builds. */
  isWidget(name: string, from: DartFile, seen = new Set<string>()): boolean {
    const found = this.classNamed(name, from);
    if (found?.item.kind !== 'class' || seen.has(name)) return false;
    seen.add(name);
    const base = found.item.superclass;
    if (!base) return false;
    if (WIDGET_BASES.has(base)) return true;
    if (this.classNamed(base, found.file)) return this.isWidget(base, found.file, seen);
    return !NOT_WIDGETS.test(base) && /(Widget|View|Screen|Page)$/.test(base);
  }

  /** Where a member's name is used outside its own declaration. */
  references(member: Member, file: DartFile): { file: DartFile; at: number; open?: number }[] {
    const key = `${file.rel}:${member.nameAt}`;
    let found = this.refCache.get(key);
    if (!found) {
      const name = member.name.includes('.') ? member.name.split('.').at(-1)! : member.name;
      const scope = name.startsWith('_') ? this.library(file) : [...this.files.values()];
      found = [];
      for (const f of scope) {
        f.tokens.forEach((t, at) => {
          if (t.kind === 'ident' && t.text === name && !(f === file && at === member.nameAt)) found!.push({ file: f, at });
        });
      }
      this.refCache.set(key, found);
    }
    return found.map((r) => {
      let next = r.at + 1;
      if (r.file.t(next) === '<') next = r.file.skipAngles(next);
      return r.file.t(next) === '(' ? { ...r, open: next } : r;
    });
  }

  /** A call's arguments bound to the names of the parameters they fill. */
  bind(member: Member, code: Code, open: number, env: Env): Map<string, Bound> {
    const bindings = new Map<string, Bound>();
    const params = member.params ?? [];
    let index = 0;
    for (const arg of splitItems(code, open)) {
      const position = arg.name ? -1 : index++;
      const param = arg.name ? params.find((p) => p.named && p.name === arg.name) : params.find((p) => !p.named && p.index === position);
      if (param) bindings.set(param.name, { range: { start: arg.start, end: arg.end }, env });
    }
    return bindings;
  }

  /** The env inside a member: its class, and `self` when an enum's own getter is asked about one of its values. */
  envOf(member: Member, file: DartFile, extra: Partial<Env> = {}): Env {
    return { code: file, ...(member.owner ? { owner: member.owner } : {}), depth: 0, ...extra };
  }

  evaluate(range: Range, env: Env): Value {
    if (env.depth > MAX_DEPTH) return UNKNOWN;
    const deeper = { ...env, depth: env.depth + 1 };
    const { code } = env;
    const t = (i: number) => code.tokens[i]?.text ?? '';
    let { start } = range;
    let { end } = range;
    while (start < end && (t(start) === 'const' || t(start) === 'new' || t(start) === 'await')) start++;
    while (end > start && t(end - 1) === '!') end--;
    if (start >= end) return UNKNOWN;
    if (t(start) === '(' && code.match[start] === end - 1) return this.evaluate({ start: start + 1, end: end - 1 }, deeper);
    if (isClosure(code, start)) return { kind: 'code', range: { start, end }, env };
    // A collection literal, typed or not: the caller reads its items.
    const literalAt = t(start) === '<' ? skipAnglesIn(code, start) : start;
    if ((t(literalAt) === '{' || t(literalAt) === '[') && code.match[literalAt] === end - 1) return { kind: 'code', range: { start: literalAt, end }, env };

    const ops = topLevel(code, start, end, ['+', '??', '?', '==', '!=', '&&', '||', 'as', 'is']);
    if (ops.some((o) => ['?', '==', '!=', '&&', '||', 'is'].includes(t(o)))) return UNKNOWN;
    const asAt = ops.find((o) => t(o) === 'as');
    if (asAt !== undefined) return this.evaluate({ start, end: asAt }, deeper);
    const nullish = ops.filter((o) => t(o) === '??');
    if (nullish.length) {
      const left = this.evaluate({ start, end: nullish[0]! }, deeper);
      return left.kind === 'unknown' ? this.evaluate({ start: nullish[0]! + 1, end }, deeper) : left;
    }
    const plus = ops.filter((o) => t(o) === '+');
    if (plus.length) {
      const bounds = [start, ...plus.map((p) => p + 1)];
      const ends = [...plus, end];
      return concat(bounds.map((s, k) => this.evaluate({ start: s, end: ends[k]! }, deeper)));
    }
    if (t(start) === 'switch') return this.evaluateSwitch(start, deeper);
    if (code.tokens.slice(start, end).every((tok) => tok.kind === 'string')) {
      const pieces: Value[] = [];
      for (let i = start; i < end; i++) {
        for (const part of code.tokens[i]!.parts ?? []) {
          if ('text' in part) pieces.push({ kind: 'string', text: part.text, exact: true });
          else {
            const inner = fragment(code.file, part.expr);
            pieces.push(this.evaluate({ start: 0, end: inner.tokens.length }, { ...deeper, code: inner }));
          }
        }
      }
      return concat(pieces.length ? pieces : [{ kind: 'string', text: '', exact: true }]);
    }
    return this.evaluateChain(start, end, deeper);
  }

  /** The exact string an expression always is, or undefined. */
  string(range: Range, env: Env): string | undefined {
    const v = this.evaluate(range, env);
    return v.kind === 'string' && v.exact ? v.text : undefined;
  }

  private evaluateChain(start: number, end: number, env: Env): Value {
    const { code } = env;
    const t = (i: number) => code.tokens[i]?.text ?? '';
    type Segment = { name: string; at: number; args?: number };
    const segments: Segment[] = [];
    let i = start;
    if (t(i) === '.' && code.tokens[i + 1]?.kind === 'ident') i++; // a dot shorthand: `.about`
    while (i < end) {
      const tok = code.tokens[i]!;
      if (tok.kind !== 'ident' && !(tok.kind === 'string' && segments.length === 0)) return UNKNOWN;
      const segment: Segment = { name: tok.text, at: i };
      i++;
      if (t(i) === '<') {
        const after = skipAnglesIn(code, i);
        if (t(after) === '(') i = after;
      }
      if (t(i) === '(') {
        segment.args = i;
        i = (code.match[i] ?? i) + 1;
      }
      while (t(i) === '!') i++;
      segments.push(segment);
      if (t(i) === '.' || t(i) === '?.') {
        i++;
        continue;
      }
      break;
    }
    if (i !== end || segments.length === 0) return UNKNOWN;
    const first = segments[0]!;
    let value = code.tokens[first.at]!.kind === 'string' ? this.evaluate({ start: first.at, end: first.at + 1 }, env) : this.evaluateName(first, env);
    for (const segment of segments.slice(1)) value = this.memberOf(value, segment, env);
    return value;
  }

  private evaluateName(segment: { name: string; at: number; args?: number }, env: Env): Value {
    const { name, args } = segment;
    const file = env.code.file;
    if (name === 'this') return env.self ?? UNKNOWN;
    if (name === 'null' || name === 'true' || name === 'false') return UNKNOWN;
    const bound = env.bindings?.get(name);
    if (bound && args === undefined) return this.evaluate(bound.range, { ...bound.env, depth: env.depth + 1 });
    if (bound) return UNKNOWN;
    if (env.owner) {
      const own = env.owner.members.find((m) => m.name === name && m.kind !== 'constructor');
      if (own) return this.use(own, file, env, args, env.self);
      if (env.owner.kind === 'enum' && args === undefined && env.owner.values.some((v) => v.name === name))
        return { kind: 'enum', decl: env.owner, file: this.fileOfClass(env.owner, file), name };
    }
    const top = this.topLevelNamed(name, file);
    if (top) return this.use(top.item, top.file, { ...env, code: top.file }, args);
    const cls = this.classNamed(name, file);
    if (cls && args === undefined) return { kind: 'class', decl: cls.item, file: cls.file };
    if (cls) return { kind: 'code', range: { start: segment.at, end: (env.code.match[args!] ?? args!) + 1 }, env };
    return UNKNOWN;
  }

  private fileOfClass(decl: ClassDecl, near: DartFile): DartFile {
    return this.classIndex.get(decl.name)?.find((l) => l.item === decl)?.file ?? near;
  }

  /** A member read (a field, a getter) or called (a function), with `self` for an enum value's own members. */
  private use(member: Member, file: DartFile, env: Env, args: number | undefined, self?: Value): Value {
    const inner: Env = { code: file, ...(member.owner ? { owner: member.owner } : {}), ...(self ? { self } : {}), depth: env.depth + 1 };
    if (member.kind === 'field') return member.init && args === undefined ? this.evaluate(member.init, inner) : UNKNOWN;
    if (member.kind === 'getter') return args === undefined ? this.evaluateBody(member, inner) : UNKNOWN;
    if (member.kind === 'function') {
      if (args === undefined) return { kind: 'function', member, file, env: inner };
      return this.evaluateBody(member, { ...inner, bindings: this.bind(member, env.code, args, env) });
    }
    return UNKNOWN;
  }

  private memberOf(value: Value, segment: { name: string; at: number; args?: number }, env: Env): Value {
    const { name, args } = segment;
    if (value.kind === 'class') {
      const { decl, file } = value;
      if (decl.kind === 'enum' && args === undefined && decl.values.some((v) => v.name === name)) return { kind: 'enum', decl, file, name };
      const member = decl.members.find((m) => m.name === name && m.isStatic);
      if (member) return this.use(member, file, env, args);
      return UNKNOWN;
    }
    if (value.kind === 'enum') {
      const { decl, file } = value;
      const member = decl.members.find((m) => m.name === name && !m.isStatic && m.kind !== 'constructor');
      if (member?.kind === 'field') return this.enumField(value, member);
      if (member) return this.use(member, file, env, args, value);
      if (name === 'name' && args === undefined) return { kind: 'string', text: value.name, exact: true };
      return UNKNOWN;
    }
    if (value.kind === 'string' && (name === 'toString' || name === 'trim')) return value;
    return UNKNOWN;
  }

  /** An enhanced enum's field: the value's own constructor argument for it, or the field's initializer. */
  private enumField(value: Extract<Value, { kind: 'enum' }>, field: Member): Value {
    const { decl, file } = value;
    const env: Env = { code: file, owner: decl, self: value, depth: 1 };
    const entry = decl.values.find((v) => v.name === value.name);
    const ctor = decl.members.find((m) => m.kind === 'constructor' && (m.name === decl.name || !m.name.includes('.')));
    const param = ctor?.params?.find((p) => p.field && p.name === field.name);
    if (entry?.args !== undefined && param) {
      const items = splitItems(file, entry.args);
      const arg = param.named ? items.find((a) => a.name === param.name) : items.filter((a) => !a.name)[param.index];
      if (arg) return this.evaluate({ start: arg.start, end: arg.end }, env);
    }
    return field.init ? this.evaluate(field.init, env) : UNKNOWN;
  }

  /** What a function or getter returns: its arrow expression, its first `return`, or the `switch` it returns from. */
  evaluateBody(member: Member, env: Env): Value {
    const body = member.body;
    if (!body) return UNKNOWN;
    if (member.arrow) return this.evaluate(body, env);
    const file = env.code;
    for (let i = body.start + 1; i < body.end - 1; i++) {
      const s = file.tokens[i]!.text;
      if (s === 'return') return this.evaluate({ start: i + 1, end: endOfStatement(file, i + 1, body.end - 1) }, env);
      if (s === 'switch') return this.evaluateSwitch(i, env);
      if (s === '{' || s === '(' || s === '[') i = Math.max(i, file.match[i] ?? i);
    }
    return UNKNOWN;
  }

  private evaluateSwitch(at: number, env: Env): Value {
    const cases = switchCases(env.code, at);
    if (!cases) return UNKNOWN;
    const subject = this.evaluate(cases.subject, env);
    if (subject.kind === 'unknown') return UNKNOWN;
    for (const c of cases.cases) {
      const hit = c.isDefault || c.patterns.some((p) => this.patternMatches(p, subject, env));
      if (!hit) continue;
      const value = c.value ?? returned(env.code, c.body);
      return value ? this.evaluate(value, env) : UNKNOWN;
    }
    return UNKNOWN;
  }

  private patternMatches(pattern: Range, subject: Value, env: Env): boolean {
    const t = (i: number) => env.code.tokens[i]?.text ?? '';
    if (pattern.end - pattern.start === 1 && t(pattern.start) === '_') return true;
    if (t(pattern.start) === '.' && subject.kind === 'enum') return t(pattern.start + 1) === subject.name;
    return sameValue(this.evaluate(pattern, env), subject);
  }
}

const push = <K, V>(map: Map<K, V[]>, key: K, value: V) => {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
};

const skipAnglesIn = (code: Code, i: number): number => (code.file === code ? (code as DartFile).skipAngles(i) : angles(code, i));

const angles = (code: Code, i: number): number => {
  let depth = 0;
  for (let j = i; j < code.tokens.length; j++) {
    const s = code.tokens[j]!.text;
    if (s === '<') depth++;
    else if (s === '>') depth--;
    if (depth <= 0) return j + 1;
  }
  return code.tokens.length;
};

export const sameValue = (a: Value, b: Value): boolean => {
  if (a.kind === 'string' && b.kind === 'string') return a.exact && b.exact && a.text === b.text;
  if (a.kind === 'enum' && b.kind === 'enum') return a.decl.name === b.decl.name && a.name === b.name;
  return false;
};

const concat = (values: Value[]): Value => {
  let text = '';
  let exact = true;
  for (const v of values) {
    if (v.kind === 'string') {
      text += v.text;
      exact &&= v.exact;
    } else {
      text += HOLE;
      exact = false;
    }
  }
  return text.replaceAll(HOLE, '') === '' && !exact ? UNKNOWN : { kind: 'string', text, exact };
};

/** `(a, b) => …`, `(a) async { … }`, `() {}`: a function literal starting at `i`. */
export const isClosure = (code: Code, i: number): boolean => {
  if (code.tokens[i]?.text !== '(') return false;
  let j = (code.match[i] ?? -1) + 1;
  if (j <= 0) return false;
  while (['async', 'sync', '*'].includes(code.tokens[j]?.text ?? '')) j++;
  const s = code.tokens[j]?.text;
  return s === '=>' || s === '{';
};

/** The body of a function literal at `range`: the arrow's expression, or the block. */
export const closureBody = (code: Code, range: Range): Range | undefined => {
  if (!isClosure(code, range.start)) return undefined;
  let j = code.match[range.start]! + 1;
  while (['async', 'sync', '*'].includes(code.tokens[j]?.text ?? '')) j++;
  if (code.tokens[j]?.text === '=>') return { start: j + 1, end: range.end };
  const close = code.match[j] ?? -1;
  return { start: j, end: close > j ? close + 1 : range.end };
};

/** Positions of the given operators at the top level of a range: not inside brackets. */
export const topLevel = (code: Code, start: number, end: number, ops: string[]): number[] => {
  const out: number[] = [];
  for (let i = start; i < end; i++) {
    const tok = code.tokens[i]!;
    if (tok.text === '(' || tok.text === '[' || tok.text === '{') {
      i = Math.max(i, code.match[i] ?? i);
      continue;
    }
    if ((tok.kind === 'punct' || tok.text === 'as' || tok.text === 'is') && ops.includes(tok.text) && i > start) out.push(i);
  }
  return out;
};

export const endOfStatement = (code: Code, i: number, end: number): number => {
  let j = i;
  for (; j < end && code.tokens[j]!.text !== ';'; j++) {
    const s = code.tokens[j]!.text;
    if (s === '(' || s === '[' || s === '{') j = Math.max(j, code.match[j] ?? j);
  }
  return j;
};

/** The expression a block returns first, at its top level. */
export const returned = (code: Code, body: Range): Range | undefined => {
  for (let i = body.start; i < body.end; i++) {
    const s = code.tokens[i]!.text;
    if (s === 'return') return { start: i + 1, end: endOfStatement(code, i + 1, body.end) };
    if (s === '{' || s === '(' || s === '[') i = Math.max(i, code.match[i] ?? i);
  }
  return undefined;
};

export type SwitchCase = { patterns: Range[]; isDefault: boolean; body: Range; value?: Range };

/** A `switch` statement's cases (patterns and the statements under them) or a switch expression's arms. */
export const switchCases = (code: Code, at: number): { subject: Range; cases: SwitchCase[]; open: number } | undefined => {
  const t = (i: number) => code.tokens[i]?.text ?? '';
  if (t(at + 1) !== '(') return undefined;
  const close = code.match[at + 1] ?? -1;
  const open = close + 1;
  if (close < 0 || t(open) !== '{') return undefined;
  const end = code.match[open] ?? -1;
  if (end < 0) return undefined;
  const subject = { start: at + 2, end: close };
  const alternatives = (r: Range): Range[] => {
    const bars = topLevel(code, r.start, r.end, ['||', 'when']);
    const whenAt = bars.find((b) => t(b) === 'when');
    const stop = whenAt ?? r.end;
    const cuts = [r.start, ...bars.filter((b) => t(b) === '||' && b < stop).map((b) => b + 1)];
    const ends = [...bars.filter((b) => t(b) === '||' && b < stop), stop];
    return cuts.map((s, k) => ({ start: s, end: ends[k]! }));
  };
  const cases: SwitchCase[] = [];
  if (t(open + 1) === 'case' || t(open + 1) === 'default') {
    const marks: number[] = [];
    for (let i = open + 1; i < end; i++) {
      const s = t(i);
      if (s === 'case' || s === 'default') marks.push(i);
      if (s === '(' || s === '[' || s === '{') i = Math.max(i, code.match[i] ?? i);
    }
    const pending: Range[] = [];
    marks.forEach((m, k) => {
      const next = marks[k + 1] ?? end;
      let colon = m + 1;
      for (; colon < next && t(colon) !== ':'; colon++) if (['(', '[', '{'].includes(t(colon))) colon = Math.max(colon, code.match[colon] ?? colon);
      const isDefault = t(m) === 'default';
      if (!isDefault) pending.push(...alternatives({ start: m + 1, end: colon }));
      const body = { start: colon + 1, end: next };
      // An empty case falls through to the next one's statements.
      if (body.end > body.start || isDefault) {
        cases.push({ patterns: [...pending], isDefault, body });
        pending.length = 0;
      }
    });
    return { subject, cases, open };
  }
  for (const arm of splitItems(code, open) as Arg[]) {
    const arrow = topLevel(code, arm.start, arm.end, ['=>'])[0];
    if (arrow === undefined) continue;
    const pattern = { start: arm.start, end: arrow };
    const isDefault = arrow - arm.start === 1 && t(arm.start) === '_';
    cases.push({
      patterns: isDefault ? [] : alternatives(pattern),
      isDefault,
      body: { start: arrow + 1, end: arm.end },
      value: { start: arrow + 1, end: arm.end },
    });
  }
  return { subject, cases, open };
};

export { calleeOf };

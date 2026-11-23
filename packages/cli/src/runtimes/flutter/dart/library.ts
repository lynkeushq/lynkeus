/**
 * A Dart file's outline from its tokens: directives, classes, members and their bodies, and the brackets that hold
 * them. Expressions are not parsed into a tree; callers read token ranges, which is what keeps this tolerant of syntax
 * it has never seen.
 */
import { type Token, tokenize } from './lexer.js';

/** Token indices, `end` exclusive. */
export type Range = { start: number; end: number };

export type Param = { name: string; named: boolean; index: number; field: boolean };

export type Member = {
  kind: 'field' | 'function' | 'getter' | 'constructor';
  name: string;
  isStatic: boolean;
  line: number;
  /** The whole declaration. */
  range: Range;
  /** At the declaration's name. */
  nameAt: number;
  params?: Param[];
  /** Block bodies include their braces; arrow bodies are the expression. */
  body?: Range;
  arrow?: boolean;
  /** A field's initializer. */
  init?: Range;
  owner?: ClassDecl;
};

export type EnumValue = { name: string; line: number; args?: number };

export type ClassDecl = {
  kind: 'class' | 'mixin' | 'enum' | 'extension';
  name: string;
  superclass?: string;
  line: number;
  body: Range;
  members: Member[];
  values: EnumValue[];
};

export type Directive = { kind: 'import' | 'export' | 'part' | 'part of'; uris: string[]; show?: string[]; line: number };

/** Something with tokens and their brackets: a file, or an interpolated expression read inside one. */
export type Code = { tokens: Token[]; match: Int32Array; parent: Int32Array; file: DartFile };

const OPEN: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
const CLOSE = new Set([')', ']', '}']);

/** `match[i]` is the partner of a bracket at `i`; `parent[i]` the innermost open bracket around token `i`. */
export const bracketsOf = (tokens: Token[]): { match: Int32Array; parent: Int32Array } => {
  const match = new Int32Array(tokens.length).fill(-1);
  const parent = new Int32Array(tokens.length).fill(-1);
  const stack: number[] = [];
  tokens.forEach((t, i) => {
    parent[i] = stack.at(-1) ?? -1;
    if (t.kind !== 'punct') return;
    if (OPEN[t.text]) {
      stack.push(i);
      return;
    }
    if (!CLOSE.has(t.text)) return;
    // Tolerant: a stray closer pops back to its own kind, or is ignored.
    const at = stack.findLastIndex((o) => OPEN[tokens[o]!.text] === t.text);
    if (at < 0) return;
    const open = stack[at]!;
    stack.length = at;
    match[open] = i;
    match[i] = open;
    parent[i] = stack.at(-1) ?? -1;
  });
  return { match, parent };
};

const MODIFIERS = new Set(['abstract', 'base', 'final', 'sealed', 'interface', 'mixin', 'augment', 'macro']);
const CLASS_WORDS = new Set(['class', 'mixin', 'enum', 'extension']);

export class DartFile implements Code {
  readonly tokens: Token[];
  readonly match: Int32Array;
  readonly parent: Int32Array;
  readonly file = this;
  readonly directives: Directive[] = [];
  readonly classes: ClassDecl[] = [];
  readonly topLevel: Member[] = [];
  /** Every member, nested ones included, by position: the innermost holding a token is the last that does. */
  readonly members: Member[] = [];
  private names?: Set<string>;

  constructor(
    /** Relative to the app's root. */
    readonly rel: string,
    readonly text: string,
  ) {
    this.tokens = tokenize(text);
    ({ match: this.match, parent: this.parent } = bracketsOf(this.tokens));
    this.readDeclarations(0, this.tokens.length);
    this.members.sort((a, b) => a.range.start - b.range.start);
  }

  t(i: number): string {
    return this.tokens[i]?.text ?? '';
  }

  line(i: number): number {
    return this.tokens[i]?.line ?? this.tokens.at(-1)?.line ?? 1;
  }

  /** Past the bracket group opening at `i`, or `i + 1` for anything else. */
  skip(i: number): number {
    const m = this.match[i] ?? -1;
    return m > i ? m + 1 : i + 1;
  }

  /** Names this file declares at the top level: what an import of it can bring in. */
  get declared(): Set<string> {
    this.names ??= new Set([...this.classes.map((c) => c.name), ...this.topLevel.map((m) => m.name)]);
    return this.names;
  }

  /** The innermost member around token `i`. */
  memberAt(i: number): Member | undefined {
    let found: Member | undefined;
    for (const m of this.members) {
      if (m.range.start > i) break;
      if (i < m.range.end) found = m;
    }
    return found;
  }

  classAt(i: number): ClassDecl | undefined {
    return this.classes.find((c) => c.body.start < i && i < c.body.end);
  }

  source(range: Range, max = 120): string {
    const parts: string[] = [];
    for (let i = range.start; i < range.end; i++) parts.push(this.t(i));
    return parts
      .join(' ')
      .replace(/ ?([.(),[\]<>!?]) ?/g, '$1')
      .replace(/,(?=\S)/g, ', ')
      .slice(0, max);
  }

  private readDeclarations(start: number, end: number, owner?: ClassDecl): void {
    let i = start;
    while (i < end) {
      const t = this.tokens[i]!;
      if (t.text === ';') {
        i++;
        continue;
      }
      if (t.text === '@') {
        i = this.skipAnnotation(i);
        continue;
      }
      if (!owner && (t.text === 'import' || t.text === 'export' || t.text === 'part' || t.text === 'library')) {
        i = this.readDirective(i, end);
        continue;
      }
      i = this.readDeclaration(i, end, owner);
    }
  }

  private skipAnnotation(i: number): number {
    let j = i + 1;
    while (this.tokens[j]?.kind === 'ident' && this.t(j + 1) === '.') j += 2;
    j++;
    if (this.t(j) === '<') j = this.skipAngles(j);
    if (this.t(j) === '(') j = this.skip(j);
    return j;
  }

  /** Past a `<...>` generic list starting at `i`. */
  skipAngles(i: number): number {
    let depth = 0;
    for (let j = i; j < this.tokens.length; j++) {
      const s = this.t(j);
      if (s === '<') depth++;
      else if (s === '>') depth--;
      else if (s === '>>') depth -= 2;
      else if (s === '(' || s === '[' || s === '{') j = this.skip(j) - 1;
      else if (s === ';' || s === '=>') return j;
      if (depth <= 0) return j + 1;
    }
    return this.tokens.length;
  }

  private readDirective(i: number, end: number): number {
    const word = this.t(i);
    let j = i + 1;
    const uris: string[] = [];
    let show: string[] | undefined;
    let kind: Directive['kind'] = word === 'part' && this.t(j) === 'of' ? 'part of' : (word as Directive['kind']);
    let inShow = false;
    for (; j < end && this.t(j) !== ';'; j++) {
      const tok = this.tokens[j]!;
      if (tok.kind === 'string') uris.push(tok.parts?.map((p) => ('text' in p ? p.text : '')).join('') ?? '');
      else if (tok.text === 'show') {
        inShow = true;
        show ??= [];
      } else if (tok.text === 'hide' || tok.text === 'if' || tok.text === 'as') inShow = false;
      else if (inShow && tok.kind === 'ident') show?.push(tok.text);
      else if (tok.text === '(') j = this.skip(j) - 1;
    }
    if (word !== 'library') {
      if (word === 'part' && kind !== 'part of') kind = 'part';
      this.directives.push({ kind, uris, ...(show ? { show } : {}), line: this.line(i) });
    }
    return j + 1;
  }

  /** One declaration from `i`: a class-like, a function, a getter, a constructor or fields. */
  private readDeclaration(i: number, end: number, owner?: ClassDecl): number {
    const from = i;
    let classWord: string | undefined;
    let classAt = -1;
    let parenAt = -1;
    let equalsAt = -1;
    let j = i;
    for (; j < end; j++) {
      const s = this.t(j);
      if (classWord === undefined && CLASS_WORDS.has(s) && this.tokens[j]!.kind === 'ident') {
        // `mixin` is also a class modifier (`mixin class X`).
        if (!(s === 'mixin' && this.t(j + 1) === 'class')) {
          const before = j === from || [...Array(j - from).keys()].every((k) => MODIFIERS.has(this.t(from + k)));
          if (before) {
            classWord = s;
            classAt = j;
          }
        }
      }
      if (s === '(' && parenAt < 0 && equalsAt < 0 && classWord === undefined) parenAt = j;
      if (s === '=' && equalsAt < 0 && parenAt < 0) equalsAt = j;
      if (s === ';') break;
      if (s === '=>' && classWord === undefined) break;
      if (s === '{') {
        // A map or set literal in an initializer is not a body.
        if (equalsAt >= 0 && parenAt < 0 && classWord === undefined) {
          j = this.skip(j) - 1;
          continue;
        }
        break;
      }
      if (s === '(' || s === '[') j = this.skip(j) - 1;
    }
    const stop = Math.min(j, end);
    if (classWord !== undefined && this.t(stop) === '{') return this.readClass(classAt, classWord, stop, owner);
    if (classWord !== undefined) return stop + 1;
    if (this.t(from) === 'typedef') return stop + 1;

    const isStatic = this.tokens.slice(from, stop).some((t) => t.text === 'static');
    if (parenAt >= 0) return this.readFunction(from, parenAt, end, isStatic, owner);
    const getAt = this.tokens.slice(from, stop).findIndex((t) => t.text === 'get');
    if (getAt >= 0 && (this.t(stop) === '{' || this.t(stop) === '=>')) {
      const nameAt = from + getAt + 1;
      return this.addBodied({ kind: 'getter', name: this.t(nameAt), nameAt, isStatic, from, bodyAt: stop, owner });
    }
    if (equalsAt >= 0 || this.t(stop) === ';') return this.readFields(from, end, isStatic, owner);
    // Fields without initializers, or something unknown: either way, nothing to keep past the semicolon.
    if (this.t(stop) === '{') return this.skip(stop);
    if (this.t(stop) === '=>') return this.endOfExpression(stop + 1, end) + 1;
    return stop + 1;
  }

  private readClass(classAt: number, word: string, open: number, owner?: ClassDecl): number {
    let nameAt = classAt + 1;
    if (word === 'extension' && this.t(nameAt) === 'type') nameAt++;
    const unnamed = word === 'extension' && this.t(nameAt) === 'on';
    const extendsAt = this.tokens.slice(classAt, open).findIndex((t) => t.text === 'extends' || (word === 'mixin' && t.text === 'on'));
    const close = this.match[open]! > open ? this.match[open]! : this.tokens.length;
    const decl: ClassDecl = {
      kind: word as ClassDecl['kind'],
      name: unnamed ? '' : this.t(nameAt),
      ...(extendsAt >= 0 ? { superclass: this.t(classAt + extendsAt + 1) } : {}),
      line: this.line(classAt),
      body: { start: open, end: close + 1 },
      members: [],
      values: [],
    };
    if (!owner) this.classes.push(decl);
    let bodyStart = open + 1;
    if (word === 'enum') bodyStart = this.readEnumValues(decl, open + 1, close);
    this.readDeclarations(bodyStart, close, decl);
    return close + 1;
  }

  private readEnumValues(decl: ClassDecl, start: number, close: number): number {
    let i = start;
    while (i < close && this.t(i) !== ';') {
      if (this.t(i) === '@') {
        i = this.skipAnnotation(i);
        continue;
      }
      if (this.tokens[i]!.kind === 'ident') {
        const value: EnumValue = { name: this.t(i), line: this.line(i) };
        let j = i + 1;
        if (this.t(j) === '<') j = this.skipAngles(j);
        if (this.t(j) === '.') j += 2;
        if (this.t(j) === '(') {
          value.args = j;
          j = this.skip(j);
        }
        decl.values.push(value);
        i = j;
        continue;
      }
      i++;
    }
    return i < close ? i + 1 : close;
  }

  private readFunction(from: number, parenAt: number, end: number, isStatic: boolean, owner?: ClassDecl): number {
    let nameAt = parenAt - 1;
    if (this.t(nameAt) === '>') {
      // `T foo<T>(...)`: walk back over the type parameters.
      let depth = 0;
      for (; nameAt > from; nameAt--) {
        if (this.t(nameAt) === '>') depth++;
        else if (this.t(nameAt) === '<' && --depth === 0) break;
      }
      nameAt--;
    }
    const name = this.t(nameAt);
    const ctor = !!owner && (name === owner.name || (this.t(nameAt - 1) === '.' && this.t(nameAt - 2) === owner.name));
    const factory = this.tokens.slice(from, parenAt).some((t) => t.text === 'factory');
    let j = this.skip(parenAt);
    while (j < end && ['async', 'sync', '*'].includes(this.t(j))) j++;
    if (this.t(j) === ':') {
      // Initializer list (or a redirect) up to the body.
      for (; j < end && !['{', '=>', ';'].includes(this.t(j)); j++) if (['(', '['].includes(this.t(j))) j = this.skip(j) - 1;
    }
    if (this.t(j) === '=' && factory) j = this.endOfExpression(j + 1, end);
    return this.addBodied({
      kind: ctor || factory ? 'constructor' : 'function',
      name: ctor && this.t(nameAt - 1) === '.' ? `${owner!.name}.${name}` : name,
      nameAt,
      isStatic,
      from,
      bodyAt: j,
      owner,
      params: this.readParams(parenAt),
    });
  }

  private addBodied(d: {
    kind: Member['kind'];
    name: string;
    nameAt: number;
    isStatic: boolean;
    from: number;
    bodyAt: number;
    owner?: ClassDecl;
    params?: Param[];
  }): number {
    const s = this.t(d.bodyAt);
    let body: Range | undefined;
    let arrow = false;
    let next: number;
    if (s === '{') {
      next = this.skip(d.bodyAt);
      body = { start: d.bodyAt, end: next };
    } else if (s === '=>') {
      const stop = this.endOfExpression(d.bodyAt + 1, this.tokens.length);
      body = { start: d.bodyAt + 1, end: stop };
      arrow = true;
      next = stop + 1;
    } else next = d.bodyAt + 1;
    const member: Member = {
      kind: d.kind,
      name: d.name,
      isStatic: d.isStatic,
      line: this.line(d.nameAt),
      range: { start: d.from, end: next },
      nameAt: d.nameAt,
      ...(d.params ? { params: d.params } : {}),
      ...(body ? { body } : {}),
      ...(arrow ? { arrow } : {}),
      ...(d.owner ? { owner: d.owner } : {}),
    };
    this.addMember(member);
    return next;
  }

  private addMember(member: Member): void {
    this.members.push(member);
    if (member.owner) member.owner.members.push(member);
    else this.topLevel.push(member);
  }

  /** `a = 1, b = 2;`: one field per declarator. */
  private readFields(from: number, end: number, isStatic: boolean, owner?: ClassDecl): number {
    const stop = this.endOfExpression(from, end);
    let i = from;
    while (i < stop) {
      let j = i;
      for (; j < stop && this.t(j) !== ',' && this.t(j) !== '='; j++) {
        if (['(', '[', '{'].includes(this.t(j))) j = this.skip(j) - 1;
        else if (this.t(j) === '<') j = this.skipAngles(j) - 1;
      }
      const nameAt = j - 1;
      let init: Range | undefined;
      if (this.t(j) === '=') {
        let k = j + 1;
        // A typed collection literal: `<String, WidgetBuilder>{…}`.
        if (this.t(k) === '<' || (this.t(k) === 'const' && this.t(k + 1) === '<')) k = this.skipAngles(this.t(k) === '<' ? k : k + 1);
        for (; k < stop && this.t(k) !== ','; k++) if (['(', '[', '{'].includes(this.t(k))) k = this.skip(k) - 1;
        init = { start: j + 1, end: k };
        j = k;
      }
      if (this.tokens[nameAt]?.kind === 'ident') {
        this.addMember({
          kind: 'field',
          name: this.t(nameAt),
          isStatic,
          line: this.line(nameAt),
          range: { start: from, end: stop + 1 },
          nameAt,
          ...(init ? { init } : {}),
          ...(owner ? { owner } : {}),
        });
      }
      i = j + 1;
    }
    return stop + 1;
  }

  /** The `;` ending an expression from `i`, skipping bracket groups. */
  endOfExpression(i: number, end: number): number {
    let j = i;
    for (; j < end && this.t(j) !== ';'; j++) {
      const s = this.t(j);
      if (s === '(' || s === '[' || s === '{') j = this.skip(j) - 1;
      else if (s === '}' || s === ')' || s === ']') return j;
    }
    return j;
  }

  /** Names in a parameter list: positional by index, `{named}`, `[optional]`, `this.field`. */
  readParams(open: number): Param[] {
    const params: Param[] = [];
    const close = this.match[open]!;
    let index = 0;
    const walk = (start: number, stop: number, named: boolean) => {
      let i = start;
      while (i < stop) {
        let j = i;
        let last = -1;
        let field = false;
        for (; j < stop && this.t(j) !== ','; j++) {
          const s = this.t(j);
          if (s === '{' || s === '[') {
            walk(j + 1, this.match[j]!, s === '{');
            j = this.match[j]!;
            last = -1;
            continue;
          }
          if (s === '(') {
            // A function-typed parameter: `void cb(int x)` names `cb`; `void Function(int) cb` names what follows.
            j = this.skip(j) - 1;
            continue;
          }
          if (s === '<') {
            j = this.skipAngles(j) - 1;
            continue;
          }
          if (s === '=') {
            for (j++; j < stop && this.t(j) !== ','; j++) if (['(', '[', '{'].includes(this.t(j))) j = this.skip(j) - 1;
            break;
          }
          if (this.tokens[j]!.kind === 'ident' && !['required', 'covariant', 'final', 'const', 'var', 'this', 'super'].includes(s)) last = j;
          if (s === 'this' || s === 'super') field = true;
        }
        if (last >= 0) params.push({ name: this.t(last), named, index: named ? -1 : index++, field });
        i = j + 1;
      }
    };
    if (close > open) walk(open + 1, close, false);
    return params;
  }
}

/** A Code over an interpolated expression, resolving names in the file it came from. */
export const fragment = (file: DartFile, text: string): Code => {
  const tokens = tokenize(text);
  return { tokens, ...bracketsOf(tokens), file };
};

export type Arg = { name?: string; start: number; end: number };

/** The items between the bracket at `open` and its partner: arguments, list elements or map entries. */
export const splitItems = (code: Code, open: number): Arg[] => {
  const close = code.match[open] ?? -1;
  if (close < open) return [];
  const items: Arg[] = [];
  let start = open + 1;
  for (let i = open + 1; i <= close; i++) {
    const s = code.tokens[i]!.text;
    if (i < close && (s === '(' || s === '[' || s === '{')) {
      i = Math.max(code.match[i]!, i);
      continue;
    }
    if (i === close || (s === ',' && code.tokens[i]!.kind === 'punct')) {
      if (i > start) {
        const named = code.tokens[start]?.kind === 'ident' && code.tokens[start + 1]?.text === ':';
        items.push(named ? { name: code.tokens[start]!.text, start: start + 2, end: i } : { start, end: i });
      }
      start = i + 1;
    }
  }
  return items;
};

/** A map entry's key and value: the first `:` at depth zero that is not a conditional's. */
export const splitEntry = (code: Code, item: Arg): { key: Range; value: Range } | undefined => {
  let pending = 0;
  for (let i = item.start; i < item.end; i++) {
    const s = code.tokens[i]!.text;
    if (s === '(' || s === '[' || s === '{') {
      i = Math.max(code.match[i]!, i);
      continue;
    }
    if (s === '?') pending++;
    else if (s === ':') {
      if (pending > 0) pending--;
      else return { key: { start: item.start, end: i }, value: { start: i + 1, end: item.end } };
    }
  }
  return undefined;
};

/** The call whose argument list opens at `open`: its name, the chain before it and where that chain starts. */
export type Callee = { name: string; nameAt: number; chain: string[]; start: number };

export const calleeOf = (code: Code, open: number): Callee | undefined => {
  let i = open - 1;
  const t = (k: number) => code.tokens[k]?.text ?? '';
  if (t(i) === '>') {
    let depth = 0;
    for (; i >= 0; i--) {
      if (t(i) === '>') depth++;
      else if (t(i) === '>>') depth += 2;
      else if (t(i) === '<' && --depth <= 0) break;
      else if (![',', '?', '.'].includes(t(i)) && code.tokens[i]!.kind !== 'ident') return undefined;
    }
    i--;
  }
  if (code.tokens[i]?.kind !== 'ident') return undefined;
  const nameAt = i;
  const chain: string[] = [t(i)];
  let start = i;
  while (i > 0) {
    const sep = t(i - 1);
    if (sep !== '.' && sep !== '?.' && sep !== '..' && sep !== '?..') break;
    let k = i - 2;
    if (t(k) === '!') k--;
    if (t(k) === ')' || t(k) === ']') {
      const m = code.match[k]!;
      if (m < 0) break;
      chain.unshift(`${t(m - 1)}()`);
      k = m - 1;
    } else chain.unshift(t(k));
    if (code.tokens[k]?.kind !== 'ident') break;
    start = k;
    i = k;
    if (sep === '..' || sep === '?..') break;
  }
  return { name: t(nameAt), nameAt, chain, start };
};

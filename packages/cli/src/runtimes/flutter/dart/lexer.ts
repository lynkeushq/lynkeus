/**
 * Dart source as tokens: enough of the language to read route tables and calls, with strings, interpolation and
 * nested comments right, since those are where a hand-rolled reader usually goes wrong.
 */

export type StringPart = { text: string } | { expr: string };

export type Token = {
  kind: 'ident' | 'string' | 'number' | 'punct';
  text: string;
  line: number;
  /** Strings: literal pieces and interpolated expressions, in order. */
  parts?: StringPart[];
};

// Longest first: `?..` before `?.`, `...` before `..`.
const PUNCT = ['?...', '...', '?..', '??=', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '..', '++', '--', '+=', '-=', '*=', '/=', '::'];

const isIdentStart = (c: string | undefined) => !!c && /[A-Za-z_$]/.test(c);
const isIdent = (c: string | undefined) => !!c && /[\w$]/.test(c);
const isDigit = (c: string | undefined) => !!c && c >= '0' && c <= '9';

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v' };

type Read = { end: number; line: number; parts: StringPart[] };

/** A string starting at the quote at `at`; `raw` strings keep backslashes and dollars as written. */
const readString = (src: string, at: number, raw: boolean, line: number): Read => {
  const quote = src[at]!;
  const triple = src.startsWith(quote.repeat(3), at);
  const close = triple ? quote.repeat(3) : quote;
  const parts: StringPart[] = [];
  let buf = '';
  let i = at + close.length;
  const flush = () => {
    if (buf) parts.push({ text: buf });
    buf = '';
  };
  while (i < src.length) {
    if (src.startsWith(close, i)) {
      flush();
      return { end: i + close.length, line, parts };
    }
    const c = src[i]!;
    if (c === '\n') {
      line++;
      // An unterminated single-line string ends at the line: the rest of the file stays readable.
      if (!triple) {
        flush();
        return { end: i, line: line - 1, parts };
      }
    }
    if (!raw && c === '\\') {
      const next = src[i + 1] ?? '';
      buf += ESCAPES[next] ?? next;
      i += 2;
      continue;
    }
    if (!raw && c === '$' && src[i + 1] === '{') {
      flush();
      let depth = 1;
      let j = i + 2;
      while (j < src.length && depth > 0) {
        const d = src[j]!;
        if (d === '"' || d === "'") {
          const inner = readString(src, j, false, line);
          line = inner.line;
          j = inner.end;
          continue;
        }
        if (d === '\n') line++;
        if (d === '{') depth++;
        else if (d === '}') depth--;
        j++;
      }
      parts.push({ expr: src.slice(i + 2, j - 1) });
      i = j;
      continue;
    }
    if (!raw && c === '$' && /[A-Za-z_]/.test(src[i + 1] ?? '')) {
      flush();
      let j = i + 1;
      while (j < src.length && /\w/.test(src[j]!)) j++;
      parts.push({ expr: src.slice(i + 1, j) });
      i = j;
      continue;
    }
    buf += c;
    i++;
  }
  flush();
  return { end: i, line, parts };
};

export const tokenize = (src: string): Token[] => {
  const out: Token[] = [];
  let i = 0;
  let line = 1;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (c === '\n') {
      line++;
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '﻿') {
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      // Dart block comments nest.
      let depth = 0;
      do {
        if (src.startsWith('/*', i)) {
          depth++;
          i += 2;
        } else if (src.startsWith('*/', i)) {
          depth--;
          i += 2;
        } else {
          if (src[i] === '\n') line++;
          i++;
        }
      } while (depth > 0 && i < n);
      continue;
    }
    const raw = (c === 'r' || c === 'R') && (src[i + 1] === '"' || src[i + 1] === "'");
    const quoteAt = raw ? i + 1 : i;
    if (src[quoteAt] === '"' || src[quoteAt] === "'") {
      const start = line;
      const read = readString(src, quoteAt, raw, line);
      out.push({ kind: 'string', text: src.slice(i, read.end), line: start, parts: read.parts });
      line = read.line;
      i = read.end;
      continue;
    }
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdent(src[j])) j++;
      out.push({ kind: 'ident', text: src.slice(i, j), line });
      i = j;
      continue;
    }
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1]))) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(src[j]!) && !(src[j] === '.' && !isDigit(src[j + 1]))) j++;
      out.push({ kind: 'number', text: src.slice(i, j), line });
      i = j;
      continue;
    }
    const punct = PUNCT.find((p) => src.startsWith(p, i)) ?? c;
    out.push({ kind: 'punct', text: punct, line });
    i += punct.length;
  }
  return out;
};

/** The literal text of a string token with no interpolation, else undefined. */
export const literalOf = (token: Token | undefined): string | undefined => {
  if (token?.kind !== 'string' || !token.parts) return undefined;
  if (token.parts.some((p) => 'expr' in p)) return undefined;
  return token.parts.map((p) => ('text' in p ? p.text : '')).join('');
};

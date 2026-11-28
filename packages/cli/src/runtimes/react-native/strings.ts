import type { StringEntry } from '../api.js';

type Ts = typeof import('ts-morph').ts;

/**
 * A JS/TS file read as string tables: top-level object literals whose leaves are all strings, nested or not, and
 * nothing else that runs (imports, types and exports of those objects are fine). Undefined for any other file, so a
 * module that computes anything is never mistaken for one.
 */
export const readStringTable = async (source: string, file: string): Promise<StringEntry[] | undefined> => {
  // The compiler is loaded only when a changed file might be a table.
  if (!source.includes('{')) return undefined;
  const { ts } = await import('ts-morph');
  const kind = /\.[cm]?tsx$/.test(file) ? ts.ScriptKind.TSX : /\.[cm]?jsx?$/.test(file) ? ts.ScriptKind.JSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, kind);
  const entries: StringEntry[] = [];
  let tables = 0;
  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) continue;
    if (ts.isExportDeclaration(statement)) {
      // `export { en }` names a table; `export * from` re-exports a module, which is code.
      if (statement.moduleSpecifier && !statement.isTypeOnly) return undefined;
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      const value = unwrap(ts, statement.expression);
      if (ts.isIdentifier(value)) continue;
      if (!ts.isObjectLiteralExpression(value) || !flatten(ts, value, 'default', [], entries)) return undefined;
      tables++;
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const d of statement.declarationList.declarations) {
        const value = d.initializer && unwrap(ts, d.initializer);
        if (!value || !ts.isIdentifier(d.name) || !ts.isObjectLiteralExpression(value)) return undefined;
        if (!flatten(ts, value, d.name.text, [], entries)) return undefined;
        tables++;
      }
      continue;
    }
    return undefined;
  }
  return tables && entries.length ? entries : undefined;
};

/** `x as const`, `x satisfies T`, `<T>x` and `(x)` are x. */
const unwrap = (ts: Ts, node: import('ts-morph').ts.Expression): import('ts-morph').ts.Expression => {
  let n = node;
  while (ts.isAsExpression(n) || ts.isSatisfiesExpression(n) || ts.isTypeAssertionExpression(n) || ts.isParenthesizedExpression(n)) n = n.expression;
  return n;
};

const flatten = (ts: Ts, obj: import('ts-morph').ts.ObjectLiteralExpression, table: string, prefix: string[], out: StringEntry[]): boolean => {
  for (const p of obj.properties) {
    // Another table spread in is read where it is written, when it changes.
    if (ts.isSpreadAssignment(p)) continue;
    if (!ts.isPropertyAssignment(p)) return false;
    const name = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) || ts.isNumericLiteral(p.name) ? p.name.text : undefined;
    if (name === undefined) return false;
    const value = unwrap(ts, p.initializer);
    const key = [...prefix, name];
    if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) out.push({ table, key, value: value.text });
    else if (!ts.isObjectLiteralExpression(value) || !flatten(ts, value, table, key, out)) return false;
  }
  return true;
};

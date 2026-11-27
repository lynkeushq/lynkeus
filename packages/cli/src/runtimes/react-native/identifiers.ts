import type { IdentifierChange } from '../api.js';

type Ts = typeof import('ts-morph').ts;
type Node = import('ts-morph').ts.Node;
type Expression = import('ts-morph').ts.Expression;

/** Props that name an element for tests and tools, never for the user. */
const ID_PROPS = new Set(['testID', 'nativeID']);
/** Props that label an element: a case can find it by this text. */
const LABEL_PROPS = new Set(['accessibilityLabel', 'aria-label']);

const MASK = '\u0000lynkeus-identifier\u0000';

/** A literal value as a case could name it: a template's substitutions read `${…}`. */
const literalOf = (ts: Ts, node: Expression | undefined): string | undefined => {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((s) => `\${…}${s.literal.text}`).join('');
  return undefined;
};

type Found = { kind: 'id' | 'label'; value: string };

/**
 * The file printed without comments or formatting, with every literal value of an identifier or label prop put
 * out of the way, and those values in order. Two versions that print the same differ only in those values.
 */
const read = (ts: Ts, source: string, file: string): { printed: string; found: Found[] } => {
  const kind = /\.[cm]?tsx$/.test(file) ? ts.ScriptKind.TSX : /\.[cm]?jsx?$/.test(file) ? ts.ScriptKind.JSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const found: Found[] = [];
  const propKind = (name: string) => (ID_PROPS.has(name) ? 'id' : LABEL_PROPS.has(name) ? 'label' : undefined);
  const visit = (context: import('ts-morph').ts.TransformationContext) => {
    const go = (node: Node): Node => {
      if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name)) {
        const as = propKind(node.name.text);
        const init = node.initializer;
        const value = !init ? undefined : ts.isStringLiteral(init) ? init.text : ts.isJsxExpression(init) ? literalOf(ts, init.expression) : undefined;
        if (as && value !== undefined) {
          found.push({ kind: as, value });
          return context.factory.updateJsxAttribute(node, node.name, context.factory.createStringLiteral(MASK));
        }
      }
      if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) {
        const as = propKind(node.name.text);
        const value = literalOf(ts, node.initializer);
        if (as && value !== undefined) {
          found.push({ kind: as, value });
          return context.factory.updatePropertyAssignment(node, node.name, context.factory.createStringLiteral(MASK));
        }
      }
      return ts.visitEachChild(node, go, context);
    };
    return (root: import('ts-morph').ts.SourceFile) => ts.visitNode(root, go) as import('ts-morph').ts.SourceFile;
  };
  const result = ts.transform(sf, [visit]);
  const printed = ts.createPrinter({ removeComments: true }).printFile(result.transformed[0]!);
  result.dispose();
  return { printed, found };
};

/**
 * When two versions of a JS/TS file differ only in comments, formatting, or the literal values of testID, nativeID,
 * accessibilityLabel and aria-label (as JSX props or object properties): the values that went and came. Undefined
 * when anything else changed, or a version does not parse the same way.
 */
export const readIdentifierChange = async (before: string, after: string, file: string): Promise<IdentifierChange | undefined> => {
  const { ts } = await import('ts-morph');
  const was = read(ts, before, file);
  const now = read(ts, after, file);
  if (was.printed !== now.printed) return undefined;
  // The same print puts the same props in the same places: a value is compared with the one in its place, so two
  // swapped testIDs count as changed.
  const changed = (kind: Found['kind']) =>
    [...new Set(was.found.flatMap((f, i) => (f.kind === kind && f.value !== now.found[i]!.value ? [f.value, now.found[i]!.value] : [])))];
  return { ids: changed('id'), labels: changed('label') };
};

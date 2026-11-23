import type { Element, ElementKind, Frame } from 'lynkeus-protocol';

/** A node of Exact's `tree` reply (preorder; `depth` nests them). Only the fields the mapping reads. */
export type ExactNode = {
  id: number;
  type: string;
  depth: number;
  props?: Record<string, unknown>;
  handlers?: string[];
  inactive?: boolean;
};

/** A box of Exact's `layout` reply, in viewport points. */
export type ExactBox = { id: number; x: number; y: number; w: number; h: number; testId?: string };

const PRESSES = new Set(['press', 'change', 'input', 'submit', 'select', 'dblclick']);

const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

/** What a node says to a reader: its own text, else its descendants' in order, else a control's or field's value. */
const textOf = (nodes: ExactNode[], at: number): string | undefined => {
  const node = nodes[at] as ExactNode;
  const own = node.props?.text;
  if (own != null) return String(own);
  if (node.type === 'Control' && node.props?.checked != null) return String(node.props.checked);
  if (node.type === 'Control' && node.props?.value != null) return String(node.props.value);
  const runs: string[] = [];
  for (let i = at + 1; i < nodes.length && (nodes[i] as ExactNode).depth > node.depth; i++) {
    const text = (nodes[i] as ExactNode).props?.text;
    if (text != null) runs.push(String(text));
  }
  return runs.length ? runs.join('') : str(node.props?.value);
};

const kindOf = (node: ExactNode): ElementKind => {
  const props = node.props ?? {};
  if (node.type === 'TextInput') return 'input';
  if (node.type === 'Control' && props.checked != null) return 'switch';
  if (props.text != null) return 'text';
  if (node.type === 'Image' || props.src != null) return 'image';
  if (node.type === 'Scroll' || props.overflow === 'scroll') return 'scroll';
  if (node.type === 'Control' || node.type === 'Pressable' || (node.handlers ?? []).some((h) => PRESSES.has(h))) return 'button';
  return 'view';
};

/** Exact's ids are the handle the driver acts on; the protocol's `i` is the position in tree order. */
export type Mapped = { elements: Element[]; exactId: number[] };

/**
 * Exact's tree and boxes as protocol elements. Wrappers with no meaning for a reader (a plain view with no text, label or
 * test id) are left out, as the agent leaves out the host views React Native adds.
 */
export const mapElements = (nodes: ExactNode[], boxes: ExactBox[]): Mapped => {
  const box = new Map(boxes.map((b) => [b.id, b]));
  const elements: Element[] = [];
  const exactId: number[] = [];
  const listed = new Map<number, number>();
  const ancestors: { depth: number; i: number }[] = [];
  // A control's own words are its label, not paragraphs beside it: the texts inside one are not listed on their own.
  let controlDepth: number | null = null;
  nodes.forEach((node, at) => {
    const props = node.props ?? {};
    const kind = kindOf(node);
    if (controlDepth !== null && node.depth <= controlDepth) controlDepth = null;
    if (controlDepth !== null && kind === 'text') return;
    if (kind === 'button' || kind === 'input' || kind === 'switch') controlDepth ??= node.depth;
    const testId = str(props.testId);
    const label = str(props.accessibilityLabel);
    const text = kind === 'text' ? String(props.text) : kind === 'view' ? undefined : textOf(nodes, at);
    while (ancestors.length && (ancestors.at(-1) as { depth: number }).depth >= node.depth) ancestors.pop();
    if (kind === 'view' && testId === undefined && label === undefined) return;
    const frame: Frame = box.get(node.id) ?? { x: 0, y: 0, w: 0, h: 0 };
    const element: Element = {
      i: elements.length,
      kind,
      frame: { x: frame.x, y: frame.y, w: frame.w, h: frame.h },
      enabled: props.disabled !== true && props.accessibilityDisabled !== true && !node.inactive,
      depth: ancestors.length,
    };
    if (testId) element.testId = testId;
    if (text !== undefined) element.text = text;
    if (label) element.accessibilityLabel = label;
    if (kind === 'input') {
      const value = str(props.value);
      if (value !== undefined) element.value = props.secure === true || props.secureTextEntry === true ? '•'.repeat(value.length) : value;
      const placeholder = str(props.placeholder);
      if (placeholder) element.placeholder = placeholder;
      if (props.focused === true) element.focused = true;
    }
    if (node.inactive) element.hidden = 'behind-overlay';
    const parent = ancestors.at(-1);
    if (parent) element.parent = parent.i;
    listed.set(node.id, element.i);
    ancestors.push({ depth: node.depth, i: element.i });
    elements.push(element);
    exactId.push(node.id);
  });
  return { elements, exactId };
};

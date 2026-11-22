import type { Element, Target } from 'lynkeus-protocol';

const contains = ({ frame }: Element, x: number, y: number) => x >= frame.x && x <= frame.x + frame.w && y >= frame.y && y <= frame.y + frame.h;
const presented = (e: Element) => e.hidden === undefined;
const isControl = (e: Element) => e.kind === 'button' || e.kind === 'input' || e.kind === 'switch';

const matchesText = (e: Element, text: string, exact: boolean): boolean => {
  const labels = [e.text, e.accessibilityLabel].filter((v): v is string => v !== undefined);
  return labels.some((label) => (exact ? label.trim() === text : label.includes(text)));
};

/**
 * Elements a `{ testId }` or `{ text }` target names, in tree order: a testId exactly; a text by exact label first, then
 * (controls only) by substring. Paragraphs match by exact text alone, as on every host.
 */
const named = (elements: Element[], target: { testId: string } | { text: string }): Element[] => {
  const live = elements.filter(presented);
  if ('testId' in target) return live.filter((e) => e.testId === target.testId);
  const exact = live.filter((e) => matchesText(e, target.text, true));
  return exact.length ? exact : live.filter((e) => isControl(e) && matchesText(e, target.text, false));
};

const ancestorsOf = (elements: Element[], e: Element): Element[] => {
  const chain: Element[] = [];
  for (let at = e.parent; at !== undefined; at = elements[at]?.parent) {
    const parent = elements[at];
    if (!parent) break;
    chain.push(parent);
  }
  return chain;
};

const under = (elements: Element[], e: Element, container: Element): boolean => e === container || ancestorsOf(elements, e).includes(container);

/** The elements a target names; later ones draw on top, so ties go to the last. */
export const resolve = (elements: Element[], target: Target): Element[] => {
  if ('i' in target) {
    const e = elements[target.i];
    return e ? [e] : [];
  }
  if ('x' in target) {
    const hit = elements.filter((e) => presented(e) && contains(e, target.x, target.y));
    const top = hit.at(-1);
    return top ? [top] : [];
  }
  let found = named(elements, target);
  if (target.within) {
    const scopes = named(elements, target.within);
    const scope = scopes.at(-1);
    if (scope) {
      for (const container of [scope, ...ancestorsOf(elements, scope)]) {
        const inside = found.filter((e) => under(elements, e, container));
        if (inside.length) {
          found = inside.sort((a, b) => Math.abs(a.i - scope.i) - Math.abs(b.i - scope.i));
          break;
        }
      }
    }
  }
  return found;
};

export const pick = (elements: Element[], target: Target): Element | undefined => {
  const found = resolve(elements, target);
  const nth = 'nth' in target && target.nth !== undefined ? target.nth : undefined;
  return nth !== undefined ? found[nth] : found.at(-1);
};

export const describe = (target: Target): string => JSON.stringify(target);

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { Dimensions, Platform } from 'react-native';

import { touch } from '../native';
import type { Element } from '../protocol';
import { moveToViews, snapshotElements } from '../tree';

type FakeFiber = {
  tag: number;
  type: unknown;
  stateNode: unknown;
  memoizedProps: unknown;
  child: FakeFiber | null;
  sibling: FakeFiber | null;
  return: FakeFiber | null;
};

const link = (parent: FakeFiber, children: FakeFiber[]) => {
  parent.child = children[0] ?? null;
  children.forEach((c, i) => {
    c.return = parent;
    c.sibling = children[i + 1] ?? null;
  });
  return parent;
};

let nextTag = 1;
const host = (type: string, props: Record<string, unknown>, frame: number[], children: FakeFiber[] = []): FakeFiber =>
  link(
    {
      tag: 5,
      type,
      stateNode: { node: frame, canonical: { nativeTag: nextTag++ } },
      memoizedProps: props,
      child: null,
      sibling: null,
      return: null,
    },
    children,
  );
const text = (value: string): FakeFiber => ({
  tag: 6,
  type: 'RCTRawText',
  stateNode: null,
  memoizedProps: value,
  child: null,
  sibling: null,
  return: null,
});
const composite = (children: FakeFiber[]): FakeFiber =>
  link({ tag: 0, type: () => null, stateNode: null, memoizedProps: {}, child: null, sibling: null, return: null }, children);

const g = globalThis as Record<string, unknown>;

describe('snapshotElements', () => {
  beforeEach(() => {
    nextTag = 1;
    g.nativeFabricUIManager = { getBoundingClientRect: (node: number[]) => node };
    jest.spyOn(Dimensions, 'get').mockReturnValue({ width: 400, height: 800, scale: 2, fontScale: 1 });
  });
  afterEach(() => {
    jest.restoreAllMocks();
    delete g.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    delete g.nativeFabricUIManager;
  });

  const install = (root: FakeFiber) => {
    g.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      renderers: new Map([[1, {}]]),
      getFiberRoots: () => new Set([{ current: { tag: 3, child: root, sibling: null } }]),
      onCommitFiberRoot: () => undefined,
    };
  };

  it('lists controls and text with labels, frames and tags, only on the active screen', () => {
    const screenA = host(
      'RNSScreen',
      { activityState: 0 },
      [0, 0, 400, 800],
      [host('RCTView', { testID: 'old-button', onClick: () => null }, [10, 10, 100, 40])],
    );
    const screenB = host(
      'RNSScreen',
      { activityState: 2 },
      [0, 0, 400, 800],
      [
        host('RCTView', { testID: 'go', onClick: () => null }, [10, 10, 100, 40], [host('RCTText', {}, [12, 12, 90, 20], [text('Go '), text('now')])]),
        host('RCTSinglelineTextInputView', { testID: 'secret', text: '1234', secureTextEntry: true }, [10, 60, 100, 40]),
        host('RCTText', {}, [10, 120, 200, 20], [text('Welcome')]),
        host('RCTView', {}, [0, 0, 0, 0]),
      ],
    );
    install(composite([host('RNSScreenStack', {}, [0, 0, 400, 800], [composite([screenA]), composite([screenB])])]));

    const { elements } = snapshotElements();
    expect(elements.map((e) => [e.kind, e.testId ?? e.text])).toEqual([
      ['button', 'go'],
      ['input', 'secret'],
      ['text', 'Welcome'],
    ]);
    const [button, input] = elements;
    expect(button?.text).toBe('Go now');
    expect(button?.frame).toEqual({ x: 10, y: 10, w: 100, h: 40 });
    expect(typeof button?.tag).toBe('number');
    expect(input?.value).toBe('••••');
  });

  it('gives a button holding several texts their frames, without listing them as elements', () => {
    install(
      composite([
        host(
          'RCTView',
          { testID: 'card', onClick: () => null },
          [10, 10, 300, 100],
          [host('RCTText', {}, [20, 20, 100, 20], [text('Get card')]), host('RCTText', {}, [200, 20, 90, 20], [text('$was1234')])],
        ),
        host('RCTView', { testID: 'one', onClick: () => null }, [10, 200, 100, 40], [host('RCTText', {}, [12, 210, 90, 20], [text('Go')])]),
      ]),
    );
    const { elements } = snapshotElements();
    expect(elements.map((e) => e.testId)).toEqual(['card', 'one']);
    expect(elements[0]?.text).toBe('Get card$was1234');
    expect(elements[0]?.texts).toEqual([
      { text: 'Get card', frame: { x: 20, y: 20, w: 100, h: 20 } },
      { text: '$was1234', frame: { x: 200, y: 20, w: 90, h: 20 } },
    ]);
    expect(elements[1]?.texts).toBeUndefined();
  });

  it('keeps header text above the native window for assertions, but not text below it', () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    install(composite([host('RCTText', {}, [20, -40, 100, 20], [text('RECEPTOR')]), host('RCTText', {}, [20, 850, 100, 20], [text('below')])]));
    jest.spyOn(touch, 'frames').mockImplementation((tags) => tags.map((tag) => (tag === 1 ? [20, -40, 100, 20] : [20, 850, 100, 20])));
    const { elements } = snapshotElements();
    expect(elements.map((e) => [e.text, e.offscreen])).toEqual([['RECEPTOR', true]]);
  });

  it('lists text the shadow tree still puts on the next page when its view is already in the window (Android)', () => {
    jest.replaceProperty(Platform, 'OS', 'android');
    install(composite([host('RCTText', {}, [420, 100, 100, 20], [text('Go Long')]), host('RCTText', {}, [420, 140, 100, 20], [text('stays off')])]));
    jest.spyOn(touch, 'frames').mockImplementation((tags) => tags.map((tag) => (tag === 1 ? [20, 100, 100, 20] : [420, 140, 100, 20])));
    const { elements } = snapshotElements();
    expect(elements.map((e) => [e.text, e.frame.x])).toEqual([['Go Long', 20]]);
  });

  it('drops text outside the window by its shadow frame where there is no native view to ask (iOS)', () => {
    jest.replaceProperty(Platform, 'OS', 'ios');
    install(composite([host('RCTText', {}, [420, 100, 100, 20], [text('next page')])]));
    expect(snapshotElements().elements).toEqual([]);
  });

  it('keeps a snapshot when a native view disappears during the read', () => {
    install(composite([host('RCTSinglelineTextInputView', { testID: 'phone' }, [10, 10, 100, 40])]));
    const failure = () => {
      throw new Error('getChildAt(...) must not be null');
    };
    jest.spyOn(touch, 'frames').mockImplementation(failure);
    jest.spyOn(touch, 'texts').mockImplementation(failure);
    jest.spyOn(touch, 'hitTest').mockImplementation(failure);

    expect(() => snapshotElements()).not.toThrow();
  });

  it('reads what a field holds from its view, where React only knows what it was given', () => {
    install(
      composite([
        host('RCTSinglelineTextInputView', { testID: 'free' }, [10, 10, 100, 40]),
        host('RCTSinglelineTextInputView', { testID: 'edited', text: 'first' }, [10, 60, 100, 40]),
        host('RCTSinglelineTextInputView', { testID: 'pin', secureTextEntry: true }, [10, 110, 100, 40]),
        host('RCTSinglelineTextInputView', { testID: 'cleared', text: 'gone' }, [10, 160, 100, 40]),
      ]),
    );
    const asked = jest.spyOn(touch, 'texts').mockReturnValue(['ana', 'second', '1234', '']);
    const { elements } = snapshotElements();
    expect(asked).toHaveBeenCalledWith(elements.map((e) => e.tag));
    expect(elements.map((e) => [e.testId, e.value])).toEqual([
      ['free', 'ana'],
      ['edited', 'second'],
      ['pin', '••••'],
      ['cleared', undefined],
    ]);
  });

  const fill = { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 };
  const byTestId = (elements: ReturnType<typeof snapshotElements>['elements']) => Object.fromEntries(elements.map((e) => [e.testId ?? `#${e.i}`, e]));

  it('hides what a root layer with controls is covering', () => {
    const page = host('RCTView', {}, [0, 0, 400, 800], [host('RCTView', { testID: 'behind', onClick: () => null }, [10, 10, 100, 40])]);
    const sheet = host('RCTView', { style: fill }, [0, 0, 400, 800], [host('RCTView', { testID: 'key-1', onClick: () => null }, [10, 500, 60, 60])]);
    const toastHost = host('RCTView', { style: [fill] }, [0, 0, 400, 800]);
    install(composite([page, sheet, toastHost]));

    const { elements, presenting } = snapshotElements();
    const byId = byTestId(elements);
    expect(byId.behind?.hidden).toBe('behind-overlay');
    expect(byId['key-1']?.hidden).toBeUndefined();
    expect(presenting?.modal).toBe(false);
  });

  it('takes a full-size layer that states no insets for a layer', () => {
    const sized = { position: 'absolute', width: '100%', height: '100%' };
    const page = host('RCTView', {}, [0, 0, 400, 800], [host('RCTView', { testID: 'underneath', onClick: () => null }, [10, 10, 100, 40])]);
    const lock = host('RCTView', { style: sized }, [0, 0, 400, 800], [host('RCTView', { testID: 'numpad-1', onClick: () => null }, [10, 500, 60, 60])]);
    install(composite([page, lock]));

    const { elements, presenting } = snapshotElements();
    const byId = byTestId(elements);
    expect(byId.underneath?.hidden).toBe('behind-overlay');
    expect(byId['numpad-1']?.hidden).toBeUndefined();
    expect(presenting).toBeDefined();
  });

  it('does not take an overlay inside a control or a scroll view for a layer', () => {
    const page = host(
      'RCTView',
      {},
      [0, 0, 400, 800],
      [
        host('RCTView', { testID: 'still-here', onClick: () => null }, [10, 10, 100, 40]),
        host(
          'RCTScrollView',
          {},
          [0, 100, 400, 700],
          [
            host(
              'RCTView',
              { testID: 'card', onClick: () => null },
              [0, 100, 400, 200],
              [host('RCTView', { style: fill }, [0, 100, 400, 200], [host('RCTView', { testID: 'card-cta', onClick: () => null }, [10, 110, 80, 30])])],
            ),
          ],
        ),
      ],
    );
    install(composite([page]));

    const { elements, presenting } = snapshotElements();
    expect(presenting).toBeUndefined();
    expect(byTestId(elements)['still-here']?.hidden).toBeUndefined();
  });

  it('a modal beats an overlay, however late the overlay renders', () => {
    const modal = host(
      'RCTView',
      { accessibilityViewIsModal: true },
      [0, 0, 400, 800],
      [host('RCTView', { testID: 'confirm', onClick: () => null }, [10, 400, 100, 40])],
    );
    const banner = host('RCTView', { style: fill }, [0, 0, 400, 800], [host('RCTView', { testID: 'banner-cta', onClick: () => null }, [10, 10, 100, 40])]);
    install(composite([modal, banner]));

    const { elements, presenting } = snapshotElements();
    expect(presenting?.modal).toBe(true);
    expect(byTestId(elements)['banner-cta']?.hidden).toBe('behind-modal');
  });

  it('skips a subtree the platform is not rendering, and marks the ones it hides', () => {
    const pages = host(
      'RCTView',
      {},
      [0, 0, 400, 800],
      [
        host(
          'RCTView',
          { testID: 'page-1', style: { display: 'none' } },
          [0, 0, 400, 800],
          [host('RCTView', { testID: 'off-tab', onClick: () => null }, [10, 10, 100, 40])],
        ),
        host(
          'RCTView',
          { testID: 'page-2', 'aria-hidden': true },
          [0, 0, 400, 800],
          [host('RCTView', { testID: 'other-tab', onClick: () => null }, [10, 60, 100, 40])],
        ),
        host('RCTView', { testID: 'page-3', pointerEvents: 'none' }, [0, 0, 400, 800], [host('RCTText', {}, [10, 120, 200, 20], [text('readable')])]),
        host('RCTView', { testID: 'page-4' }, [0, 0, 400, 800], [host('RCTView', { testID: 'on-tab', onClick: () => null }, [10, 160, 100, 40])]),
      ],
    );
    install(composite([pages]));

    const { elements } = snapshotElements();
    const byId = byTestId(elements);
    expect(byId['off-tab']).toBeUndefined();
    expect(byId['other-tab']?.hidden).toBe('a11y');
    expect(byId['page-3']?.hidden).toBe('inert');
    expect(byId['on-tab']?.hidden).toBeUndefined();
  });
});

describe('moveToViews', () => {
  const element = (i: number, y: number, extra: Partial<Element> = {}): Element => ({
    i,
    kind: 'view',
    frame: { x: 10, y, w: 100, h: 40 },
    enabled: true,
    depth: 0,
    ...extra,
  });

  it('puts an element where its view stands', () => {
    const elements = [element(0, 96, { tag: 7 })];
    moveToViews(elements, () => [12, 150, 100, 44]);
    expect(elements[0]?.frame).toEqual({ x: 12, y: 150, w: 100, h: 44 });
  });

  it('moves an element with no view by what its ancestor moved', () => {
    const elements = [element(0, 96, { tag: 7 }), element(1, 110, { parent: 0 }), element(2, 300)];
    moveToViews(elements, (tag) => (tag === 7 ? [10, 150, 100, 40] : null));
    expect(elements[1]?.frame.y).toBe(164);
    expect(elements[2]?.frame.y).toBe(300);
  });
});

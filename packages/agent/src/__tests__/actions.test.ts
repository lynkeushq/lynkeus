import { describe, expect, it, jest } from '@jest/globals';

import type { Backend } from '../backend';
import { createHandlers, dispatch } from '../handlers';
import { noNavigation } from '../navigation';
import type { Element } from '../protocol';

const element = (over: Partial<Element>): Element => ({
  i: 0,
  kind: 'button',
  frame: { x: 0, y: 0, w: 100, h: 40 },
  enabled: true,
  depth: 0,
  ...over,
});

const fakeBackend = (elements: Element[]) => {
  const swipeOn = jest.fn(async () => undefined);
  const swipe = jest.fn(async () => undefined);
  const backend: Backend = {
    name: 'fake',
    native: false,
    snapshot: () => ({ elements }),
    commitCount: () => 0,
    window: () => ({ w: 390, h: 844 }),
    press: async () => undefined,
    pressPoint: async () => undefined,
    pressJs: async () => undefined,
    typeText: async () => undefined,
    deleteBackward: async () => undefined,
    dismissKeyboard: async () => undefined,
    submit: async () => undefined,
    swipe,
    swipeOn,
    debug: () => null,
  };
  return { backend, swipeOn, swipe };
};

describe('acting on what the platform does not present', () => {
  const slider = element({ testId: 'slide-to-confirm', hidden: 'inert' });

  it('finds an inert element but refuses to swipe it', async () => {
    const { backend, swipeOn, swipe } = fakeBackend([slider]);
    const handlers = createHandlers(noNavigation, backend);

    const found = (await dispatch(handlers, 'find', { testId: 'slide-to-confirm' })) as Element | null;
    expect(found?.testId).toBe('slide-to-confirm');

    await expect(dispatch(handlers, 'swipe', { target: { testId: 'slide-to-confirm' }, direction: 'right' })).rejects.toThrow(/not presented \(inert\)/);
    expect(swipeOn).not.toHaveBeenCalled();
    expect(swipe).not.toHaveBeenCalled();
  });

  it('waits for an element that is still becoming interactive', async () => {
    const live = { ...slider };
    const { backend, swipeOn } = fakeBackend([live]);
    const handlers = createHandlers(noNavigation, backend);
    setTimeout(() => {
      live.hidden = undefined;
    }, 200);
    await dispatch(handlers, 'swipe', { target: { testId: 'slide-to-confirm' }, direction: 'right' });
    expect(swipeOn).toHaveBeenCalledTimes(1);
  });

  it('waits out an element that flickers inert while it lands', async () => {
    const live = { ...slider, hidden: undefined as Element['hidden'] };
    const { backend, swipeOn } = fakeBackend([live]);
    const handlers = createHandlers(noNavigation, backend);
    setTimeout(() => {
      live.hidden = 'inert';
    }, 20);
    setTimeout(() => {
      live.hidden = undefined;
    }, 300);
    await dispatch(handlers, 'swipe', { target: { testId: 'slide-to-confirm' }, direction: 'right' });
    expect(swipeOn).toHaveBeenCalledTimes(1);
  });

  it('swipes the same element once it is presented', async () => {
    const { backend, swipeOn } = fakeBackend([{ ...slider, hidden: undefined }]);
    const handlers = createHandlers(noNavigation, backend);

    await dispatch(handlers, 'swipe', { target: { testId: 'slide-to-confirm' }, direction: 'right' });
    expect(swipeOn).toHaveBeenCalledTimes(1);
  });
});

describe('navigating right after a launch', () => {
  it('waits for the app to mount its navigation container', async () => {
    let ready = false;
    const navigate = jest.fn();
    const handlers = createHandlers({ ...noNavigation, isReady: () => ready, navigate }, fakeBackend([]).backend);
    setTimeout(() => {
      ready = true;
    }, 120);

    await dispatch(handlers, 'navigate', { name: 'Auth.FindAccount' });
    expect(ready).toBe(true);
    expect(navigate).toHaveBeenCalledWith('Auth.FindAccount', undefined);
  });
});

describe('waiting for an enabled control', () => {
  it('does not return while the target is present but disabled', async () => {
    const target = element({ testId: 'next', enabled: false });
    const { backend } = fakeBackend([target]);
    let enabled = false;
    backend.snapshot = () => ({ elements: [{ ...target, enabled }] });
    setTimeout(() => {
      enabled = true;
    }, 120);
    const handlers = createHandlers(noNavigation, backend);

    await dispatch(handlers, 'waitFor', { target: { testId: 'next' }, enabled: true, timeoutMs: 500 });
    expect(enabled).toBe(true);
  });
});

it('a targeted swipe starts after the target stops moving', async () => {
  const started = Date.now();
  const fieldY = () => Math.max(200, 600 - ((Date.now() - started) / 300) * 400);
  const { backend } = fakeBackend([]);
  let from: { x: number; y: number } | undefined;
  const handlers = createHandlers(noNavigation, {
    ...backend,
    snapshot: () => ({ elements: [element({ kind: 'button', testId: 'row', frame: { x: 0, y: fieldY(), w: 300, h: 40 } })] }),
    swipeOn: undefined,
    swipe: async (start) => {
      from = start;
    },
  });

  await dispatch(handlers, 'swipe', { target: { testId: 'row' }, direction: 'left', distance: 100 });
  expect(from).toEqual({ x: 292, y: 220 });
});

describe('typing into a field the keyboard moves', () => {
  it('types once the field has landed', async () => {
    let pressedAt: number | undefined;
    // The field slides from 600 to 200 over the 300 ms after the tap, as a screen collapsing for the keyboard.
    const fieldY = () => (pressedAt === undefined ? 600 : Math.max(200, 600 - ((Date.now() - pressedAt) / 300) * 400));
    const typedAt: number[] = [];
    const { backend } = fakeBackend([]);
    const handlers = createHandlers(noNavigation, {
      ...backend,
      snapshot: () => ({ elements: [element({ kind: 'input', testId: 'search', frame: { x: 0, y: fieldY(), w: 300, h: 40 } })] }),
      press: async () => {
        pressedAt = Date.now();
      },
      typeText: async () => {
        typedAt.push(fieldY());
      },
    });

    await dispatch(handlers, 'type', { target: { testId: 'search' }, text: 'ab' });
    expect(typedAt).toEqual([200, 200]);
  });
});

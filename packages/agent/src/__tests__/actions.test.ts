import { describe, expect, it, jest } from '@jest/globals';
import { Linking } from 'react-native';

import type { Backend } from '../backend';
import { createHandlers, dispatch } from '../handlers';
import { noNavigation } from '../navigation';
import { trackOpenedUrls } from '../opened';
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

  it('swipes an element whose reads disagree while a native host updates its tree', async () => {
    // Every read of the tree comes back different for a while: inert, presented, inert, ...
    let reads = 0;
    const { backend, swipeOn } = fakeBackend([]);
    backend.snapshot = () => {
      reads += 1;
      return { elements: [{ ...slider, hidden: reads < 12 && reads % 2 === 1 ? 'inert' : undefined }] };
    };
    const handlers = createHandlers(noNavigation, backend);

    await dispatch(handlers, 'swipe', { target: { testId: 'slide-to-confirm' }, direction: 'right' });
    expect(swipeOn).toHaveBeenCalledTimes(1);
  });

  it('waits for a landing target on a virtual clock that jumps ahead while it sleeps', async () => {
    // fastsim's Date.now runs on the host's virtual clock: each look finds a second gone, while the native tree is still
    // the same few reads away from presenting the control.
    let reads = 0;
    const { backend, swipeOn } = fakeBackend([]);
    backend.snapshot = () => {
      reads += 1;
      return { elements: [{ ...slider, hidden: reads < 16 ? 'inert' : undefined }] };
    };
    const realNow = Date.now;
    let virtual = realNow();
    Date.now = () => (virtual += 1000);
    try {
      const handlers = createHandlers(noNavigation, backend);
      await dispatch(handlers, 'swipe', { target: { testId: 'slide-to-confirm' }, direction: 'right' });
    } finally {
      Date.now = realNow;
    }
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
  it('does not return while the target is enabled but inert (a pager whose last page has not landed)', async () => {
    const target = element({ testId: 'slide-to-confirm' });
    const { backend } = fakeBackend([target]);
    let inert = true;
    backend.snapshot = () => ({ elements: [{ ...target, ...(inert ? { hidden: 'inert' as const } : {}) }] });
    setTimeout(() => {
      inert = false;
    }, 120);
    const handlers = createHandlers(noNavigation, backend);

    await dispatch(handlers, 'waitFor', { target: { testId: 'slide-to-confirm' }, enabled: true, timeoutMs: 500 });
    expect(inert).toBe(false);
  });

  it('without enabled, an inert target still counts as there', async () => {
    const { backend } = fakeBackend([element({ testId: 'slide-to-confirm', hidden: 'inert' })]);
    const handlers = createHandlers(noNavigation, backend);
    await expect(dispatch(handlers, 'waitFor', { target: { testId: 'slide-to-confirm' }, timeoutMs: 100 })).resolves.toBeDefined();
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
  it('types once the field has landed, on a device', async () => {
    let pressedAt: number | undefined;
    // The field slides from 600 to 200 over the 300 ms after the tap, as a screen collapsing for the keyboard.
    const fieldY = () => (pressedAt === undefined ? 600 : Math.max(200, 600 - ((Date.now() - pressedAt) / 300) * 400));
    const typedAt: number[] = [];
    const { backend } = fakeBackend([]);
    const handlers = createHandlers(noNavigation, {
      ...backend,
      native: true,
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

  it('on a host, which has no keyboard, types at once and does not wait for one to slide away', async () => {
    const typed: string[] = [];
    let blurred = 0;
    const { backend } = fakeBackend([]);
    const field = element({ kind: 'input', testId: 'email' });
    const go = element({ i: 1, testId: 'go', frame: { x: 0, y: 100, w: 100, h: 40 } });
    let focused = false;
    const handlers = createHandlers(noNavigation, {
      ...backend,
      snapshot: () => ({ elements: [{ ...field, focused }, go] }),
      press: async (e) => {
        focused = e.kind === 'input';
      },
      typeText: async (chunk) => {
        typed.push(chunk);
      },
      dismissKeyboard: async () => {
        blurred++;
        focused = false;
      },
    });
    const started = Date.now();
    await dispatch(handlers, 'type', { target: { testId: 'email' }, text: 'ignite@infinite.red' });
    await dispatch(handlers, 'press', { testId: 'go' });
    expect(typed.join('')).toBe('ignite@infinite.red');
    expect(blurred).toBe(1);
    // A device spends 25 ms a key, 80 ms for the keyboard to attach and 300 ms for it to slide away: 855 ms here.
    expect(Date.now() - started).toBeLessThan(250);
  });
});

describe('a view the app did not draw in front of it', () => {
  const withSystem = (elements: Element[], frame = { x: 0, y: 0, w: 390, h: 844 }) => {
    const { backend } = fakeBackend(elements);
    const press = jest.fn(async (_: Element) => undefined);
    return { backend: { ...backend, snapshot: () => ({ elements, system: { frame } }), press }, press };
  };

  it('refuses a press under a prompt another process draws, and says how to get past it', async () => {
    const { backend, press } = withSystem([element({ testId: 'login', covered: true })]);
    const handlers = createHandlers(noNavigation, backend);
    await expect(dispatch(handlers, 'press', { testId: 'login' })).rejects.toThrow(/under a view the app did not draw.*relaunch the app/);
    expect(press).not.toHaveBeenCalled();
  });

  it('names the buttons of an alert it can read', async () => {
    const { backend } = withSystem([
      element({ testId: 'delete', covered: true }),
      element({ i: 1, text: 'Cancel', system: true, frame: { x: 100, y: 477, w: 54, h: 20 } }),
    ]);
    const handlers = createHandlers(noNavigation, backend);
    await expect(dispatch(handlers, 'press', { testId: 'delete' })).rejects.toThrow(/press one of its buttons first \("Cancel"\)/);
  });

  it("presses an alert's button by its text", async () => {
    const cancel = element({ i: 1, text: 'Cancel', system: true, frame: { x: 100, y: 477, w: 54, h: 20 } });
    const { backend, press } = withSystem([element({ testId: 'delete', covered: true }), cancel]);
    const handlers = createHandlers(noNavigation, backend);
    await dispatch(handlers, 'press', { text: 'Cancel' });
    expect(press).toHaveBeenCalledWith(cancel, 50);
  });

  it('lets a press through outside what the view covers', async () => {
    const { backend, press } = withSystem([element({ testId: 'tab', covered: true, frame: { x: 0, y: 800, w: 100, h: 40 } })], { x: 0, y: 0, w: 390, h: 100 });
    const handlers = createHandlers(noNavigation, backend);
    await dispatch(handlers, 'press', { testId: 'tab' });
    expect(press).toHaveBeenCalledTimes(1);
  });
});

describe('a press that opens a URL', () => {
  it('says which, so the driver knows the browser or another app is coming to the front', async () => {
    // The app's own Linking, as the agent finds it when it starts.
    jest.spyOn(Linking, 'openURL').mockImplementation(async () => undefined);
    trackOpenedUrls();
    const card = element({ testId: 'card' });
    const { backend } = fakeBackend([card]);
    const handlers = createHandlers(noNavigation, {
      ...backend,
      press: async () => {
        await Linking.openURL('https://github.com/infinitered/ignite');
      },
    });
    expect(await dispatch(handlers, 'press', { testId: 'card' })).toMatchObject({ opened: 'https://github.com/infinitered/ignite' });
    const { backend: still } = fakeBackend([card]);
    expect(await dispatch(createHandlers(noNavigation, still), 'press', { testId: 'card' })).not.toHaveProperty('opened');
  });
});

describe('a target a wait found is one a press finds', () => {
  it('a scroll wait returns only once the list stops coasting, where a press will look', async () => {
    // After the wait's swipe the list coasts for 300 ms: the row passes through the window and leaves it, then the
    // list settles with it back in view.
    let swipedAt: number | undefined;
    const rowY = () => {
      if (swipedAt === undefined) return 1200;
      const t = Date.now() - swipedAt;
      return t < 100 ? 1200 - t * 8 : t < 300 ? 400 - (t - 100) * 3 : 500;
    };
    const { backend } = fakeBackend([]);
    const handlers = createHandlers(noNavigation, {
      ...backend,
      native: true,
      snapshot: () => ({
        elements: [
          element({ kind: 'scroll', frame: { x: 0, y: 0, w: 390, h: 844 } }),
          element({ i: 1, text: 'Button', frame: { x: 0, y: rowY(), w: 300, h: 40 } }),
        ],
      }),
      swipe: async () => {
        swipedAt = Date.now();
      },
    });
    await dispatch(handlers, 'waitFor', { target: { text: 'Button' }, scroll: true, timeoutMs: 3000 });
    expect(Date.now() - swipedAt!).toBeGreaterThanOrEqual(300);
    expect(rowY()).toBe(500);
  });

  it('a press whose target slides away while it settles brings it back once and presses it', async () => {
    let gone = false;
    let scrolledBack = 0;
    const presses: string[] = [];
    const { backend } = fakeBackend([]);
    let looks = 0;
    const handlers = createHandlers(noNavigation, {
      ...backend,
      native: true,
      snapshot: () => {
        looks++;
        // Moving on the first looks, then recycled away; back once the wait scrolls to it.
        if (!gone && looks > 3) gone = true;
        const row = element({ i: 1, text: 'Button', frame: { x: 0, y: 300 + looks, w: 300, h: 40 } });
        return {
          elements: [
            element({ kind: 'scroll', frame: { x: 0, y: 0, w: 390, h: 844 } }),
            ...(gone ? [] : [{ ...row, frame: { ...row.frame, y: scrolledBack ? 300 : row.frame.y } }]),
          ],
        };
      },
      swipe: async () => {
        scrolledBack++;
        gone = false;
        looks = -1_000_000;
      },
      press: async (e) => {
        presses.push(e.text ?? '');
      },
    });
    await dispatch(handlers, 'press', { text: 'Button' });
    expect(scrolledBack).toBe(1);
    expect(presses).toEqual(['Button']);
  });

  it('says the target left while the press waited, when it does not come back', async () => {
    let looks = 0;
    const { backend } = fakeBackend([]);
    const handlers = createHandlers(noNavigation, {
      ...backend,
      snapshot: () => {
        looks++;
        return { elements: looks < 3 ? [element({ text: 'Button', frame: { x: 0, y: 300 + looks * 10, w: 300, h: 40 } })] : [] };
      },
    });
    await expect(dispatch(handlers, 'press', { text: 'Button' })).rejects.toThrow(
      /^No element matches \{"text":"Button"\}: it was on screen \d+ ms before, and left while the press waited for it to hold still/,
    );
  });

  it('names what is in the tree but not presented, rather than calling it absent', async () => {
    const { backend } = fakeBackend([element({ text: 'Close drawer', hidden: 'a11y' })]);
    const handlers = createHandlers(noNavigation, backend);
    await expect(dispatch(handlers, 'press', { text: 'Close drawer' })).rejects.toThrow(
      'No element matches {"text":"Close drawer"}: one is in the tree but not presented (a11y)',
    );
  });
});

describe('a scroll wait for a target under a bar', () => {
  it('does not count a covered target as found: it scrolls it out from under in a short move, not past the window', async () => {
    // The tab bar covers y 760..844; the row is under it until the list moves it up.
    let offset = 0;
    const swipes: { from: { y: number }; to: { y: number } }[] = [];
    const { backend } = fakeBackend([]);
    const handlers = createHandlers(noNavigation, {
      ...backend,
      native: true,
      snapshot: () => {
        const y = 780 - offset;
        return {
          elements: [
            element({ kind: 'scroll', frame: { x: 0, y: 0, w: 390, h: 760 } }),
            element({ i: 1, text: 'Button', frame: { x: 0, y, w: 300, h: 40 }, covered: y + 20 > 760 }),
          ],
        };
      },
      swipe: async (from: { x: number; y: number }, to: { x: number; y: number }) => {
        swipes.push({ from, to });
        offset += from.y - to.y;
      },
    });
    const answer = (await dispatch(handlers, 'waitFor', { target: { text: 'Button' }, scroll: true, timeoutMs: 3000 })) as { waitedMs: number };
    expect(swipes.length).toBe(1);
    // Moved up, by little more than its own height: still well inside the window.
    expect(swipes[0]!.from.y).toBeGreaterThan(swipes[0]!.to.y);
    expect(offset).toBeLessThan(200);
    expect(780 - offset).toBeGreaterThan(0);
    expect(answer.waitedMs).toBeGreaterThan(0);
  });
});

describe('back, as a person goes back', () => {
  const navigation = (drawerOpen: boolean) => {
    const goBack = jest.fn();
    const closeDrawer = jest.fn(() => drawerOpen);
    return { adapter: { ...noNavigation, canGoBack: () => true, goBack, closeDrawer, currentRoute: () => ({ name: 'DemoShowroom' }) }, goBack, closeDrawer };
  };

  it('closes an open drawer navigator first and leaves the route alone', async () => {
    const { backend } = fakeBackend([]);
    const nav = navigation(true);
    expect(await dispatch(createHandlers(nav.adapter, backend), 'back', undefined)).toEqual({ route: 'DemoShowroom', closed: 'drawer' });
    expect(nav.goBack).not.toHaveBeenCalled();
  });

  it('presses a drawer’s own close overlay when no navigator holds the drawer, then pops only once it is gone', async () => {
    let open = true;
    const overlay = () => (open ? [element({ i: 3, kind: 'button', accessibilityLabel: 'Close drawer' })] : []);
    const { backend } = fakeBackend([]);
    const nav = navigation(false);
    const handlers = createHandlers(nav.adapter, {
      ...backend,
      snapshot: () => ({ elements: overlay() }),
      press: async () => {
        open = false;
      },
    });
    expect(await dispatch(handlers, 'back', undefined)).toEqual({ route: 'DemoShowroom', closed: 'Close drawer' });
    expect(nav.goBack).not.toHaveBeenCalled();
    expect(await dispatch(handlers, 'back', undefined)).toEqual({ route: 'DemoShowroom' });
    expect(nav.goBack).toHaveBeenCalledTimes(1);
  });
});

describe('back with a drawer no navigator holds', () => {
  it('closes it through the backend before it pops the route', async () => {
    const { backend } = fakeBackend([]);
    const goBack = jest.fn();
    let open = true;
    const handlers = createHandlers(
      { ...noNavigation, canGoBack: () => true, goBack, currentRoute: () => ({ name: 'DemoShowroom' }) },
      {
        ...backend,
        closeDrawer: () => {
          const was = open;
          open = false;
          return was;
        },
      },
    );
    expect(await dispatch(handlers, 'back', undefined)).toEqual({ route: 'DemoShowroom', closed: 'drawer' });
    expect(goBack).not.toHaveBeenCalled();
    await dispatch(handlers, 'back', undefined);
    expect(goBack).toHaveBeenCalledTimes(1);
  });

  it('tells an open react-native-drawer-layout Drawer by its own props', async () => {
    const { isOpenDrawer } = await import('../presentation');
    const drawer = { open: true, onClose: () => undefined, renderDrawerContent: () => null };
    expect(isOpenDrawer(drawer)).toBe(true);
    expect(isOpenDrawer({ ...drawer, open: false })).toBe(false);
    expect(isOpenDrawer({ ...drawer, drawerType: 'permanent' })).toBe(false);
    // A modal or snackbar with open and onClose is not a drawer.
    expect(isOpenDrawer({ open: true, onClose: () => undefined })).toBe(false);
  });
});

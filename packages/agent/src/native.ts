import NativeLynkeus, { type Spec } from './NativeLynkeus';

// Compiled in or out per build, so it cannot change while the process runs.
let availability: boolean | undefined;
const available = (): boolean => (availability ??= NativeLynkeus?.isAvailable() === true);

const ready = (): Spec => {
  if (!NativeLynkeus || !available()) {
    throw new Error('Lynkeus native module unavailable: debug builds only, and the app must be rebuilt after adding the package');
  }
  return NativeLynkeus;
};

export type SystemViews = {
  frame: number[];
  items: { text: string; kind: 'button' | 'text'; frame: number[] }[];
};

export const touch = {
  available,
  tap: (x: number, y: number, holdMs: number) => ready().tap(x, y, holdMs),
  swipe: (x1: number, y1: number, x2: number, y2: number, durationMs: number) => ready().swipe(x1, y1, x2, y2, durationMs),
  typeText: (text: string) => ready().typeText(text),
  deleteBackward: (count: number) => ready().deleteBackward(count),
  dismissKeyboard: () => ready().dismissKeyboard(),
  submitEditing: () => ready().submitEditing(),
  /** Where each tag's native view stands in the window, null for a tag without one; null when the native side does not say. */
  frames: (tags: number[]): (number[] | null)[] | null => {
    // A build made before the native side learned this has no such method.
    if (!available() || tags.length === 0 || typeof ready().frames !== 'function') return null;
    try {
      const frames = JSON.parse(ready().frames(tags)) as (number[] | null)[];
      return frames.length === tags.length ? frames : null;
    } catch {
      return null;
    }
  },
  /** What each tag's native field holds, null for a tag that is not one; null when the native side does not say. */
  texts: (tags: number[]): (string | null)[] | null => {
    // A build made before the native side learned this has no such method.
    if (!available() || tags.length === 0 || typeof ready().texts !== 'function') return null;
    try {
      const texts = JSON.parse(ready().texts(tags)) as (string | null)[];
      return texts.length === tags.length ? texts : null;
    } catch {
      return null;
    }
  },
  /** What windows the app's React tree did not draw show in front of it; null when nothing is, or the native side does not say. */
  systemViews: (): SystemViews | null => {
    // A build made before the native side learned this has no such method.
    if (!available() || typeof ready().systemViews !== 'function') return null;
    try {
      const found = JSON.parse(ready().systemViews()) as SystemViews | null;
      return found && Array.isArray(found.frame) && Array.isArray(found.items) ? found : null;
    } catch {
      return null;
    }
  },
  /** For each point, the tags of the view a touch there reaches and its ancestors; null without the native module. */
  hitTest: (points: { x: number; y: number }[]): number[][] | null => {
    if (!available()) return null;
    try {
      const json = ready().hitTest(
        points.map((p) => p.x),
        points.map((p) => p.y),
      );
      const chains = JSON.parse(json) as number[][];
      // An answer that is short of a chain per point is no answer: nothing is called covered on it.
      return chains.length === points.length ? chains : null;
    } catch {
      return null;
    }
  },
};

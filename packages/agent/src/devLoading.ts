/**
 * React Native's development banner ("Refreshing...", "Loading from Metro..."): the native DevLoadingView draws it in
 * a window of its own over the app. React Native's HMR client and Expo's both show and hide it through the one
 * `DevLoadingView` module, so watching that module tells when it is up, whatever the app is built with.
 */
type DevLoadingView = { showMessage?: (...args: unknown[]) => unknown; hide?: (...args: unknown[]) => unknown };

// iOS keeps the banner up at least 0.6 s and slides it away in 0.25 s after hide.
const HIDING_MS = 900;
// A banner nobody hid (a show the native side ended itself) stops counting after this.
const AT_MOST_MS = 5000;

let shownAt: number | undefined;
let hiddenAt: number | undefined;
let watched = false;

const load = (): DevLoadingView | undefined => {
  try {
    const module = require('react-native/Libraries/Utilities/DevLoadingView') as { default?: DevLoadingView } & DevLoadingView;
    return module.default ?? module;
  } catch {
    return undefined;
  }
};

export const watchDevLoading = (view: DevLoadingView | undefined = typeof __DEV__ !== 'undefined' && __DEV__ ? load() : undefined): void => {
  if (watched || !view) return;
  watched = true;
  const { showMessage, hide } = view;
  try {
    if (typeof showMessage === 'function')
      view.showMessage = (...args: unknown[]) => {
        shownAt = Date.now();
        hiddenAt = undefined;
        return showMessage.apply(view, args);
      };
    if (typeof hide === 'function')
      view.hide = (...args: unknown[]) => {
        if (shownAt !== undefined) hiddenAt = Date.now();
        shownAt = undefined;
        return hide.apply(view, args);
      };
  } catch {
    // A frozen module: the banner goes unwatched, as before.
  }
};

/** Whether the development banner is in front of the app now, or still sliding away. */
export const devLoadingShowing = (now: number = Date.now()): boolean =>
  (shownAt !== undefined && now - shownAt < AT_MOST_MS) || (hiddenAt !== undefined && now - hiddenAt < HIDING_MS);

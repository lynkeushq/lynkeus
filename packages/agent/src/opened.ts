import { Linking } from 'react-native';

let last: { url: string; at: number } | undefined;
let tracking = false;

/** Notes each URL the app hands the OS: a press that opens one sends the app behind the browser or another app. */
export const trackOpenedUrls = (): void => {
  if (tracking || typeof Linking?.openURL !== 'function') return;
  tracking = true;
  const openURL = Linking.openURL.bind(Linking);
  Linking.openURL = (url: string) => {
    last = { url, at: Date.now() };
    return openURL(url);
  };
};

/** The last URL the app opened at or after `since`, if any. */
export const openedSince = (since: number): string | undefined => (last && last.at >= since ? last.url : undefined);

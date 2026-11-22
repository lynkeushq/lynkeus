import { createRequire } from 'node:module';

import type { HelloEvent } from 'lynkeus-protocol';

export const CLI_VERSION = (createRequire(import.meta.url)('../../package.json') as { version: string }).version;

/**
 * An agent of another release can answer without an error and still do something else (type into
 * nothing): what to tell the person running it, or nothing when the two match.
 */
export const agentMismatch = (hello: Pick<HelloEvent, 'agentVersion'>, cli = CLI_VERSION): string | undefined => {
  if (hello.agentVersion === cli) return undefined;
  const agent = hello.agentVersion ? `lynkeus-agent ${hello.agentVersion}` : 'a lynkeus-agent too old to say its version';
  return `⚠️  The app runs ${agent}, this CLI is Lynkeus ${cli}: they can misread each other without an error. Install lynkeus-agent@${cli} in the app and rebuild it (or run the Lynkeus CLI of the agent's version).`;
};

/** Who said hello: the app and where it runs, enough to tell two apps dialing the same port apart. */
export const helloIdentity = (hello: Pick<HelloEvent, 'platform' | 'native' | 'app'>): string => {
  const app = hello.app ?? {};
  const name = typeof app.name === 'string' ? app.name : 'an app';
  const runtime = typeof app.runtime === 'string' ? app.runtime : hello.native ? 'native' : 'hosted';
  return `${name} (${hello.platform}, ${runtime})`;
};

/**
 * The driver keeps the app that dialed in last. Two apps or hosts dialing the same port take turns
 * without an error, each step going to whichever came last: say so the first time a different one comes in.
 */
export const appSwitched = (before: string | undefined, now: string, port: number): string | undefined =>
  before && before !== now
    ? `⚠️  Another app attached on port ${port}: ${before} gave way to ${now}. Two apps or hosts are dialing this port and steps go to whichever dialed last; stop one, or give each its own LYNKEUS_PORT.`
    : undefined;

/**
 * Why the app that attached is not the one `--device` names, or undefined when it may be. Two apps dialing the same
 * port take turns, and a run against an Android emulator was once served by an iOS app still running on a simulator:
 * the platform each says it is on is the one thing the driver can check. A headless host is no device and is not asked.
 */
export const devicePlatformMismatch = (
  hello: Pick<HelloEvent, 'platform' | 'native' | 'app'>,
  named: { id: string; name: string; platform: string },
  wanted: string,
  port: number,
): string | undefined => {
  if (hello.app?.runtime === 'headless' || hello.app?.runtime === 'flutter-headless') return undefined;
  if (hello.platform !== 'ios' && hello.platform !== 'android') return undefined;
  if (hello.platform === named.platform) return undefined;
  const kind = named.platform === 'android' ? 'an Android' : 'an iOS';
  return `The app that attached on port ${port} is ${helloIdentity(hello)}, but --device ${wanted} is ${named.name} (${named.id}), ${kind} device: another app is dialing this port. Stop it, or give each its own LYNKEUS_PORT.`;
};

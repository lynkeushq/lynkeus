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
  return `⚠️  The app runs ${agent}, this CLI is lynkeus ${cli}: they can misread each other without an error. Install lynkeus-agent@${cli} in the app and rebuild it (or run the lynkeus CLI of the agent's version).`;
};

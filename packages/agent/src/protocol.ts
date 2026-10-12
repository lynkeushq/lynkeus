// Types only: lynkeus-protocol must not become a runtime dependency of the app,
// so the version is declared here too (the protocol's shape test keeps them equal).
export type * from 'lynkeus-protocol';

export const PROTOCOL_VERSION = 1;

/** Sent in `hello`, so a driver of another release can say so; a test keeps it equal to package.json. */
export const AGENT_VERSION = '0.2.1';

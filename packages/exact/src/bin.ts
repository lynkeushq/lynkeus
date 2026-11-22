#!/usr/bin/env node
import { createAdapter } from './adapter.js';
import { startLink } from './link.js';
import { spawnWire } from './wire.js';

// usage: lynkeus-exact-host <port> — what `lynkeus case run --host-command "lynkeus-exact-host {port}"` starts for each
// case: an Exact host (EXACT_HOST_COMMAND, with EXACT_HOST_ARGS), answering the Lynkeus protocol on <port>.
const port = Number(process.argv[2] ?? process.env.LYNKEUS_PORT);
const command = process.env.EXACT_HOST_COMMAND ?? process.env.EXACT_LINUX_BIN ?? process.env.EXACT_MAC_BIN;
const token = process.env.LYNKEUS_TOKEN;
if (!Number.isInteger(port) || !command || !token) {
  console.error('usage: EXACT_HOST_COMMAND=<an Exact host binary> LYNKEUS_TOKEN=<token> lynkeus-exact-host <port>');
  process.exit(2);
}
const epoch = process.env.LYNKEUS_EPOCH ? Date.parse(process.env.LYNKEUS_EPOCH) : undefined;
const wire = spawnWire(command, process.env.EXACT_HOST_ARGS ? process.env.EXACT_HOST_ARGS.split(' ') : [], {
  ...(process.env.LYNKEUS_SEED ? { EXACT_AGENT_SEED: process.env.LYNKEUS_SEED } : {}),
});
const adapter = createAdapter(wire, {
  platform: process.env.EXACT_HOST_PLATFORM ?? 'linux',
  ...(epoch !== undefined && !Number.isNaN(epoch) ? { epochMs: epoch } : {}),
});
const stop = startLink(adapter, { port, token, log: (line) => console.error(`lynkeus-exact-host: ${line}`) });
const leave = () => {
  stop();
  wire.close();
  process.exit(0);
};
process.stdin.on('end', leave);
process.stdin.resume();
process.on('SIGTERM', leave);
process.on('SIGINT', leave);

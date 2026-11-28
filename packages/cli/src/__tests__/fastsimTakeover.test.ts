import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { freePorts } from '../cases/portClaim.js';
import { fromLane, laneLabel } from '../runtime.js';

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.ts');
// The server runs in the project's folder, where `--import tsx` would not resolve.
const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
// ws is the driver's own dependency (lynkeus-client), not this package's.
const ws = createRequire(createRequire(import.meta.url).resolve('lynkeus-client')).resolve('ws');

/**
 * An app behind the agent's handshake on `port`: `role` device is a development build that dials back within moments
 * when its link closes, with the system prompt over it that run 7's Simulator had; fastsim is a FastSim host's app.
 */
const AGENT = `
const { WebSocket } = require(${JSON.stringify(ws)});
const { createHmac, randomBytes } = require('node:crypto');
const [port, role, token] = process.argv.slice(2);
const hmac = (text) => createHmac('sha256', token).update(text).digest('hex');
const fastsim = role === 'fastsim';
const screen = {
  route: fastsim ? 'DemoPodcastList' : 'Login', path: [fastsim ? 'DemoPodcastList' : 'Login'], commit: 1, busy: false,
  window: { w: 390, h: 844 }, costMs: 1,
  elements: [{ i: 0, kind: 'switch', text: 'Only Show Favorites', enabled: true, depth: 0, frame: { x: 0, y: 0, w: 100, h: 40 } }],
  ...(fastsim ? {} : { system: "iOS's Save Password prompt" }),
};
const dial = () => {
  const socket = new WebSocket('ws://127.0.0.1:' + port);
  socket.on('message', (data) => {
    const m = JSON.parse(String(data));
    if (m.event === 'auth') {
      const nonce = randomBytes(16).toString('hex');
      socket.send(JSON.stringify({ event: 'hello', protocolVersion: 2, platform: 'ios', native: true, appId: 'shop',
        // Not run on a real Simulator: the session would look for it with simctl.
        app: { runtime: 'headless', name: role },
        commands: fastsim ? ['clock', 'screenshot'] : [], nonce, proof: hmac('lynkeus/app/' + m.session + '/' + m.nonce + '/' + nonce) }));
    } else if (m.id !== undefined) socket.send(JSON.stringify({ id: m.id, method: m.method, result: m.method === 'screen' ? screen : {} }));
  });
  socket.on('close', () => { if (!fastsim) setTimeout(dial, 50); });
  socket.on('error', () => undefined);
};
dial();
`;

test('lanes are named for an answer: FastSim by its clock, the headless host, a phone by its OS', () => {
  assert.equal(laneLabel({ platform: 'ios', native: true, commands: ['clock'] }), 'FastSim iOS');
  assert.equal(laneLabel({ platform: 'android', native: true, commands: ['clock'] }), 'FastSim Android');
  assert.equal(laneLabel({ platform: 'android', native: false }), 'headless');
  assert.equal(laneLabel({ platform: 'ios', native: true, commands: [] }), 'iOS Simulator');
  assert.equal(laneLabel({ platform: 'android', native: true }, 'physical'), 'Android phone');
  assert.equal(laneLabel(null), undefined);
  assert.equal(fromLane('FastSim iOS', '✓ pressed'), '[FastSim iOS] ✓ pressed');
  assert.equal(fromLane(undefined, '✓ pressed'), '✓ pressed');
});

test('after fastsim_start the session drives only the FastSim host, every answer names it, and a device app on the port never reaches one', async () => {
  const [port] = await freePorts(1, 21_100 + (process.pid % 300));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-takeover-'));
  const token = 'takeover-secret';
  fs.mkdirSync(path.join(root, '.lynkeus'));
  fs.writeFileSync(path.join(root, '.lynkeus', 'token'), token);
  fs.writeFileSync(path.join(root, 'lynkeus.config.json'), JSON.stringify({ port }));
  const agent = path.join(root, 'agent.cjs');
  fs.writeFileSync(agent, AGENT);
  // A FastSim kit whose fastsim-run starts the fake host's app on the port it is given.
  const kit = path.join(root, 'kit');
  fs.mkdirSync(path.join(kit, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(kit, 'bin', 'fastsim-run'), `#!/bin/sh\nexec "${process.execPath}" "${agent}" "$2" fastsim "${token}"\n`, { mode: 0o755 });
  const bundle = path.join(root, 'bundle');
  fs.mkdirSync(bundle);
  fs.writeFileSync(path.join(bundle, 'host.args'), '--platform ios\n');

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', tsx, cli, 'mcp'],
    cwd: root,
    stderr: 'ignore',
    env: { ...process.env, LYNKEUS_PORT: String(port) } as Record<string, string>,
  });
  const client = new Client({ name: 'takeover', version: '1' });
  await client.connect(transport);
  const { spawn } = await import('node:child_process');
  const device = spawn(process.execPath, [agent, String(port), 'device', token], { stdio: 'ignore' });
  const said = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[] };
    return r.content[0]!.text;
  };
  try {
    const before = await said('screen');
    assert.match(before, /^\[iOS Simulator\] /);
    assert.match(before, /Login/);
    const started = await said('fastsim_start', { bundle, kit, timeout: 20_000 });
    assert.match(started, /^FastSim iOS: a host on port \d+ of its own runs /);
    assert.doesNotMatch(started, new RegExp(`port ${port} of its own`));
    // The device app keeps dialing back in on the session's port; none of its screens or prompts reach an answer.
    for (let i = 0; i < 5; i++) {
      const now = await said('screen');
      assert.match(now, /^\[FastSim iOS\] /);
      assert.match(now, /DemoPodcastList/);
      assert.doesNotMatch(now, /Save Password|\+system/);
      await new Promise((r) => setTimeout(r, 60));
    }
    assert.match(await said('fastsim_stop'), /drives the apps on its own port again/);
    const after = await said('screen');
    assert.match(after, /^\[iOS Simulator\] /);
    assert.match(after, /Login/);
  } finally {
    device.kill();
    await client.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

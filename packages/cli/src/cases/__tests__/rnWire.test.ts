import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { AgentServer } from 'lynkeus-client';

import { driveCommands } from '../../commands/drive.js';
import { osCommands } from '../../commands/os.js';
import { hermetic } from '../../__tests__/goldens/hermetic.js';
import { Device } from '../../device/driver.js';
import { type Base, register } from '../../registry.js';
import { parseCase } from '../format.js';
import { runCase } from '../runner.js';

/*
 * What a case run sends a React Native app, message for message, recorded from the socket of an app that answers at
 * once. The golden file was recorded from origin/main's CLI with this same file (UPDATE_RN_WIRE=1): a change made for
 * another runtime must leave a React Native app's traffic as it is, with frames and without.
 */

hermetic();
register([...driveCommands, ...osCommands]);

const here = path.dirname(fileURLToPath(import.meta.url));
const goldenFile = path.join(here, 'rnWire.golden.json');
const TOKEN = 'rn-wire-token';
const servers: AgentServer[] = [];
after(async () => {
  for (const s of servers) await s.close();
});

const hmac = (text: string) => createHmac('sha256', TOKEN).update(text).digest('hex');

const ELEMENTS = [
  { i: 0, kind: 'text', text: 'Welcome', enabled: true, depth: 0, frame: { x: 20, y: 80, w: 200, h: 24 } },
  { i: 1, kind: 'input', testId: 'email', text: '', enabled: true, depth: 0, frame: { x: 20, y: 120, w: 350, h: 44 } },
  { i: 2, kind: 'button', testId: 'login', text: 'Log in', enabled: true, depth: 0, frame: { x: 20, y: 180, w: 350, h: 44 } },
  { i: 3, kind: 'list', testId: 'feed', enabled: true, depth: 0, frame: { x: 0, y: 240, w: 390, h: 500 } },
];

type Message = { event?: string; session?: string; nonce?: string; id?: number; method?: string; params?: Record<string, unknown> };

/** A React Native app as the agent presents itself (a host that takes screenshots, as the headless one does). */
const fakeReactNativeApp = async (port: number, dir: string) => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const sent: string[] = [];
  const answer = (m: Message): unknown => {
    const p = m.params ?? {};
    const target = (p.target ?? p) as { testId?: string; text?: string };
    const element = ELEMENTS.find((e) => (target.testId && e.testId === target.testId) || (target.text && e.text === target.text)) ?? null;
    switch (m.method) {
      case 'screen':
        return { route: 'Auth.Login', path: ['Auth.Login'], commit: 1, busy: false, window: { w: 390, h: 844 }, costMs: 1, elements: ELEMENTS };
      case 'find':
        return element;
      case 'press':
        return { x: 195, y: 202, mode: 'native', ...(element ? { element } : {}) };
      case 'type':
        return { typed: p.text, ...(element ? { element } : {}) };
      case 'swipe':
        return { from: { x: 195, y: 600 }, to: { x: 195, y: 300 } };
      case 'waitFor':
        return { route: 'Auth.Login', waitedMs: 0, ...(element ? { matched: element } : {}) };
      case 'idle':
        return { commit: 1, idle: true };
      case 'trace':
        return { last: 0, events: [] };
      case 'requests':
        return { inFlight: 0, requests: [] };
      case 'screenshot':
        fs.writeFileSync(String(p.path), 'frame');
        return { path: p.path };
      default:
        return null;
    }
  };
  // Node's own WebSocket client, so the test needs nothing the CLI does not depend on.
  socket.addEventListener('message', (event) => {
    const text = String(event.data);
    const m = JSON.parse(text) as Message;
    if (m.event === 'auth') {
      const nonce = randomBytes(16).toString('hex');
      const proof = hmac(`lynkeus/app/${m.session}/${m.nonce}/${nonce}`);
      socket.send(
        JSON.stringify({
          event: 'hello',
          protocolVersion: 2,
          platform: 'ios',
          native: true,
          commands: ['screenshot'],
          route: 'Auth.Login',
          app: { name: 'shop' },
          nonce,
          proof,
        }),
      );
    } else if (m.id !== undefined) {
      sent.push(text.split(dir).join('<dir>'));
      socket.send(JSON.stringify({ id: m.id, result: answer(m) }));
    }
  });
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
  return { socket, sent };
};

const CASE = `---
id: rn-wire
---
steps:
  - app.see: { text: Welcome }
  - app.type: { target: "#email", text: "ana@example.com" }
  - app.press: "#login"
  - app.see: "Log in"
  - app.wait: { target: "#login", timeoutMs: 2000 }
  - app.swipe: { direction: up }
  - app.press: { text: "Log in" }
`;

/** A port nothing listens on now; the server takes it right after. */
const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });

const record = async (screenshots: boolean) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-rn-wire-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '0.76.0' } }));
  const dir = path.join(root, 'frames');
  const server = new AgentServer({ token: TOKEN, port: await freePort() });
  servers.push(server);
  await server.listen();
  const app = await fakeReactNativeApp(server.port, dir);
  await server.waitForApp(10_000);
  const device = new Device({ id: 'fake', name: 'fake', platform: 'ios', type: 'simulator', connected: true }, { server });
  const base: Base = {
    root,
    config: {},
    attached: true,
    err: () => undefined,
    graph: () => {
      throw new Error('no graph');
    },
    device: async () => device,
  };
  const report = await runCase(parseCase(CASE, 'rn-wire.md'), {
    base,
    config: {},
    ...(screenshots ? { evidence: { dir, screenshots: true, settleMs: 700, frames: 'png' as const } } : {}),
  });
  app.socket.close();
  await server.close();
  assert.equal(report.result, 'passed', report.steps.map((s) => `${s.step}: ${s.error ?? s.status}`).join('\n'));
  return app.sent;
};

test("a React Native app is sent what origin/main's CLI sends it, with frames and without", async () => {
  const recorded = { frames: await record(true), noFrames: await record(false) };
  if (process.env.UPDATE_RN_WIRE === '1') fs.writeFileSync(goldenFile, `${JSON.stringify(recorded, null, 2)}\n`);
  const golden = JSON.parse(fs.readFileSync(goldenFile, 'utf8')) as typeof recorded;
  assert.deepEqual(recorded.noFrames, golden.noFrames);
  assert.deepEqual(recorded.frames, golden.frames);
});

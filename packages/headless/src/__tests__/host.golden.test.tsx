/*
 * A React Native app on the real headless host, driven over its socket as the CLI drives it: the handshake, then a
 * scripted sequence of the agent's methods (screen, find, press, type, waitFor, swipe, idle, batch, app commands,
 * reset) against a real React tree. Every answer is pinned by the snapshot, so a change in the agent's handlers or in
 * the headless backend shows in review. Timings and nonces are named for what they are.
 */
import { createHmac, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, expect, it } from '@jest/globals';
import { qa } from 'lynkeus-agent';
import { useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { WebSocketServer, type WebSocket } from 'ws';

import { hostApp, type HostOptions } from '../index.js';

const TOKEN = 'host-golden-token';
const hmac = (text: string) => createHmac('sha256', TOKEN).update(text).digest('hex');

const App = () => {
  const [count, setCount] = useState(0);
  const [name, setName] = useState('');
  const [sent, setSent] = useState<string | undefined>();
  const [dialog, setDialog] = useState(false);
  return (
    <ScrollView testID="home">
      <Text>Welcome</Text>
      <Text>{`Count: ${count}`}</Text>
      <Pressable testID="increment" onPress={() => setCount((c) => c + 1)}>
        <Text>Increment</Text>
      </Pressable>
      <TextInput testID="name" placeholder="Name" value={name} onChangeText={setName} />
      <Pressable testID="send" onPress={() => setSent(name)}>
        <Text>Send code</Text>
      </Pressable>
      {sent !== undefined && <Text>{`Code sent to ${sent}`}</Text>}
      <Pressable testID="later" disabled onPress={() => undefined}>
        <Text>Later</Text>
      </Pressable>
      <Pressable testID="delete" onPress={() => setDialog(true)}>
        <Text>Delete everything</Text>
      </Pressable>
      {dialog && (
        <View testID="confirm-delete" accessibilityViewIsModal>
          <Text>Delete everything?</Text>
          <Pressable
            testID="confirm"
            onPress={() => {
              setDialog(false);
              setCount(0);
            }}
          >
            <Text>Delete</Text>
          </Pressable>
        </View>
      )}
      {Array.from({ length: 30 }, (_, i) => (
        <Text key={i}>{`Row ${i + 1}`}</Text>
      ))}
    </ScrollView>
  );
};

qa.register('greet', (params) => `hello ${(params as { who?: string } | undefined)?.who ?? 'nobody'}`);

const SCRIPT: [string, unknown?][] = [
  ['ping'],
  ['screen'],
  ['find', { testId: 'increment' }],
  ['press', { testId: 'increment' }],
  ['press', { text: 'Increment' }],
  ['waitFor', { target: { text: 'Count: 2' }, timeoutMs: 5000 }],
  ['type', { target: { testId: 'name' }, text: 'Ana' }],
  ['press', { testId: 'send' }],
  ['waitFor', { target: { text: 'Code sent to Ana' }, timeoutMs: 5000 }],
  ['find', { text: 'nope' }],
  ['press', { testId: 'missing' }],
  ['press', { testId: 'later' }],
  ['swipe', { direction: 'up' }],
  ['press', { testId: 'delete' }],
  ['screen'],
  ['press', { testId: 'confirm' }],
  ['waitFor', { target: { text: 'Count: 0' }, timeoutMs: 5000 }],
  ['batch', { calls: [{ method: 'ping' }, { method: 'find', params: { testId: 'send' } }] }],
  ['nope'],
  ['greet', { who: 'Ana' }],
  ['back'],
  ['reset'],
  ['screen'],
];

// Values that are the machine's, not the agent's: how long something took, when it happened, a fresh nonce.
const TIMING = /(^|[a-z])(ms|Ms|At|^t|^at|^ts|^time)$/;
const stable = (value: unknown, key = ''): unknown => {
  if (key === 'params') return value;
  if (Array.isArray(value)) return value.map((v) => stable(v));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stable(v, k)]));
  if (typeof value === 'number' && TIMING.test(key)) return '<time>';
  if (typeof value === 'string' && (key === 'nonce' || key === 'proof')) return '<hex>';
  if (key === 'agentVersion') return '<version>';
  return value;
};

const options: HostOptions = { token: TOKEN, port: 0, app: { name: 'golden' } };
let wss: WebSocketServer;
let transcript: Promise<unknown[]>;

const drive = (socket: WebSocket): Promise<unknown[]> =>
  new Promise((resolve, reject) => {
    const session = 'golden-session';
    const nonce = randomBytes(16).toString('hex');
    const out: unknown[] = [];
    const waiting = new Map<number, (answer: unknown) => void>();
    let id = 0;
    const call = (method: string, params?: unknown) =>
      new Promise<unknown>((answered) => {
        id += 1;
        waiting.set(id, answered);
        socket.send(JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) }));
      });
    socket.on('message', (data) => {
      const message = JSON.parse(String(data)) as { event?: string; id?: number; nonce?: string; proof?: string };
      if (message.event === 'hello') {
        out.push({ hello: message, proofHolds: message.proof === hmac(`lynkeus/app/${session}/${nonce}/${message.nonce}`) });
        socket.send(JSON.stringify({ event: 'verified', proof: hmac(`lynkeus/driver/${session}/${nonce}/${message.nonce}`) }));
        void (async () => {
          for (const [method, params] of SCRIPT) out.push({ call: method, params, answer: await call(method, params) });
          await call('exit');
          resolve(out);
        })().catch(reject);
      } else if (message.id !== undefined) {
        waiting.get(message.id)?.(message);
        waiting.delete(message.id);
      }
    });
    socket.send(JSON.stringify({ event: 'auth', session, nonce }));
  });

beforeAll(async () => {
  wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => wss.once('listening', resolve));
  options.port = (wss.address() as AddressInfo).port;
  transcript = new Promise((resolve, reject) => wss.once('connection', (socket) => drive(socket).then(resolve, reject)));
  // A host that never hears from its driver would wait forever: give up after a minute, as a signal would.
  setTimeout(() => process.emit('SIGTERM'), 60_000).unref();
});

afterAll(() => {
  wss.close();
});

hostApp(() => <App />, options);

it('answers the scripted sequence as it did', async () => {
  expect(stable(await transcript)).toMatchSnapshot();
}, 60_000);

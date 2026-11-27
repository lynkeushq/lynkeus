import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import type { RequestRecord } from 'lynkeus-protocol';

import { driveCommands } from '../../commands/drive.js';
import { osCommands } from '../../commands/os.js';
import type { Device } from '../../device/driver.js';
import { type Base, find, register } from '../../registry.js';
import { Fixtures } from '../fixtures.js';
import { parseCase } from '../format.js';
import { argvFor, expandSteps, fetchFilm, missingFixtures, newSince, type Prepared, preparable, runCase, type StepReport, stepRoutes } from '../runner.js';
import { FIXTURES } from '../templates.js';

register([...driveCommands, ...osCommands]);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-cases-'));
fs.writeFileSync(path.join(root, 'fixtures.mjs'), FIXTURES);
const fixtures = new Fixtures({ command: 'node fixtures.mjs' }, root);
after(() => fixtures.close());

type Call = { method: string; params: unknown };

// An app with one button that, pressed, shows the points the fixtures hold.
const fakeApp = () => {
  const calls: Call[] = [];
  let shown = 'Hello';
  // The app's requests as it numbers them; a press asks for the points again.
  const requests: RequestRecord[] = [{ id: 1, method: 'GET', url: 'http://x/api/points', status: 200, startedAt: 0 }];
  const screen = () => ({
    route: 'Profile.Main',
    path: ['Profile.Main'],
    commit: 1,
    busy: false,
    window: { w: 390, h: 844 },
    costMs: 1,
    elements: [
      { i: 0, kind: 'button', testId: 'refresh', enabled: true, depth: 0, frame: { x: 0, y: 0, w: 100, h: 40 } },
      { i: 1, kind: 'text', text: shown, enabled: true, depth: 0, frame: { x: 0, y: 50, w: 100, h: 20 } },
    ],
  });
  const server = {
    connected: true,
    call: async (method: string, params: { testId?: string }) => {
      calls.push({ method, params });
      if (method === 'find') return screen().elements.find((e) => e.testId === params.testId) ?? null;
      return null;
    },
  };
  const device = {
    server,
    screen: async () => screen(),
    trace: async () => ({ last: 0, events: [{ seq: 1, t: 0, kind: 'request', method: 'GET', url: 'http://x/api/points', status: 200 }] }),
    requests: async (since?: number) => ({ inFlight: 0, requests: requests.filter((r) => since === undefined || r.id > since) }),
    press: async (params: unknown) => {
      calls.push({ method: 'press', params });
      shown = '25 points';
      requests.push({ id: requests.length + 1, method: 'GET', url: 'http://x/api/points', status: 200, startedAt: 0 });
      return { x: 0, y: 0, mode: 'native' };
    },
    waitFor: async () => ({ waitedMs: 0 }),
    idle: async () => ({ settled: true }),
    swipe: (params: never) => server.call('swipe', params),
    command: async (name: string) => (name === 'events' ? [{ name: 'points_viewed', properties: { points: 25 } }] : {}),
  } as unknown as Device;
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
  return { base, calls, requests };
};

const config = { refs: { user: 'user_id' }, inspect: 'inspect' };

test('a case prepares the backend, drives the app and reads both', async () => {
  const c = parseCase(
    `---
id: gift
---
setup:
  - create_user: { as: u, name: "Ana" }
steps:
  - app.see: { text: "Hello" }
  - give_points: { user: u, points: 25 }
  - app.press: "#refresh"
  - app.see: { text: "25 points", request: "GET /api/points", event: points_viewed, props: { points: 25 } }
  - app.see: { text: "Hello", absent: true }
  - assert: { user: u, path: points, equals: 25 }
  - assert: { path: name, equals: "Ana" }
`,
    'gift.md',
  );
  const { base, calls } = fakeApp();
  const report = await runCase(c, { base, config, fixtures });
  assert.deepEqual(
    report.steps.map((s) => [s.status, s.error]),
    Array(8).fill(['passed', undefined]),
  );
  assert.equal(calls.filter((x) => x.method === 'press').length, 1);
});

test('a wait accepts any of several targets', async () => {
  const c = parseCase('---\nid: alternatives\n---\nsteps:\n  - app.wait: { anyOf: ["Goodbye", "Hello"] }\n', 'alternatives.md');
  const { base, calls } = fakeApp();
  const device = await base.device();
  const waitFor = device.waitFor;
  device.waitFor = async (params) => {
    calls.push({ method: 'waitFor', params });
    return waitFor(params);
  };
  const report = await runCase(c, { base, config, fixtures });
  assert.equal(report.result, 'passed', JSON.stringify(report.steps));
  const wait = calls.find((x) => x.method === 'waitFor');
  assert.deepEqual(wait?.params, {
    anyOf: [{ text: 'Goodbye' }, { text: 'Hello' }],
    gone: undefined,
    scroll: undefined,
    timeoutMs: 10000,
    since: undefined,
  });
});

test('a wait can ask for its target to be enabled', async () => {
  const c = parseCase('---\nid: enabled\n---\nsteps:\n  - app.wait: { what: "#next", enabled: true }\n', 'enabled.md');
  const { base, calls } = fakeApp();
  const device = await base.device();
  const waitFor = device.waitFor;
  device.waitFor = async (params) => {
    calls.push({ method: 'waitFor', params });
    return waitFor(params);
  };
  await runCase(c, { base, config, fixtures });
  const waited = calls.find((x) => x.method === 'waitFor');
  assert.ok(waited, 'no waitFor was sent');
  assert.equal((waited.params as { enabled?: boolean }).enabled, true);
});

test('a wait takes object targets in anyOf, and refuses gone with anyOf', async () => {
  const wait = find('wait')!;
  assert.deepEqual(argvFor(wait, { anyOf: [{ testId: 'a' }, { text: 'b', nth: 1 }, '#c'] }), ['wait', '--anyOf', '#a', '--anyOf', '"b"[1]', '--anyOf', '#c']);
  assert.throws(() => argvFor(wait, { anyOf: [{ x: 1, y: 2 }] }), /string, \{ testId \} or \{ text \}/);
  const c = parseCase('---\nid: objects\n---\nsteps:\n  - app.wait: { anyOf: [{ testId: nope }, { text: Hello }] }\n', 'objects.md');
  const { base, calls } = fakeApp();
  const device = await base.device();
  const waitFor = device.waitFor;
  device.waitFor = async (params) => {
    calls.push({ method: 'waitFor', params });
    return waitFor(params);
  };
  const report = await runCase(c, { base, config, fixtures });
  assert.equal(report.result, 'passed', JSON.stringify(report.steps));
  const waited = calls.find((x) => x.method === 'waitFor');
  assert.ok(waited, 'no waitFor was sent');
  assert.deepEqual((waited.params as { anyOf: unknown }).anyOf, [{ testId: 'nope' }, { text: 'Hello' }]);
  const gone = parseCase('---\nid: gone\n---\nsteps:\n  - app.wait: { anyOf: ["Hello"], gone: true }\n', 'gone.md');
  const refused = await runCase(gone, { base, config, fixtures });
  assert.equal(refused.result, 'failed');
  assert.match(JSON.stringify(refused.steps), /--gone takes one target/);
});

test('a press names its control by testId, and a type takes a deadline for its field', async () => {
  const c = parseCase('---\nid: named\n---\nsteps:\n  - app.press: { testId: refresh }\n  - app.type: { text: "x", timeoutMs: 200 }\n', 'named.md');
  const { base, calls } = fakeApp();
  const device = await base.device();
  (device as unknown as { type: () => Promise<unknown> }).type = async () => ({});
  const report = await runCase(c, { base, config, fixtures });
  assert.deepEqual(
    report.steps.map((s) => [s.status, s.error]),
    Array(2).fill(['passed', undefined]),
  );
  assert.equal(calls.filter((x) => x.method === 'press' && (x.params as { testId?: string }).testId === 'refresh').length, 1);
});

test('the first step that fails stops the case and leaves the evidence', async () => {
  const c = parseCase('---\nid: red\n---\nsteps:\n  - app.see: { text: "Goodbye", timeoutMs: 200 }\n  - app.press: "#refresh"\n', 'red.md');
  const { base, calls } = fakeApp();
  const report = await runCase(c, { base, config, fixtures });
  assert.equal(report.result, 'failed');
  assert.deepEqual(
    report.steps.map((s) => s.status),
    ['failed', 'skipped'],
  );
  assert.match(report.steps[0]!.error!, /not on screen: "Goodbye"/);
  assert.match(report.evidence!.screen!, /button #refresh/);
  assert.equal(calls.filter((x) => x.method === 'press').length, 0);
});

test('with continue, the steps after a failed one still run; a failed setup still stops the case', async () => {
  const red = parseCase('---\nid: red\n---\nsteps:\n  - app.see: { text: "Goodbye", timeoutMs: 200 }\n  - app.press: "#refresh"\n', 'red.md');
  const { base, calls } = fakeApp();
  const report = await runCase(red, { base, config, fixtures, continue: true });
  assert.equal(report.result, 'failed');
  assert.deepEqual(
    report.steps.map((s) => s.status),
    ['failed', 'passed'],
  );
  assert.equal(calls.filter((x) => x.method === 'press').length, 1);

  const broken = parseCase('---\nid: broken\n---\nsetup:\n  - no_such_fixture: {}\nsteps:\n  - app.press: "#refresh"\n', 'broken.md');
  const stopped = await runCase(broken, { base, config, fixtures, continue: true });
  assert.deepEqual(
    stopped.steps.map((s) => s.status),
    ['failed', 'skipped'],
  );
});

test('a run that asks for routes gets the screens the case went through, not the one the app was left on', async () => {
  const c = parseCase('---\nid: walk\n---\nsteps:\n  - app.press: "#refresh"\n', 'walk.md');
  const { base } = fakeApp();
  const device = await base.device();
  const asked: (number | undefined)[] = [];
  device.trace = async (since?: number) => {
    asked.push(since);
    return {
      last: 7,
      events:
        since === undefined
          ? []
          : [
              // The reset of an app left on Profile.Main reports it once more before the case moves on.
              { seq: 8, t: 0, kind: 'route', route: 'Profile.Main', path: [] },
              { seq: 9, t: 0, kind: 'route', route: 'Home.Main', path: [] },
              { seq: 10, t: 0, kind: 'route', route: 'Settings.Main', path: [] },
            ],
    };
  };
  const report = await runCase(c, { base, config, fixtures, routes: true });
  assert.deepEqual(report.routes, ['Home.Main', 'Settings.Main']);
  assert.equal(asked.at(-1), 7);
});

test('a run that asks for routes keeps the screen each step left the app on, read off the marks steps take anyway', async () => {
  const c = parseCase('---\nid: steps\n---\nsteps:\n  - app.press: "#refresh"\n  - app.see: "#refresh"\n  - app.press: "#refresh"\n', 'steps.md');
  const { base } = fakeApp();
  const device = await base.device();
  const events: { seq: number; t: number; kind: 'route'; route: string; path: string[] }[] = [];
  const reached = ['Home.Main', 'Settings.Main'];
  device.trace = async (since?: number) => ({ last: events.length, events: since === undefined ? [] : events.filter((e) => e.seq > since) });
  const press = device.press.bind(device);
  device.press = async (params) => {
    const done = await press(params);
    events.push({ seq: events.length + 1, t: 0, kind: 'route', route: reached[events.length]!, path: [] });
    return done;
  };
  const report = await runCase(c, { base, config, fixtures, routes: true });
  assert.deepEqual(
    report.steps.map((s) => s.route),
    ['Home.Main', 'Home.Main', 'Settings.Main'],
  );
  const plain = await runCase(c, { base, config, fixtures });
  assert.ok(plain.steps.every((s) => s.route === undefined));
});

test('a step that only looked keeps the screen it found; one skipped gets none', () => {
  const ran: StepReport[] = [
    { step: 'a', status: 'passed', ms: 0 },
    { step: 'b', status: 'passed', ms: 0 },
    { step: 'c', status: 'passed', ms: 0 },
    { step: 'd', status: 'skipped', ms: 0 },
  ];
  stepRoutes(
    ran,
    [0, undefined, 5],
    [
      { seq: 2, route: 'A' },
      { seq: 4, route: 'B' },
      { seq: 7, route: 'C' },
    ],
  );
  assert.deepEqual(
    ran.map((s) => s.route),
    ['B', 'B', 'C', undefined],
  );
});

test('an optional press of something that is not there is skipped, not failed', async () => {
  const c = parseCase('---\nid: opt\n---\nsteps:\n  - app.press: { target: "#dismiss", optional: true }\n', 'opt.md');
  const { base } = fakeApp();
  const device = await base.device();
  (device as unknown as { waitFor: () => Promise<never> }).waitFor = async () => {
    throw new Error('Timed out');
  };
  const report = await runCase(c, { base, config, fixtures });
  assert.deepEqual(
    report.steps.map((s) => s.status),
    ['skipped'],
  );
});

test('an optional press is skipped when its one-time control disappears before the native tap', async () => {
  const c = parseCase('---\nid: opt-race\n---\nsteps:\n  - app.press: { target: "#refresh", optional: true }\n', 'opt-race.md');
  const { base } = fakeApp();
  const device = await base.device();
  device.press = async () => {
    throw new Error('No element matches {"testId":"refresh"}');
  };
  const report = await runCase(c, { base, config, fixtures });
  assert.deepEqual(
    report.steps.map((s) => s.status),
    ['skipped'],
  );
});

test('a macro is the steps a project gave a name to, with what the case passed', async () => {
  const c = parseCase(
    '---\nid: m\n---\nsetup:\n  - create_user: { as: u }\nsteps:\n  - app.enter: { as: u, then: "#refresh" }\n  - app.enter: { as: u }\n',
    'm.md',
  );
  const { base, calls } = fakeApp();
  const macros = {
    'app.enter': [{ assert: { user_id: '{{param.as.user_id}}', path: 'user_id', matches: '^u_' } }, { when: 'then', do: { 'app.press': '{{param.then}}' } }],
  };
  const report = await runCase(c, { base, config: { ...config, macros }, fixtures });
  assert.equal(report.result, 'passed', JSON.stringify(report.steps));
  assert.equal(calls.filter((x) => x.method === 'press').length, 1);
});

test("a step that is neither the app's nor a declared fixture says so", async () => {
  const c = parseCase('---\nid: f\n---\nsteps:\n  - teleport: { to: "moon" }\n', 'f.md');
  const { base } = fakeApp();
  const report = await runCase(c, { base, config, fixtures });
  assert.match(report.steps[0]!.error!, /no fixture teleport/);
});

test('a step becomes the argv of the command it names', () => {
  assert.deepEqual(argvFor(find('type')!, { text: 'ana', target: '#search', submit: true }), ['type', 'ana', '#search', '--submit']);
  assert.deepEqual(argvFor(find('wait')!, { target: '#row-25', scroll: true, timeoutMs: 9000 }), ['wait', '#row-25', '--scroll', '--timeout', '9000']);
  assert.deepEqual(argvFor(find('press')!, { target: '#like', within: 'hi from Ana' }), ['press', '#like', '--in', 'hi from Ana']);
  assert.deepEqual(argvFor(find('mock')!, { request: 'POST /pay', lost: true, times: 1 }), ['mock', 'POST /pay', '--lost', '--times', '1']);
  assert.deepEqual(argvFor(find('swipe')!, { from: '10,20', to: '10,300', durationMs: 300 }), [
    'swipe',
    '--from',
    '10,20',
    '--to',
    '10,300',
    '--duration',
    '300',
  ]);
  assert.deepEqual(argvFor(find('mock')!, 'clear'), ['mock', '--clear']);
  assert.throws(() => argvFor(find('press')!, { target: '#x', sideways: true }), /press has no sideways/);
  assert.deepEqual(argvFor(find('press')!, { testId: 'like', within: 'hi from Ana' }), ['press', '#like', '--in', 'hi from Ana']);
  assert.deepEqual(argvFor(find('type')!, { text: 'ana', testId: 'search' }), ['type', 'ana', '#search']);
  assert.deepEqual(argvFor(find('wait')!, { testId: 'row-25', timeoutMs: 9000 }), ['wait', '#row-25', '--timeout', '9000']);
});

test('what a buffer gained is found whichever end it grows from', () => {
  const a = { name: 'a' };
  const b = { name: 'b' };
  const c = { name: 'c' };
  assert.deepEqual(newSince([a], [a, b, c]), [b, c]);
  assert.deepEqual(newSince([a], [c, b, a]), [b, c]);
  assert.deepEqual(newSince([a, b], [a, b]), []);
  assert.deepEqual(newSince([a, b], [c]), [c]);
});

test('a run that asks for events keeps each with the step that caused it', async () => {
  const c = parseCase('---\nid: ev\n---\nsteps:\n  - app.see: { text: "Hello" }\n  - app.press: "#refresh"\n', 'ev.md');
  const { base } = fakeApp();
  const device = await base.device();
  let buffer: object[] = [];
  (device as unknown as { command: (n: string) => Promise<unknown> }).command = async () => buffer;
  const press = device.press.bind(device);
  (device as unknown as { press: typeof device.press }).press = async (p) => {
    buffer = [{ name: 'refreshed', properties: { by: 'button' } }, ...buffer];
    return press(p);
  };
  const report = await runCase(c, { base, config, fixtures, events: true });
  assert.deepEqual(report.events, [{ name: 'refreshed', props: { by: 'button' }, step: 2, route: 'Profile.Main' }]);
});

test("a host that records SDK calls is not asked for the app's own event list", async () => {
  const c = parseCase('---\nid: ev\n---\nsteps:\n  - app.press: "#refresh"\n', 'ev.md');
  const { base } = fakeApp();
  const device = await base.device();
  (device as unknown as { server: { hello: unknown } }).server.hello = { native: true, commands: ['analytics'] };
  const asked: string[] = [];
  (device as unknown as { command: (n: string) => Promise<unknown> }).command = async (n) => {
    asked.push(n);
    return n === 'analytics' ? [{ sdk: 'mixpanel', name: 'Refreshed' }] : [];
  };
  const report = await runCase(c, { base, config, fixtures, events: true });
  assert.equal(asked.includes('events'), false);
  assert.deepEqual(report.steps.at(-1)?.sent, [{ provider: 'mixpanel', name: 'Refreshed', via: 'sdk' }]);
});

test('each app step gets what the backend told its analytics while it ran', async () => {
  const c = parseCase('---\nid: sv\n---\nsteps:\n  - app.press: "#refresh"\n', 'sv.md');
  const { base } = fakeApp();
  const device = await base.device();
  (device as unknown as { server: { hello: unknown } }).server.hello = { native: true, commands: ['analytics'] };
  (device as unknown as { command: (n: string) => Promise<unknown> }).command = async () => [];
  const asked: Record<string, unknown>[] = [];
  const server = {
    call: async (name: string, params: Record<string, unknown>) => {
      asked.push({ name, ...params });
      return { events: [{ event: 'AuthAttemptResolved', payload: { outcome: 'ok' } }] };
    },
  } as unknown as typeof fixtures;
  const report = await runCase(c, {
    base,
    config: { ...config, serverEvents: { fixture: 'olympus_events', provider: 'mixpanel' } },
    fixtures: server,
    events: true,
  });
  assert.equal(asked[0]?.name, 'olympus_events');
  assert.equal(typeof asked[0]?.since, 'string');
  assert.deepEqual(report.steps.at(-1)?.sent, [{ provider: 'mixpanel', name: 'AuthAttemptResolved', props: { outcome: 'ok' }, via: 'server' }]);
});

test('what the app puts in the way of a step is dealt with before it, unless the step is about it', async () => {
  const { base, calls } = fakeApp();
  const interruptions = [{ see: '#refresh', unless: 'refresh', do: [{ 'app.press': '#refresh' }] }];
  const c = parseCase('---\nid: t\n---\nsteps:\n  - app.see: { testId: refresh }\n  - app.see: { text: "25 points" }\n', 't.md');
  const report = await runCase(c, { base, config: { ...config, interruptions }, fixtures });
  assert.equal(report.result, 'passed');
  assert.equal(calls.filter((call) => call.method === 'press').length > 0, true);
});

test('a dry run names the step nobody answers and the argument a command does not take', async () => {
  const { base } = fakeApp();
  const c = parseCase('---\nid: t\n---\nsteps:\n  - app.teleport: somewhere\n  - app.clock: { sideways: 1 }\n  - app.clock: { advanceMs: 1000 }\n', 't.md');
  const report = await runCase(c, { base, config, fixtures, dry: true });
  assert.equal(report.result, 'failed');
  assert.deepEqual(
    report.steps.map((s) => s.status),
    ['failed', 'failed', 'passed'],
  );
});

test('a step kept to a device is skipped on a host, and one kept to the host runs there', async () => {
  const { base, calls } = fakeApp();
  const c = parseCase(
    '---\nid: t\n---\nsteps:\n  - on: device\n    do:\n      - app.press: "#nowhere"\n  - on: headless\n    do: { app.press: "#refresh" }\n  - app.see: { text: "25 points" }\n',
    't.md',
  );
  assert.equal(c.steps[0]!.on, 'device');
  const report = await runCase(c, { base, config, fixtures });
  assert.equal(report.result, 'passed', JSON.stringify(report.steps));
  assert.deepEqual(
    report.steps.map((s) => s.status),
    ['skipped', 'passed', 'passed'],
  );
  assert.equal(calls.filter((call) => call.method === 'press').length, 1);
});

test('a step the host cannot do stops the case without failing it', async () => {
  const c = parseCase(
    `---
id: stores
---
steps:
  - app.see: { text: "Hello" }
  - app.call: { command: stores }
  - app.see: { text: "25 points" }
`,
    'stores.md',
  );
  const { base } = fakeApp();
  const device = await base.device();
  (device as unknown as { command: (n: string) => Promise<unknown> }).command = async (name) => {
    throw new Error(`Unknown method ${name}`);
  };
  const report = await runCase(c, { base, config, fixtures });
  assert.equal(report.result, 'unsupported');
  assert.deepEqual(
    report.steps.map((s) => [s.status, s.error]),
    [
      ['passed', undefined],
      ['unsupported', 'this host has no stores'],
      ['skipped', undefined],
    ],
  );
  assert.equal(report.evidence, undefined);
});

test('an app command a release bundle never registered says why with the step', async () => {
  const c = parseCase('---\nid: sign-in\n---\nsteps:\n  - app.call: { command: signIn }\n', 'sign-in.md');
  const { base } = fakeApp();
  const device = await base.device();
  const why =
    '(this is a release bundle, __DEV__ is false, as on Lynkeus FastSim: if the app registers signIn inside if (__DEV__), that never ran here; call qa.register without the guard, it does nothing until Lynkeus connects)';
  (device as unknown as { command: (n: string) => Promise<unknown> }).command = async (name) => {
    throw new Error(`Unknown method ${name} ${why}`);
  };
  const report = await runCase(c, { base, config, fixtures });
  assert.equal(report.result, 'unsupported');
  assert.equal(report.steps[0]?.error, `this host has no signIn ${why}`);
});

test('the fixtures server says what it answers, and a case that names anything else is caught', async () => {
  const described = await fixtures.describe();
  assert.ok(described?.commands.includes('create_user'));
  const c = parseCase(
    `---
id: gift
---
setup:
  - create_user: { as: u }
  - grant_badge: { user: u }
steps:
  - app.see: { text: "Hello" }
  - assert: { user: u, path: points, equals: 0 }
`,
    'gift.md',
  );
  assert.deepEqual(missingFixtures(c, config, described?.commands ?? []), ['grant_badge']);
  assert.deepEqual(missingFixtures(c, { ...config, inspect: 'look' }, described?.commands ?? []), ['grant_badge', 'look']);
});

test('a fixtures server that does not describe itself is left unchecked', async () => {
  fs.writeFileSync(path.join(root, 'old.mjs'), FIXTURES.replace("command === 'lynkeus.describe'", 'false'));
  const old = new Fixtures({ command: 'node old.mjs' }, root);
  try {
    assert.equal(await old.describe(), undefined);
  } finally {
    old.close();
  }
});

test('on a host that lists its window, what a step looks for is scrolled to', async () => {
  const c = parseCase(
    `---
id: below
---
steps:
  - app.see: { text: "Terms" }
`,
    'below.md',
  );
  const { base } = fakeApp();
  const device = await base.device();
  let swipes = 0;
  const fake = device as unknown as {
    server: { hello?: { native: boolean }; call: (method: string, params: never) => Promise<unknown> };
    screen: () => Promise<unknown>;
    waitFor: () => Promise<never>;
  };
  const listed = fake.screen;
  const call = fake.server.call;
  fake.server.hello = { native: true };
  fake.waitFor = async () => {
    throw new Error('Timed out');
  };
  fake.server.call = async (method, params) => {
    if (method !== 'swipe') return call(method, params);
    swipes += 1;
    return {};
  };
  // Two screenfuls down, the text comes into the window.
  fake.screen = async () => {
    const screen = (await listed()) as { elements: { kind: string; text?: string; frame: { y: number } }[] };
    const text = screen.elements.find((e) => e.kind === 'text');
    if (text) {
      text.text = swipes >= 2 ? 'Terms and conditions' : `Paragraph ${swipes}`;
      text.frame.y = 50 + swipes;
    }
    return screen;
  };
  const report = await runCase(c, { base, config, fixtures });
  assert.equal(report.result, 'passed', report.steps.map((s) => s.error).join(' '));
  assert.equal(swipes, 2);
});

test('a step kept to a host whose app has a command runs only there', async () => {
  const c = parseCase(
    `---
id: has
---
steps:
  - on: "has:session"
    do:
      - app.see: { text: "Hello" }
  - on: "!has:session"
    do:
      - app.see: { text: "never shown" }
`,
    'has.md',
  );
  const { base } = fakeApp();
  const device = await base.device();
  (device as unknown as { server: { hello: unknown } }).server.hello = { native: false, commands: ['session'] };
  const report = await runCase(c, { base, config, fixtures });
  assert.deepEqual(
    report.steps.map((s) => s.status),
    ['passed', 'skipped'],
  );
});

test('a host that keeps its own clock is not a device', async () => {
  const c = parseCase(
    `---
id: clock
title: device steps
---
steps:
  - on: device
    do:
      - app.see: { text: "never shown" }
  - on: headless
    do:
      - app.see: { text: "Hello" }
`,
    'clock.md',
  );
  const { base } = fakeApp();
  const device = await base.device();
  (device as unknown as { server: { hello: unknown } }).server.hello = { native: true, commands: ['clock'] };
  const report = await runCase(c, { base, config, fixtures });
  assert.deepEqual(
    report.steps.map((s) => s.status),
    ['skipped', 'passed'],
  );
});

test('a device block goes on after a step that sends the app away', async () => {
  const c = parseCase(
    `---
id: away
---
steps:
  - on: device
    do:
      - app.press: "#refresh"
      - app.press: "#refresh"
`,
    'away.md',
  );
  const { base, calls } = fakeApp();
  const device = await base.device();
  const server = (device as unknown as { server: { hello: unknown } }).server;
  server.hello = { native: true, commands: [] };
  const press = device.press.bind(device);
  // The first press stands for the app going to the background: it lets go of the driver.
  (device as unknown as { press: typeof press }).press = async (params) => {
    server.hello = null;
    return press(params);
  };
  const report = await runCase(c, { base, config, fixtures });
  assert.deepEqual(
    report.steps.map((s) => s.status),
    ['passed', 'passed'],
  );
  assert.equal(calls.filter((call) => call.method === 'press').length, 2);
});

test('a setup made ahead is where the case starts, and the backend is not asked again', async () => {
  const c = parseCase(
    `---
id: ahead
---
setup:
  - create_user: { as: u, name: "Ana" }
  - give_points: { user: u, points: 25 }
steps:
  - assert: { user: u, path: points, equals: 25 }
  - assert: { path: name, equals: "Ana" }
`,
    'ahead.md',
  );
  assert.equal(preparable(c, config), true);
  let kept: Prepared | undefined;
  const { base } = fakeApp();
  await runCase(c, { base, config, fixtures, setupOnly: { keep: (p) => (kept = p) } });
  assert.ok(kept);
  const asked: string[] = [];
  const counting = {
    call: async (name: string, params: Record<string, unknown>) => {
      asked.push(name);
      return fixtures.call(name, params);
    },
  } as Fixtures;
  const report = await runCase(c, { base, config, fixtures: counting, prepared: kept });
  assert.equal(report.result, 'passed', report.steps.map((s) => s.error).join(' '));
  assert.deepEqual(asked, ['inspect', 'inspect']);
  assert.equal(report.steps.length, 4);
});

test('a setup that drives the app is not made ahead', () => {
  const c = parseCase('---\nid: app\n---\nsetup:\n  - create_user: { as: u }\n  - app.login: { as: u }\n', 'app.md');
  assert.equal(preparable(c, { macros: { 'app.login': [] } }), false);
});

test('a request match tolerates the trailing slash added by Android HTTP stacks', async () => {
  const c = parseCase(
    '---\nid: slash\n---\nsteps:\n  - app.press: "#refresh"\n  - app.wait: { request: "POST /api/points", status: 422, timeoutMs: 100 }\n',
    'slash.md',
  );
  const { base, requests } = fakeApp();
  const device = await base.device();
  (device as unknown as { press: () => Promise<unknown> }).press = async () => {
    requests.push({ id: requests.length + 1, method: 'POST', url: 'http://x/api/points/?', status: 422, startedAt: 0, mocked: true });
    return { x: 0, y: 0, mode: 'native' };
  };
  const report = await runCase(c, { base, config, fixtures });
  assert.deepEqual(
    report.steps.map((s) => s.status),
    ['passed', 'passed'],
  );
});

test('a step waits only for requests started after the action before it began', async () => {
  const c = parseCase(
    '---\nid: req\n---\nsteps:\n  - app.press: "#refresh"\n  - app.wait: { request: "GET /api/points", timeoutMs: 400 }\n  - app.press: "#refresh"\n  - app.see: { request: "POST /api/points", timeoutMs: 200 }\n',
    'req.md',
  );
  const { base, requests } = fakeApp();
  // Already asked for before the case: it must not pass for the one the press causes.
  requests.push({ id: 2, method: 'POST', url: 'http://x/api/points', status: 200, startedAt: 0 });
  const report = await runCase(c, { base, config, fixtures });
  assert.deepEqual(
    report.steps.map((s) => s.status),
    ['passed', 'passed', 'passed', 'failed'],
  );
  assert.match(report.steps[3]!.error!, /not requested since the step before began: POST \/api\/points/);
});

test('a request the press before did not cause is not waited for', async () => {
  const c = parseCase('---\nid: stale\n---\nsteps:\n  - app.type: { text: "x" }\n  - app.wait: { request: "GET /api/points", timeoutMs: 300 }\n', 'stale.md');
  const { base } = fakeApp();
  const device = await base.device();
  (device as unknown as { type: () => Promise<unknown> }).type = async () => ({});
  const report = await runCase(c, { base, config, fixtures });
  assert.equal(report.steps[1]!.status, 'failed');
  assert.match(report.steps[1]!.error!, /no 2xx GET \/api\/points within 300 ms/);
});

test('a mark made by hand holds across the actions after it until a step has looked for a request', async () => {
  const c = parseCase(
    '---\nid: hand\n---\nsteps:\n  - app.requests: mark\n  - app.press: "#refresh"\n  - app.type: { text: "x" }\n  - app.see: { request: "GET /api/points", timeoutMs: 200 }\n  - app.type: { text: "y" }\n  - app.see: { request: "GET /api/points", timeoutMs: 200 }\n',
    'hand.md',
  );
  const { base } = fakeApp();
  const device = await base.device();
  (device as unknown as { type: () => Promise<unknown> }).type = async () => ({});
  const report = await runCase(c, { base, config, fixtures });
  assert.deepEqual(
    report.steps.map((s) => s.status),
    ['passed', 'passed', 'passed', 'passed', 'passed', 'failed'],
  );
});

test('a report carries what the case says about itself', async () => {
  const c = parseCase(
    '---\nid: about\ntitle: Returning user\ndescription: >\n  The intro remembers the provider.\nwhy: A second account loses the balance.\ngiven: Google linked, fresh install.\nticket: LOG-12\n---\nsteps:\n  - app.see: { text: "Hello" }\nexpected: The intro says "last used".\n',
    'about.md',
  );
  const { base } = fakeApp();
  const report = await runCase(c, { base, config, fixtures });
  assert.deepEqual(report.about, {
    description: 'The intro remembers the provider.',
    why: 'A second account loses the balance.',
    given: 'Google linked, fresh install.',
    ticket: 'LOG-12',
    expected: 'The intro says "last used".',
  });
});

test('a host that waits for a still screen on its own clock is asked to, and the frame is taken again only if it changed', async () => {
  const c = parseCase('---\nid: still\n---\nsteps:\n  - app.see: { text: "Hello" }\n  - app.press: "#refresh"\n', 'still.md');
  for (const changed of [false, true]) {
    const { base } = fakeApp();
    const device = await base.device();
    (device as unknown as { server: { hello: unknown } }).server.hello = { native: true, commands: ['screenshot', 'still'] };
    const asked: { name: string; params: Record<string, unknown> }[] = [];
    let shots = 0;
    (device as unknown as { command: unknown }).command = async (name: string, params: Record<string, unknown>) => {
      asked.push({ name, params });
      if (name === 'screenshot') {
        shots++;
        fs.writeFileSync(String(params.path), `frame ${shots}`);
        return { path: params.path, signature: `s${shots}` };
      }
      if (name === 'still')
        return changed ? { still: false, changed: params.since === 's1', moving: [{ x: 1, y: 2, w: 3, h: 4 }] } : { still: true, changed: false };
      return {};
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-still-'));
    const began = Date.now();
    const report = await runCase(c, { base, config, fixtures, evidence: { dir, screenshots: true, stillMs: 300, frames: 'png' } });
    assert.equal(report.result, 'passed', report.steps.map((s) => s.error).join(' '));
    // No wall-clock wait of stillMs per frame.
    assert.ok(Date.now() - began < 600, `took ${Date.now() - began} ms`);
    const stills = asked.filter((a) => a.name === 'still');
    assert.equal(stills.length, 2);
    assert.equal(stills[0]?.params.stepMs, 300);
    assert.ok(asked.filter((a) => a.name === 'screenshot').every((a) => a.params.sign === true));
    assert.equal(shots, changed ? 3 : 2);
    const first = report.steps.find((s) => s.screenshot)!.screenshot!;
    const frame = JSON.parse(fs.readFileSync(first.replace(/\.png$/, '.json'), 'utf8'));
    // A screen that never stood still keeps what moved while the host waited.
    assert.equal(frame.still, !changed);
    assert.deepEqual(frame.moving, changed ? [{ x: 1, y: 2, w: 3, h: 4 }] : undefined);
  }
});

test('with frames on change and a still wait, the looks after a step run before its settle and share its frame', async () => {
  const c = parseCase(
    '---\nid: looks\n---\nsteps:\n  - app.press: "#refresh"\n  - app.see: { text: "25 points" }\n  - app.see: { text: "25 points" }\n',
    'looks.md',
  );
  for (const first of [true, false]) {
    const { base } = fakeApp();
    const device = await base.device();
    (device as unknown as { server: { hello: unknown } }).server.hello = { native: true, commands: ['screenshot'] };
    const order: string[] = [];
    (device as unknown as { command: unknown }).command = async (name: string, params: Record<string, unknown>) => {
      if (name === 'screenshot') {
        order.push('screenshot');
        fs.writeFileSync(String(params.path), 'frame');
        return { path: params.path };
      }
      return {};
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-looks-'));
    const report = await runCase(c, {
      base,
      config,
      fixtures,
      onStep: (p) => {
        if (p.status) order.push(`${p.step}:${p.status}`);
      },
      evidence: { dir, screenshots: true, settleMs: 1500, frames: 'png', ...(first ? { stillMs: 300, onChange: true } : {}) },
    });
    assert.equal(report.result, 'passed', report.steps.map((s) => s.error).join(' '));
    const shot = order.indexOf('screenshot');
    const lastSee = order.findLastIndex((o) => /see/.test(o));
    if (first) {
      assert.ok(shot > lastSee, order.join(' | '));
      assert.equal(report.steps[1]?.screenshot, report.steps[0]?.screenshot);
      assert.equal(report.steps[2]?.screenshot, report.steps[0]?.screenshot);
    } else assert.ok(shot < lastSee, order.join(' | '));
  }
});

test('a film made on another machine comes over a piece at a time, and a short one is left out', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-film-'));
  const film = Buffer.from('a film the host kept where the driver cannot read it');
  const host = (pieceBytes: number, lose = false) => ({
    command: async (_name: string, params?: unknown) => {
      const offset = (params as { read: number }).read;
      const piece = film.subarray(offset, offset + (lose && offset > 0 ? 0 : pieceBytes));
      return { data: piece.toString('base64'), done: offset + piece.length >= film.length };
    },
  });
  const whole = path.join(dir, 'video.mp4');
  assert.equal(await fetchFilm(host(7) as unknown as Pick<Device, 'command'>, whole, film.length), true);
  assert.deepEqual(fs.readFileSync(whole), film);
  const short = path.join(dir, 'short.mp4');
  assert.equal(await fetchFilm(host(7, true) as unknown as Pick<Device, 'command'>, short, film.length), false);
  assert.equal(fs.existsSync(short), false);
  assert.equal(fs.existsSync(`${short}.part`), false);
});

test('a swipe waits, on the wall clock, for a target that is still landing', async () => {
  const c = parseCase(
    `---
id: landing
---
steps:
  - app.swipe: { target: "#slide-to-confirm", direction: right, distance: 330 }
`,
    'landing.md',
  );
  const { base } = fakeApp();
  const device = await base.device();
  const fake = device as unknown as { server: { call: (method: string, params: never) => Promise<unknown> } };
  const call = fake.server.call;
  let looks = 0;
  let swipedWhileInert = false;
  let swipes = 0;
  // Inert for its first three looks, as a pager page arriving reads on a host whose clock runs ahead.
  const slider = () => ({
    i: 0,
    kind: 'view',
    testId: 'slide-to-confirm',
    frame: { x: 0, y: 600, w: 300, h: 60 },
    enabled: true,
    depth: 1,
    hidden: looks <= 3 ? 'inert' : undefined,
  });
  fake.server.call = async (method, params) => {
    if (method === 'find') {
      looks += 1;
      return slider();
    }
    if (method === 'swipe') {
      swipes += 1;
      if (looks <= 3) swipedWhileInert = true;
      return {};
    }
    return call(method, params);
  };
  const report = await runCase(c, { base, config, fixtures });
  assert.equal(report.result, 'passed', report.steps.map((s) => s.error).join(' '));
  assert.equal(swipes, 1);
  assert.equal(swipedWhileInert, false);
  assert.ok(looks >= 4);
});

// A native host whose window lists only part of the page; `below` is where the button sits, or undefined when it is never in the tree.
const longPage = async (below: number | undefined, scrolls: 'moves' | 'stuck') => {
  const { base } = fakeApp();
  const device = (await base.device()) as unknown as {
    server: { hello?: { native: boolean }; call: (method: string, params: never) => Promise<unknown> };
    screen: () => Promise<{ elements: unknown[] }>;
    waitFor: () => Promise<never>;
  };
  const listed = device.screen;
  const call = device.server.call;
  let swipes = 0;
  const button = (y: number) => ({ i: 9, kind: 'button', testId: 'how-it-works-button', enabled: true, depth: 0, frame: { x: 0, y, w: 100, h: 40 } });
  device.server.hello = { native: true };
  device.waitFor = async () => {
    throw new Error('Timed out');
  };
  device.server.call = async (method, params) => {
    if (method === 'swipe') {
      swipes += 1;
      return {};
    }
    if (method === 'find' && (params as { testId?: string }).testId === 'how-it-works-button')
      return below === undefined ? null : { ...button(below), hidden: 'behind-modal' };
    return call(method, params);
  };
  device.screen = async () => {
    const screen = await listed();
    const first = screen.elements[1] as { frame: { y: number } };
    if (scrolls === 'moves') first.frame.y = 50 + swipes;
    if (below !== undefined)
      screen.elements.push(
        { ...button(below), hidden: 'behind-modal' },
        { i: 10, kind: 'text', text: 'Footer', covered: true, enabled: true, depth: 0, frame: { x: 0, y: 0, w: 1, h: 1 } },
      );
    return screen;
  };
  return { base, swipes: () => swipes };
};

test('a failed see keeps the full listing, the scrolls it made and where its target was last seen', async () => {
  const c = parseCase('---\nid: found-below\n---\nsteps:\n  - app.see: { testId: how-it-works-button, timeoutMs: 100 }\n', 'found-below.md');
  const { base, swipes } = await longPage(2000, 'moves');
  const report = await runCase(c, { base, config, fixtures });
  const step = report.steps[0]!;
  assert.equal(step.status, 'failed');
  assert.ok(swipes() > 0);
  assert.match(step.error!, /^not on screen: .* \(found, below the window, hidden \(behind-modal\), after \d+ scrolls?\)$/);
  const looked = step.looked!;
  assert.match(looked.listing, /Footer.*~covered/);
  assert.match(looked.listing, /#how-it-works-button.*~behind-modal/);
  assert.equal(looked.scrollsTotal, swipes());
  assert.equal(looked.scrolls[0]?.direction, 'down');
  assert.equal(looked.scrolls[0]?.moved, true);
  assert.deepEqual(looked.scrolls[0]?.before, { count: 3, first: '#refresh @y=0', last: 'Footer @y=0' });
  assert.equal(looked.target?.found, true);
  assert.equal(looked.target?.last, 'below the window, hidden (behind-modal)');
});

test('a failed see says when the scrolls moved nothing and its target was never in the tree', async () => {
  const c = parseCase('---\nid: never\n---\nsteps:\n  - app.see: { testId: how-it-works-button, timeoutMs: 100 }\n', 'never.md');
  const { base } = await longPage(undefined, 'stuck');
  const report = await runCase(c, { base, config, fixtures });
  const step = report.steps[0]!;
  assert.match(step.error!, /\(never in the tree, after 2 scrolls\)$/);
  assert.deepEqual(
    step.looked?.scrolls.map((s) => [s.direction, s.moved]),
    [
      ['down', false],
      ['up', false],
    ],
  );
  assert.deepEqual(step.looked?.target, { found: false, seen: [{ atMs: step.looked!.target!.seen[0]!.atMs, scrolls: 0, state: 'not in the tree' }] });
});

test('a failed wait for a target keeps the listing and where the target stands', async () => {
  const c = parseCase('---\nid: wait-found\n---\nsteps:\n  - app.wait: { what: "#how-it-works-button", timeoutMs: 100 }\n', 'wait-found.md');
  const { base } = await longPage(2000, 'stuck');
  const report = await runCase(c, { base, config, fixtures });
  const step = report.steps[0]!;
  assert.equal(step.status, 'failed');
  assert.match(step.error!.split('\n')[0]!, /\(found, below the window, hidden \(behind-modal\)\)$/);
  assert.match(step.looked!.listing, /~behind-modal/);
  assert.deepEqual(step.looked!.scrolls, []);
  assert.equal(step.looked!.target?.last, 'below the window, hidden (behind-modal)');
});

test('a step that passes keeps no listing', async () => {
  const c = parseCase('---\nid: fine\n---\nsteps:\n  - app.see: { text: "Hello" }\n  - app.wait: { what: "#refresh" }\n', 'fine.md');
  const { base } = fakeApp();
  const report = await runCase(c, { base, config, fixtures });
  assert.deepEqual(
    report.steps.map((s) => s.looked),
    [undefined, undefined],
  );
});

// A field with focus and the keyboard over the button: the agent closes it before the press, so the runner does not wait.
const keyboardOver = async (focused: boolean) => {
  const { base, calls } = fakeApp();
  const device = (await base.device()) as unknown as {
    server: { call: (method: string, params: { testId?: string }) => Promise<unknown> };
    screen: () => Promise<{ elements: unknown[] }>;
  };
  const call = device.server.call;
  const listed = device.screen;
  device.server.call = async (method, params) => {
    const found = await call(method, params);
    return method === 'find' && params.testId === 'refresh' && found ? { ...(found as object), covered: true } : found;
  };
  device.screen = async () => {
    const screen = await listed();
    screen.elements.push({ i: 5, kind: 'input', testId: 'email', focused, enabled: true, depth: 0, frame: { x: 0, y: 100, w: 300, h: 40 } });
    return screen;
  };
  return { base, calls };
};

test('a press under the keyboard of a focused field goes ahead at once; a covered one without it waits its timeout', async () => {
  const c = parseCase('---\nid: kb\n---\nsteps:\n  - app.press: { target: "#refresh", timeoutMs: 400 }\n', 'kb.md');
  const typing = await keyboardOver(true);
  let started = Date.now();
  assert.equal((await runCase(c, { base: typing.base, config, fixtures })).result, 'passed');
  assert.ok(Date.now() - started < 300, `waited ${Date.now() - started} ms`);
  assert.ok(typing.calls.some((call) => call.method === 'press'));

  const covered = await keyboardOver(false);
  started = Date.now();
  await runCase(c, { base: covered.base, config, fixtures });
  assert.ok(Date.now() - started >= 400, `waited ${Date.now() - started} ms`);
});

test('a case starts with no mocks, and one that set a mock leaves none behind', async () => {
  for (const sets of [false, true]) {
    const steps = sets ? '  - app.mock: { route: "GET /api/points", status: 500 }\n  - app.see: { text: "Hello" }\n' : '  - app.see: { text: "Hello" }\n';
    const c = parseCase(`---\nid: mocks\n---\nsteps:\n${steps}`, 'mocks.md');
    const { base } = fakeApp();
    const device = await base.device();
    const asked: string[] = [];
    (device as unknown as { command: unknown }).command = async (name: string, params: { action?: string }) => {
      asked.push(`${name}:${params?.action ?? ''}`);
      return {};
    };
    const report = await runCase(c, { base, config, fixtures });
    assert.equal(report.result, 'passed', report.steps.map((s) => s.error).join(' '));
    assert.equal(asked[0], 'netmock:clear');
    assert.deepEqual(asked.slice(1), sets ? ['netmock:add', 'netmock:list', 'netmock:clear'] : []);
  }
});

test('a mock rule nothing matched is a warning naming what went to the network instead', async () => {
  const c = parseCase('---\nid: feed\n---\nsteps:\n  - app.mock: { route: "GET /v1/feed.json", status: 200 }\n  - app.press: "#refresh"\n', 'feed.md');
  const { base, requests } = fakeApp();
  const device = await base.device();
  (device as unknown as { command: unknown }).command = async (name: string, params: { action?: string }) =>
    name === 'netmock' && params?.action === 'list'
      ? {
          rules: [
            { method: 'GET', path: '/v1/feed.json', hits: 0 },
            { method: '*', path: '/used', hits: 2 },
          ],
          holds: [],
        }
      : {};
  const press = device.press;
  device.press = async (params) => {
    requests.push({ id: requests.length + 1, method: 'GET', url: 'http://x/v1/api.json?rss=1', status: 200, startedAt: 0 });
    return press(params);
  };
  const report = await runCase(c, { base, config, fixtures });
  assert.equal(report.result, 'passed');
  assert.deepEqual(report.warnings, ['mock rule GET /v1/feed.json never matched; GET /v1/api.json, GET /api/points went to the network']);
});

test('an on block inside a macro runs on the hosts it names, in steps and in teardown, and a teardown that fails is said', async () => {
  const macros = {
    'app.x': [
      { on: 'headless', do: [{ 'app.press': '#refresh' }] },
      { on: 'device', do: { 'app.press': '#never' } },
    ],
    'app.broken': [{ no_such_fixture: {} }],
  };
  const c = parseCase('---\nid: on-macro\n---\nsteps:\n  - app.x: {}\nteardown:\n  - app.x: {}\n  - app.broken: {}\n', 'on-macro.md');
  const { base, calls } = fakeApp();
  const report = await runCase(c, { base, config: { ...config, macros }, fixtures });
  assert.equal(report.result, 'passed', report.steps.map((s) => s.error).join(' '));
  assert.deepEqual(
    calls.filter((x) => x.method === 'press').map((x) => (x.params as { testId?: string }).testId),
    ['refresh', 'refresh'],
  );
  assert.equal(report.warnings?.length, 1);
  assert.match(report.warnings![0]!, /^teardown app\.broken failed: /);
});

test('a target written as a bare number is an index', async () => {
  const c = parseCase('---\nid: index\n---\nsteps:\n  - app.press: 0\n  - app.see: 1\n', 'index.md');
  const { base, calls } = fakeApp();
  const device = await base.device();
  device.server.call = (async (method: string, params: { i?: number; testId?: string }) => {
    calls.push({ method, params });
    if (method === 'find') return (await device.screen()).elements.find((e) => e.i === params.i) ?? null;
    return null;
  }) as typeof device.server.call;
  const report = await runCase(c, { base, config, fixtures });
  assert.equal(report.result, 'passed', report.steps.map((s) => s.error).join(' '));
  assert.equal((calls.find((x) => x.method === 'press')?.params as { i?: number } | undefined)?.i, 0);
});

test('see contains finds a text inside a longer one, where a target matches a whole text', async () => {
  const { base } = fakeApp();
  const device = await base.device();
  const screen = device.screen;
  device.screen = async () => {
    const sc = await screen();
    sc.elements.push({
      i: 2,
      kind: 'text',
      text: 'Toggle. Renders a boolean input. Use it for settings.',
      enabled: true,
      depth: 0,
      frame: { x: 0, y: 80, w: 300, h: 60 },
    });
    return sc;
  };
  // As the agent matches a text target: the whole text, whatever its case.
  device.server.call = (async (method: string, params: { text?: string }) =>
    method === 'find'
      ? ((await device.screen()).elements.find((e) => e.text?.toLowerCase() === params.text?.toLowerCase()) ?? null)
      : null) as typeof device.server.call;
  const whole = parseCase('---\nid: whole\n---\nsteps:\n  - app.see: { target: "renders a boolean input.", timeoutMs: 100 }\n', 'whole.md');
  assert.equal((await runCase(whole, { base, config, fixtures })).result, 'failed');
  const part = parseCase(
    '---\nid: part\n---\nsteps:\n  - app.see: { target: "renders a boolean input.", contains: true }\n  - app.see: { target: "nowhere", contains: true, absent: true }\n',
    'part.md',
  );
  const report = await runCase(part, { base, config, fixtures });
  assert.equal(report.result, 'passed', report.steps.map((s) => s.error).join(' '));
});

test('app.call waits for a command an app that just attached has not registered yet', async () => {
  const c = parseCase('---\nid: call\n---\nsteps:\n  - app.call: { command: signOut }\n', 'call.md');
  const { base } = fakeApp();
  const device = await base.device();
  let asked = 0;
  (device as unknown as { attachedAt: number }).attachedAt = Date.now();
  (device as unknown as { command: unknown }).command = async (name: string) => {
    if (name !== 'signOut') return {};
    asked += 1;
    if (asked < 3) throw new Error('Unknown method signOut');
    return { ok: true };
  };
  const report = await runCase(c, { base, config, fixtures });
  assert.equal(report.result, 'passed', report.steps.map((s) => s.error).join(' '));
  assert.equal(asked, 3);

  // One that attached long ago will not register it: unsupported at once.
  (device as unknown as { attachedAt: number }).attachedAt = Date.now() - 60_000;
  asked = -100;
  const started = Date.now();
  assert.equal((await runCase(c, { base, config, fixtures })).result, 'unsupported');
  assert.ok(Date.now() - started < 500);
});

test("app.relaunch starts the run's own host again, or mounts the app again on a host it did not start", async () => {
  const c = parseCase('---\nid: relaunch\n---\nsteps:\n  - app.relaunch\n  - app.see: { text: "Hello" }\n', 'relaunch.md');
  const { base } = fakeApp();
  const device = await base.device();
  const commands: string[] = [];
  (device as unknown as { command: unknown }).command = async (name: string) => {
    commands.push(name);
    return {};
  };
  let restarted = 0;
  assert.equal(
    (
      await runCase(c, {
        base,
        config,
        fixtures,
        relaunch: async () => {
          restarted += 1;
        },
      })
    ).result,
    'passed',
  );
  assert.equal(restarted, 1);
  assert.ok(!commands.includes('reset'));
  assert.equal((await runCase(c, { base, config, fixtures })).result, 'passed');
  assert.ok(commands.includes('reset'));
  (device as unknown as { command: unknown }).command = async (name: string) => {
    if (name === 'reset') throw new Error('no command reset registered; registered: none');
    return {};
  };
  const report = await runCase(c, { base, config, fixtures });
  assert.equal(report.result, 'unsupported');
  assert.match(report.steps[0]!.error!, /host_command/);
});

test('a phone covered by a view the app did not draw is relaunched before the first step, and the case says so', async () => {
  const c = parseCase('---\nid: covered\n---\nsteps:\n  - app.see: { text: "Hello" }\n', 'covered.md');
  const { base } = fakeApp();
  const device = await base.device();
  let system = true;
  let relaunched = 0;
  (device.server as unknown as { hello: unknown }).hello = { native: true, commands: [] };
  const screen = device.screen;
  device.screen = async () => ({ ...(await screen()), ...(system ? { system: { frame: { x: 0, y: 500, w: 390, h: 300 } } } : {}) });
  (device as unknown as { relaunch: unknown }).relaunch = async () => {
    relaunched += 1;
    system = false;
  };
  const report = await runCase(c, { base, config, fixtures });
  assert.equal(report.result, 'passed', report.steps.map((s) => s.error).join(' '));
  assert.equal(relaunched, 1);
  assert.match(report.warnings?.[0] ?? '', /did not draw covered it before the first step.*relaunched the app/);
});

test('a dry run lists every step, each macro opened into its own', () => {
  const c = parseCase('---\nid: dry\n---\nsetup:\n  - create_user: { as: u }\nsteps:\n  - app.login: { as: u, wait: Home }\n  - app.tap: "#x"\n', 'dry.md');
  const macros = {
    'app.login': [
      { 'app.call': { command: 'reset' } },
      { on: 'headless', do: [{ 'app.press': '#a' }] },
      { when: 'wait', do: { 'app.wait': '{{param.wait}}' } },
    ],
  };
  assert.deepEqual(expandSteps(c, { macros }), [
    '  setup:',
    '    1. create_user as: u',
    '  steps:',
    '    2. app.login as: u, wait: Home',
    '         ↳ app.call command: reset',
    '         ↳ [on headless] app.press #a',
    '         ↳ [when wait] app.wait Home',
    '    3. app.tap #x  ✗ app.tap is not a step: Lynkeus has no command tap, and the project declares no macro for it',
  ]);
});

test('a frame after a press waits for the commit the press caused, not only for a quiet app', async () => {
  const c = parseCase('---\nid: frame\n---\nsteps:\n  - app.press: "#refresh"\n  - app.see: { text: "25 points" }\n', 'frame.md');
  const { base } = fakeApp();
  const device = await base.device();
  const idles: unknown[] = [];
  device.idle = async (params) => {
    idles.push(params);
    return { commit: params?.after === undefined ? 1 : 2, idle: true };
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-frame-'));
  await runCase(c, { base, config, fixtures, evidence: { dir, screenshots: true, settleMs: 150, frames: 'png' } });
  // The screen read before the press was at commit 1; the frame's wait is for a commit past it. A look takes none.
  assert.deepEqual(
    idles.filter((p) => (p as { quietMs?: number }).quietMs === 150),
    [
      { quietMs: 150, timeoutMs: 1000, after: 1 },
      { quietMs: 150, timeoutMs: 1000 },
    ],
  );
});

test('a frame after a press that rendered nothing is of the quiet screen', async () => {
  const c = parseCase('---\nid: nothing\n---\nsteps:\n  - app.press: "#refresh"\n', 'nothing.md');
  const { base } = fakeApp();
  const device = await base.device();
  const idles: unknown[] = [];
  device.idle = async (params) => {
    idles.push(params);
    // Nothing past commit 1 ever arrives.
    return { commit: 1, idle: params?.after === undefined };
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-nothing-'));
  await runCase(c, { base, config, fixtures, evidence: { dir, screenshots: true, settleMs: 150, frames: 'png' } });
  assert.deepEqual(
    idles.filter((p) => (p as { quietMs?: number }).quietMs === 150),
    [
      { quietMs: 150, timeoutMs: 1000, after: 1 },
      { quietMs: 150, timeoutMs: 1000 },
    ],
  );
});

test('a wait for a request says it wants a 2xx, and what the request answered instead', async () => {
  const c = parseCase('---\nid: request\n---\nsteps:\n  - app.wait: { request: "GET /api/orders", timeoutMs: 100 }\n', 'request.md');
  const { base, requests } = fakeApp();
  const device = await base.device();
  const requestsOf = device.requests;
  let asked = 0;
  // Sent after the step began, which is where a wait for a request starts counting.
  device.requests = async (since) => {
    if (++asked > 1 && !requests.some((r) => r.url.endsWith('/orders')))
      requests.push({ id: requests.length + 1, method: 'GET', url: 'http://x/api/orders', status: 500, startedAt: 0 });
    return requestsOf(since);
  };
  const report = await runCase(c, { base, config, fixtures });
  assert.match(report.steps[0]?.error ?? '', /^no 2xx GET \/api\/orders within 100 ms; it answered 500 — .*pass status/);
});

test('a text check finds a text drawn in capitals by the words the source writes', async () => {
  const c = parseCase('---\nid: caps\n---\nsteps:\n  - app.see: { text: "hello" }\n  - app.see: { text: "HELLO", absent: true, timeoutMs: 50 }\n', 'caps.md');
  const { base } = fakeApp();
  const report = await runCase(c, { base, config, fixtures });
  assert.deepEqual(
    report.steps.map((s) => s.status),
    ['passed', 'failed'],
  );
});

test('on a simulator or emulator a case asked to film is filmed by the OS, and each app step says its second in the film', async () => {
  const { base } = fakeApp();
  const device = (await base.device()) as unknown as { server: { hello?: unknown }; recordVideo?: (file: string) => Promise<unknown> };
  device.server.hello = { native: true, commands: [] };
  const filmed: string[] = [];
  let stopped = false;
  device.recordVideo = async (file: string) => {
    filmed.push(file);
    return {
      file,
      startedAt: Date.now() - 1500,
      stop: async () => {
        stopped = true;
        fs.writeFileSync(file, 'film');
        return true;
      },
    };
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-film-'));
  const c = parseCase('---\nid: film\n---\nsteps:\n  - app.press: "#refresh"\n', 'film.md');
  const report = await runCase(c, { base, config, fixtures, evidence: { dir, video: { fps: 30 } } });
  assert.deepEqual(filmed, [path.join(dir, 'video.mp4')]);
  assert.ok(stopped);
  assert.equal(report.video, path.join(dir, 'video.mp4'));
  assert.ok((report.steps[0]!.videoS ?? 0) >= 1.5, `step began at ${report.steps[0]!.videoS}`);
  // A run that started its own host never films whatever Simulator happens to be booted.
  filmed.length = 0;
  await runCase(c, { base, config, fixtures, evidence: { dir, video: { fps: 30 } }, ownHost: true });
  assert.deepEqual(filmed, []);
});

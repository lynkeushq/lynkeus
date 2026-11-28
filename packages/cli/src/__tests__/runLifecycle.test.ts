import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { caseCommands, describe } from '../commands/cases.js';
import { driveCommands } from '../commands/drive.js';
import { osCommands } from '../commands/os.js';
import { AgentError } from 'lynkeus-client';

import { attachFailureCheck, attachedCheck } from '../commands/headless.js';
import { claimPorts } from '../cases/portClaim.js';
import { lastRunFile, statusOf } from '../cases/progress.js';
import type { CaseReport } from '../cases/runner.js';
import type { Device } from '../device/driver.js';
import { type Base, register } from '../registry.js';
import { execute } from '../runtime.js';

register([...driveCommands, ...osCommands, ...caseCommands]);

let nextPort = 19_300 + (process.pid % 200);

/** A project with one case that waits on an app that never answers: a run of it goes on until it is stopped. */
const project = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-lifecycle-'));
  fs.mkdirSync(path.join(root, 'cases'));
  fs.writeFileSync(
    path.join(root, 'cases', 'slow.md'),
    '---\nid: slow\n---\nsteps:\n  - app.wait: { what: "#never", timeoutMs: 600000 }\n  - app.press: "#after"\n',
  );
  const port = nextPort++;
  const pressed: unknown[] = [];
  let free: () => void = () => undefined;
  const hanging = new Promise<never>((_, reject) => {
    free = () => reject(new Error('freed'));
  });
  hanging.catch(() => undefined);
  const device = {
    server: { connected: true, hello: null, port, call: async () => null },
    screen: async () => ({ route: 'Home', path: ['Home'], commit: 1, busy: false, window: { w: 390, h: 844 }, costMs: 1, elements: [] }),
    trace: async () => ({ last: 0, events: [] }),
    requests: async () => ({ inFlight: 0, requests: [] }),
    waitFor: () => hanging,
    idle: async () => ({ idle: true }),
    press: async (params: unknown) => pressed.push(params),
    command: async () => ({}),
  } as unknown as Device;
  const base: Base = {
    root,
    config: { port, cases: { dir: 'cases' } },
    attached: true,
    err: () => undefined,
    graph: () => {
      throw new Error('no graph');
    },
    device: async () => device,
  };
  return { root, port, base, pressed, free };
};

const until = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  assert.ok(check(), 'it did not happen in time');
};

const running = (root: string) => {
  try {
    const progress = (JSON.parse(fs.readFileSync(lastRunFile(root), 'utf8')) as { progress: string }).progress;
    return statusOf(progress).running.length > 0;
  } catch {
    return false;
  }
};

test('an MCP client cancelling case_run stops it at once: its port is let go and case status says it was stopped', async () => {
  const p = project();
  const caller = new AbortController();
  const run = execute(['case', 'run', '--once'], { ...p.base, signal: caller.signal });
  await until(() => running(p.root));
  const t0 = Date.now();
  caller.abort();
  const outcome = await run;
  assert.ok(Date.now() - t0 < 2000, 'the run answered while its step still waited');
  assert.equal(outcome.code, 130);
  assert.match(
    outcome.text ?? '',
    /⏹ stopped \(the caller cancelled case run\) after 0 of 1 cases; no step starts after it, any host it started is stopped and its ports are let go/,
  );
  const claim = claimPorts([p.port]);
  assert.ok('release' in claim, 'the port is free for the next run');
  claim.release();
  const progress = (JSON.parse(fs.readFileSync(lastRunFile(p.root), 'utf8')) as { progress: string }).progress;
  const status = statusOf(progress);
  assert.equal(status.state, 'stopped');
  assert.equal(status.stoppedBy, 'the caller cancelled case run');
  // The case on the app starts no other step once its wait ends.
  p.free();
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(p.pressed, []);
});

test('a second case run on the port a run is driving is refused, naming it and how to stop it; case stop stops it', async () => {
  const p = project();
  const first = execute(['case', 'run', '--once'], p.base);
  await until(() => running(p.root));
  const second = await execute(['case', 'run', '--once'], p.base);
  assert.equal(second.code, 1);
  assert.match(second.text ?? '', new RegExp(`^port ${p.port} is driving the app for another case run of this Lynkeus, still going: slow, started `));
  assert.match(second.text ?? '', /stop it \(case stop; case_stop over MCP\)/);
  const stopped = await execute(['case', 'stop'], p.base);
  assert.match(stopped.text ?? '', /^stopped: slow, started /);
  const outcome = await first;
  assert.equal(outcome.code, 130);
  assert.match(outcome.text ?? '', /⏹ stopped \(stopped with case stop\)/);
  const status = await execute(['case', 'status'], p.base);
  assert.match(status.text ?? '', /^stopped \(stopped with case stop\): 0 of 1 cases done/);
  p.free();
});

test('a run stops when another process asks it to with case stop', async () => {
  const p = project();
  const run = execute(['case', 'run', '--once'], p.base);
  await until(() => running(p.root));
  const { stop } = JSON.parse(fs.readFileSync(lastRunFile(p.root), 'utf8')) as { stop: string };
  // What `case stop` leaves when the run is not in its own process.
  fs.writeFileSync(stop, '');
  const outcome = await run;
  assert.equal(outcome.code, 130);
  assert.match(outcome.text ?? '', /⏹ stopped \(stopped with case stop\)/);
  assert.equal(fs.existsSync(stop), false);
  p.free();
});

test('a step that runs past its timeout and the margin, or past the ceiling, fails as stuck and the case goes on to its end', async () => {
  const p = project();
  // The project's ceiling stands in for the default 180 s; a step naming its own timeout gets that plus 30 s.
  p.base.config.cases = { dir: 'cases', stepCeilingMs: 300 };
  fs.writeFileSync(path.join(p.root, 'cases', 'slow.md'), '---\nid: slow\n---\nsteps:\n  - app.wait: "#never"\n  - app.press: "#after"\n');
  const t0 = Date.now();
  const outcome = await execute(['case', 'run', '--once'], p.base);
  assert.ok(Date.now() - t0 < 3000, `the run took ${Date.now() - t0} ms`);
  assert.equal(outcome.code, 1, JSON.stringify(outcome));
  assert.match(outcome.text ?? '', /app\.wait #never: still running after 0\.3 s \(the step ceiling, cases\.stepCeilingMs\), so it was given up/);
  assert.deepEqual(p.pressed, [], 'no step runs after the stuck one');
  p.free();
});

test('a run held to a budget stops when it runs out and names the cases it did not reach', async () => {
  const p = project();
  fs.writeFileSync(path.join(p.root, 'cases', 'later.md'), '---\nid: later\n---\nsteps:\n  - app.press: "#x"\n');
  const t0 = Date.now();
  const outcome = await execute(
    ['case', 'run', '--once', '--in-order', '--budget', '1', path.join(p.root, 'cases', 'slow.md'), path.join(p.root, 'cases', 'later.md')],
    p.base,
  );
  const took = Date.now() - t0;
  assert.ok(took >= 900 && took < 3000, `the run took ${took} ms`);
  assert.equal(outcome.code, 130);
  assert.match(outcome.text ?? '', /⏹ stopped \(the run's budget of 1 s ran out\) after 0 of 2 cases/);
  assert.match(outcome.text ?? '', /not run: slow, later; run them in another call \(name their files\), or give budget more seconds/);
  p.free();
});

test('case_run over MCP is held to 1500 s unless the caller gives a budget', async () => {
  const { argvFor } = await import('../mcp/server.js');
  const run = caseCommands.find((c) => c.name === 'case run')!;
  assert.deepEqual(argvFor(run, {}).slice(-2), ['--budget', '1500']);
  assert.deepEqual(argvFor(run, { budget: 0 }).slice(-2), ['--budget', '0']);
});

test('case status of a run that goes on says how to stop it', async () => {
  const p = project();
  const run = execute(['case', 'run', '--once'], p.base);
  await until(() => running(p.root));
  const status = await execute(['case', 'status'], p.base);
  assert.match(status.text ?? '', /^running: 0 of 1 cases done/);
  assert.match(status.text ?? '', /to stop it: `lynkeus case stop` \(case_stop over MCP\)/);
  await execute(['case', 'stop'], p.base);
  await run;
  p.free();
});

test("a failed case's summary carries the failing step's own error, whatever the evidence says", () => {
  const report: CaseReport = {
    id: 'docs',
    file: 'docs.md',
    result: 'failed',
    ms: 10_400,
    steps: [
      { step: 'app.wait #home', status: 'passed', ms: 100 },
      { step: 'wait_for_backend', status: 'failed', ms: 10_000, error: 'no 2xx GET /v1/api.json within 10000 ms' },
      { step: 'app.press #go', status: 'skipped', ms: 0 },
    ],
    evidence: { why: '  (nothing in the evidence explains it: the screen, requests and trace look ordinary)' },
  };
  const text = describe(report);
  assert.match(text, /— failed at step 2 of 3: wait_for_backend\n {4}no 2xx GET \/v1\/api\.json within 10000 ms\n— why:/);
});

test('status names the app from its latest hello, and an app that left as gone', () => {
  assert.deepEqual(attachedCheck({ event: 'hello', protocolVersion: 2, platform: 'android', native: true, commands: [] }, 'open the app'), {
    what: 'an app is attached (android)',
    ok: true,
  });
  assert.equal(
    attachedCheck({ event: 'hello', protocolVersion: 2, platform: 'ios', native: true, commands: [], app: { name: 'Shop' } }, 'x').what,
    'an app is attached (Shop, ios)',
  );
  assert.deepEqual(attachedCheck(null, 'open the app'), {
    what: 'an app is attached',
    ok: false,
    fix: 'the app that was attached is gone (crashed or closed): start it again; open the app',
  });
});

test('status says a port another run holds, as screen does, and keeps the generic line for any other failure', () => {
  const taken = new AgentError(
    'Port 8123 is already taken: another Lynkeus run is probably still driving the app there. Stop it, or use another port (LYNKEUS_PORT, --ports).',
    'port-in-use',
  );
  assert.deepEqual(attachFailureCheck(taken, 8123, 'open the app'), { what: taken.message, ok: false });
  assert.deepEqual(attachFailureCheck(new Error('boom'), 8123, 'open the app'), {
    what: 'an app is attached (Lynkeus listens on port 8123)',
    ok: false,
    fix: 'open the app',
  });
});

test('status names the process holding the port, and an app refused for another token', () => {
  const taken = new AgentError('Port 8123 is already taken: …', 'port-in-use');
  assert.deepEqual(attachFailureCheck(taken, 8123, 'open the app', 'port 8123 is taken by pid 1 (x)'), { what: 'port 8123 is taken by pid 1 (x)', ok: false });
  const refused = attachFailureCheck(new AgentError('No app attached…', 'wrong-token'), 8123, 'open the app');
  assert.equal(refused.ok, false);
  assert.match(refused.what, /dialed in with another project's token and was refused/);
  assert.match(refused.fix ?? '', /this project's development build/);
});

const SCREEN = {
  route: 'Home',
  path: ['Home'],
  commit: 1,
  busy: false,
  window: { w: 390, h: 844 },
  costMs: 1,
  elements: [{ i: 0, kind: 'button', testId: 'go', enabled: true, depth: 0, frame: { x: 0, y: 0, w: 100, h: 40 } }],
};

/** An app whose server is as given and whose calls fail with `error`; it counts the screens read from it. */
const unreachableApp = (server: Record<string, unknown>, error: string) => {
  let screens = 0;
  const fail = async () => {
    throw new Error(error);
  };
  const device = {
    server: { ...server, call: fail },
    screen: async () => {
      screens += 1;
      return SCREEN;
    },
    trace: async () => ({ last: 0, events: [] }),
    requests: async () => ({ inFlight: 0, requests: [] }),
    waitFor: fail,
    press: fail,
    idle: async () => ({ idle: true }),
    command: async () => ({}),
  } as unknown as Device;
  const base: Base = {
    root: os.tmpdir(),
    config: {},
    attached: true,
    err: () => undefined,
    graph: () => {
      throw new Error('no graph');
    },
    device: async () => device,
  };
  return { base, screens: () => screens };
};

test('a case on an app that crashed fails saying it is gone, without reading evidence from it', async () => {
  const { runCase } = await import('../cases/runner.js');
  const { parseCase } = await import('../cases/format.js');
  const c = parseCase('---\nid: gone\n---\nsteps:\n  - app.press: "#go"\n  - app.press: "#next"\n', 'gone.md');
  const app = unreachableApp(
    { connected: false, gone: true, hello: null, appState: 'active' },
    'the app is gone (crashed or closed): it disconnected 3.0 s ago and has not dialed back in',
  );
  const report = await runCase(c, { base: app.base, config: {} });
  assert.equal(report.result, 'failed');
  assert.match(report.steps[0]?.error ?? '', /^the app is gone \(crashed or closed\)/);
  assert.equal(report.steps[1]?.status, 'skipped');
  assert.equal(report.evidence?.why, '  • the app is gone (crashed or closed)');
  assert.equal(app.screens(), 0);
});

test('a case whose app went behind another app says so, and does not wait out a read of each piece of evidence', async () => {
  const { runCase } = await import('../cases/runner.js');
  const { parseCase } = await import('../cases/format.js');
  const c = parseCase('---\nid: away\n---\nsteps:\n  - app.wait: { what: "#home", timeoutMs: 100 }\n', 'away.md');
  const app = unreachableApp(
    { connected: true, gone: false, appState: 'background', hello: { native: true, commands: [], platform: 'ios' } },
    'waitFor timed out after 2100ms: the app went to the background (another app is in front)',
  );
  const report = await runCase(c, { base: app.base, config: {} });
  assert.match(report.steps[0]?.error ?? '', /the app went to the background \(another app is in front\)/);
  assert.equal(report.evidence?.why, '  • the app went to the background (another app is in front)');
  assert.equal(app.screens(), 0);
});

test('why reads about the last case run, not a command that failed before it', async () => {
  const { scopeWhy } = await import('../runtime.js');
  const now = Date.now();
  const asked: unknown[] = [];
  const port = nextPort++;
  const device = {
    server: { connected: true, hello: null, port },
    screen: async () => SCREEN,
    requests: async () => ({ inFlight: 0, requests: [] }),
    trace: async (since?: number) => {
      asked.push(since);
      return {
        last: 2,
        events: [
          { seq: 1, t: now - 5 * 60_000, kind: 'command', method: 'signOut', ms: 1, error: 'Unknown method signOut' },
          { seq: 2, t: now - 100, kind: 'route', route: 'Home', path: ['Home'] },
        ].filter((e) => since === undefined || e.seq > since),
      };
    },
  } as unknown as Device;
  const base: Base = { root: os.tmpdir(), config: {}, attached: true, err: () => undefined, graph: () => ({}) as never, device: async () => device };
  const unscoped = await execute(['why'], base);
  assert.match(unscoped.text ?? '', /the last command that failed was signOut/);
  scopeWhy(port, { at: now - 1000, case: 'login', failed: 'app.press #go: No element matches {"testId":"go"}' });
  const scoped = await execute(['why'], base);
  assert.match(scoped.text ?? '', /^the last case \(login\) failed at app\.press #go: No element matches/);
  assert.doesNotMatch(scoped.text ?? '', /signOut/);
  scopeWhy(port, { at: now - 1000, since: 1, case: 'login' });
  await execute(['why'], base);
  assert.equal(asked.at(-1), 1);
});

test('a case run on a FastSim bundle older than the app, with no fastsim-bundle at hand, is refused before any host starts', async () => {
  const p = project();
  const bundle = path.join(p.root, '.lynkeus', 'fastsim-ios');
  fs.mkdirSync(bundle, { recursive: true });
  fs.writeFileSync(path.join(bundle, 'app.hbc'), '');
  fs.utimesSync(path.join(bundle, 'app.hbc'), 1000, 1000);
  fs.writeFileSync(path.join(p.root, 'index.js'), '');
  const outcome = await execute(['case', 'run', '--once', '--host-command', `/nowhere/bin/fastsim-run ${bundle} {port}`, '--ports', String(p.port)], p.base);
  assert.equal(outcome.code, 1);
  assert.match(outcome.text ?? '', /^the FastSim bundle at .*fastsim-ios is older than index\.js, and no fastsim-bundle is beside/);
  assert.match(outcome.text ?? '', /\n {2}<FastSim folder>\/bin\/fastsim-bundle .* ios$/);
  assert.equal(fs.existsSync(path.join(bundle, 'hosts')), false);
  p.free();
});

test('why reads the case of the attached app’s platform, not the other app on the same port', async () => {
  const { scopeWhy } = await import('../runtime.js');
  const port = 8123;
  const now = Date.now();
  scopeWhy(port, { at: now - 1000, case: 'login', failed: 'app.press #go: ios broke' }, 'ios');
  scopeWhy(port, { at: now - 500, case: 'checkout', failed: 'app.press #pay: android broke' }, 'android');
  const on = (platform: string) =>
    ({
      server: { port, hello: { platform } },
      screen: async () => ({ route: 'Home', elements: [] }),
      requests: async () => ({ requests: [], inFlight: 0 }),
      trace: async () => ({ events: [] }),
    }) as unknown as Device;
  const base = (platform: string): Base => ({
    root: os.tmpdir(),
    config: {},
    attached: true,
    err: () => undefined,
    graph: () => ({}) as never,
    device: async () => on(platform),
  });
  assert.match((await execute(['why'], base('ios'))).text ?? '', /^the last case \(login\) failed at app\.press #go: ios broke/);
  assert.match((await execute(['why'], base('android'))).text ?? '', /^the last case \(checkout\) failed at app\.press #pay: android broke/);
  const picked = (await execute(['why', '--on', 'ios'], base('android'))).text ?? '';
  assert.match(picked, /case is ios's/);
  assert.match(picked, /the last case \(login\) failed/);
});

test('why with no target explains the last failed case of the last run on its own lane, a FastSim host gone since', async () => {
  const { runCase } = await import('../cases/runner.js');
  const { parseCase } = await import('../cases/format.js');
  const { noteRunStart } = await import('../runtime.js');
  const fastsim = {
    server: { connected: true, hello: { platform: 'ios', native: true, commands: ['clock'] }, port: nextPort++, call: async () => null },
    info: { type: 'host' },
    screen: async () => SCREEN,
    trace: async () => ({ last: 0, events: [] }),
    requests: async () => ({ inFlight: 0, requests: [] }),
    waitFor: async () => undefined,
    idle: async () => ({ idle: true }),
    command: async () => ({}),
  } as unknown as Device;
  const onHost: Base = { root: os.tmpdir(), config: {}, attached: true, err: () => undefined, graph: () => ({}) as never, device: async () => fastsim };
  const ended = noteRunStart();
  const report = await runCase(parseCase('---\nid: podcast\n---\nsteps:\n  - app.see: { target: "#episodes", timeoutMs: 50 }\n', 'podcast.md'), {
    base: onHost,
    config: {},
  });
  ended();
  assert.equal(report.result, 'failed');
  let read = 0;
  const simulator = {
    server: { connected: true, hello: { platform: 'ios', native: true, commands: [] }, port: nextPort++ },
    screen: async () => {
      read += 1;
      return SCREEN;
    },
    requests: async () => ({ inFlight: 0, requests: [] }),
    trace: async () => ({ last: 0, events: [] }),
  } as unknown as Device;
  const attached: Base = { ...onHost, device: async () => simulator };
  const why = await execute(['why'], attached);
  assert.equal(why.lane, 'FastSim iOS');
  assert.match(why.text ?? '', /^the last failed case of the last run \(podcast, on FastSim iOS\) failed at app\.see/);
  assert.match(why.text ?? '', /as the run read it at the failure/);
  assert.equal(read, 0);
  assert.match((await execute(['why', '--on', 'fastsim:ios'], attached)).text ?? '', /\(podcast, on FastSim iOS\)/);
  assert.match((await execute(['why', '--on', 'headless'], attached)).text ?? '', /^the last run failed nothing on headless \(1 case\(s\) on FastSim iOS\)/);
  assert.equal((await execute(['why', '--on', 'watch'], attached)).code, 2);
  // A command given after the run is what why explains then, on the attached app.
  await execute(['see', '#nothing'], attached);
  const after = await execute(['why'], attached);
  assert.equal(after.lane, undefined);
  assert.doesNotMatch(after.text ?? '', /podcast/);
});

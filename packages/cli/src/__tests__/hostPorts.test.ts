import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { AgentError } from 'lynkeus-client';

import { freePorts } from '../cases/portClaim.js';
import { hostsFileOf, stopLeftHosts } from '../cases/hostPids.js';
import { PROGRESS_FILE } from '../cases/progress.js';
import { caseCommands } from '../commands/cases.js';
import { ciCommands, runSuite, suiteArgs } from '../commands/ci.js';
import { type Base, register } from '../registry.js';
import { execute } from '../runtime.js';

register([...caseCommands, ...ciCommands]);

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A project whose kept hosts write their pid to `pids/` and sleep, and whose driver for any port answers `connect`. */
const project = (connect: () => Promise<never>) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-hostports-'));
  fs.mkdirSync(path.join(root, 'cases'));
  fs.mkdirSync(path.join(root, 'pids'));
  fs.writeFileSync(path.join(root, 'cases', 'one.md'), '---\nid: one\n---\nsteps:\n  - app.press: "#x"\n');
  let probes = 0;
  const base: Base = {
    root,
    config: { cases: { dir: 'cases' } },
    attached: true,
    err: () => undefined,
    graph: () => {
      throw new Error('no graph');
    },
    device: connect,
    forPort: () => {
      probes++;
      return { base: { ...base, device: connect }, stop: async () => undefined };
    },
  };
  const hostPids = () => fs.readdirSync(path.join(root, 'pids')).map(Number);
  return { root, base, probes: () => probes, hostPids };
};

const listening = async (): Promise<{ port: number; close: () => Promise<void> }> => {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  return { port, close: () => new Promise((resolve) => server.close(() => resolve())) };
};

const HOST = 'echo $$ > pids/$$; exec sleep 30';

test('a kept host whose driver port another process holds fails the run fast, without a probe storm, and is stopped', async () => {
  const [port] = await freePorts(1, 19_700 + (process.pid % 200));
  // The refusal comes once the host is running, so the test sees it stopped and not merely never started.
  const p = project(async () => {
    const end = Date.now() + 2000;
    while (p.hostPids().length === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    throw new AgentError(`Port ${port} is already taken`, 'port-in-use');
  });
  const t0 = Date.now();
  const outcome = await execute(['case', 'run', '--once', '--ports', String(port), '--host-command', HOST, '--keep-hosts', '--host-timeout', '3000'], p.base);
  assert.ok(Date.now() - t0 < 2500, `the run took ${Date.now() - t0} ms`);
  assert.ok(p.probes() < 20, `it probed the port ${p.probes()} times`);
  assert.equal(outcome.code, 1);
  assert.match(outcome.text ?? '', new RegExp(`✖ the run could not go on after 0 of 1 cases: port ${port} is taken by another process`));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(p.hostPids().length, 1);
  for (const pid of p.hostPids()) assert.equal(alive(pid), false, `host ${pid} outlived the run`);
});

test('a kept host that cannot attach is waited for at a bounded pace, not in a tight loop', async () => {
  const [port] = await freePorts(1, 19_900 + (process.pid % 200));
  const p = project(() => Promise.reject(new AgentError('No app attached')));
  await execute(['case', 'run', '--once', '--ports', String(port), '--host-command', HOST, '--keep-hosts', '--host-timeout', '1500'], p.base);
  assert.ok(p.probes() < 40, `it probed the port ${p.probes()} times in 1.5 s`);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(p.hostPids().length >= 1);
  for (const pid of p.hostPids()) assert.equal(alive(pid), false, `host ${pid} outlived the run`);
});

test('a run that ends normally waits for its kept hosts to exit, so it leaves none listed or running', async () => {
  const [port] = await freePorts(1, 20_100 + (process.pid % 200));
  const p = project(() => Promise.reject(new AgentError('No app attached')));
  const out = path.join(p.root, 'run');
  // A host that takes a moment to exit once told to, as a jest host does.
  const slow = "trap 'sleep 0.4; exit 0' TERM; echo $$ > pids/$$; sleep 30 & wait";
  await execute(['case', 'run', '--once', '--ports', String(port), '--host-command', slow, '--keep-hosts', '--host-timeout', '600', '--out', out], p.base);
  assert.ok(p.hostPids().length >= 1);
  for (const pid of p.hostPids()) assert.equal(alive(pid), false, `host ${pid} was still running when the run returned`);
  assert.equal(fs.existsSync(hostsFileOf(path.join(out, PROGRESS_FILE))), false);
});

test('ci asks for frames only from hosts the project names, not from the headless host that draws none', () => {
  const base = { files: ['cases/a.md'], jobs: 2, ports: [8124, 8125], hostCommand: 'h', out: 'lynkeus-run', push: false };
  assert.ok(!suiteArgs({ ...base, ownHosts: false }).includes('--screenshots'));
  assert.ok(suiteArgs({ ...base, ownHosts: true }).includes('--screenshots'));
  assert.deepEqual(suiteArgs({ ...base, ownHosts: false, timeoutMs: 9, push: true, extra: ['--seed', '1'] }).slice(3), [
    '--jobs',
    '2',
    '--ports',
    '8124,8125',
    '--host-command',
    'h',
    '--keep-hosts',
    '--host-timeout',
    '9',
    '--out',
    'lynkeus-run',
    '--push',
    '--seed',
    '1',
  ]);
});

test('a --ports entry another process listens on is refused before any host starts', async () => {
  const held = await listening();
  try {
    const p = project(() => Promise.reject(new AgentError('No app attached')));
    const outcome = await execute(['case', 'run', '--once', '--ports', String(held.port), '--host-command', HOST, '--keep-hosts'], p.base);
    assert.equal(outcome.code, 1);
    assert.match(outcome.text ?? '', new RegExp(`port ${held.port} is already in use by another process`));
    assert.equal(p.probes(), 0);
    assert.deepEqual(p.hostPids(), []);
  } finally {
    await held.close();
  }
});

test('ci passes over a driver port another process listens on, and says so', async () => {
  const held = await listening();
  try {
    const p = project(() => Promise.reject(new AgentError('No app attached')));
    const before = process.env.LYNKEUS_PORT;
    delete process.env.LYNKEUS_PORT;
    try {
      const outcome = await execute(['ci', '--dry-run', '--jobs', '2'], { ...p.base, config: { ...p.base.config, port: held.port } });
      const plan = outcome.json as { ports: number[] };
      assert.equal(plan.ports.length, 2);
      assert.ok(!plan.ports.includes(held.port), `it took the held port: ${plan.ports.join(', ')}`);
      assert.ok(plan.ports.every((port) => port > held.port));
      assert.match(outcome.text ?? '', new RegExp(`port ${held.port} is in use or claimed by another run, so the hosts take ${plan.ports.join(', ')}`));
    } finally {
      if (before !== undefined) process.env.LYNKEUS_PORT = before;
    }
  } finally {
    await held.close();
  }
});

/** A stand-in for `case run` that starts a detached host, lists it as a run does, says it is up and then does `then`. */
const fakeRun = (dir: string, then: string) => {
  const script = path.join(dir, 'run.cjs');
  fs.writeFileSync(
    script,
    `const { spawn } = require('node:child_process');
const fs = require('node:fs');
const host = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
fs.writeFileSync(${JSON.stringify(path.join(dir, 'host.pid'))}, String(host.pid));
fs.writeFileSync(process.argv[2], host.pid + '\\n');
console.log('up; report: https://lynkeus.io/r/abc');
${then}`,
  );
  return script;
};

const hostOf = (dir: string) => Number(fs.readFileSync(path.join(dir, 'host.pid'), 'utf8'));

test('ci stops the hosts a case run left running when it died', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-suite-'));
  const hosts = hostsFileOf(path.join(dir, 'progress.ndjson'));
  const said: string[] = [];
  const run = await runSuite(process.execPath, [fakeRun(dir, "process.kill(process.pid, 'SIGKILL');"), hosts], dir, hosts, (l) => said.push(l));
  assert.equal(run.code, 1);
  assert.equal(run.report, 'https://lynkeus.io/r/abc');
  assert.deepEqual(said, ['case run died (SIGKILL)', 'stopped 1 host(s) the run left running']);
  assert.equal(alive(hostOf(dir)), false);
  assert.equal(fs.existsSync(hosts), false);
});

test('ci passes SIGTERM on to the case run and stops what it left', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-suite-'));
  const hosts = hostsFileOf(path.join(dir, 'progress.ndjson'));
  // This run ignores the signal's meaning for its host and just exits, as a run killed mid-way would.
  const script = fakeRun(dir, "process.on('SIGTERM', () => process.exit(143)); setInterval(() => {}, 1000);");
  const running = runSuite(process.execPath, [script, hosts], dir, hosts, () => undefined);
  const end = Date.now() + 5000;
  while (!fs.existsSync(path.join(dir, 'host.pid')) && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 100));
  process.emit('SIGTERM');
  const run = await running;
  assert.equal(run.signal, 'SIGTERM');
  assert.equal(alive(hostOf(dir)), false);
  assert.equal(process.listenerCount('SIGTERM'), 0);
});

test('a hosts list naming processes that are gone stops nothing and is removed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-suite-'));
  const file = path.join(dir, 'hosts');
  fs.writeFileSync(file, '999999\n\n1\n');
  assert.equal(await stopLeftHosts(file), 0);
  assert.equal(fs.existsSync(file), false);
  assert.equal(await stopLeftHosts(file), 0);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { AgentError } from 'lynkeus-client';

import { freePorts } from '../cases/portClaim.js';
import { PROGRESS_FILE } from '../cases/progress.js';
import { caseCommands, lastLogLine } from '../commands/cases.js';
import { type Base, register } from '../registry.js';
import { execute } from '../runtime.js';

register(caseCommands);

type Ended = (() => string | undefined) | undefined;

/**
 * A project whose host command is a fastsim-run of its own (it writes its log where a FastSim host does), and whose
 * driver waits for an app the way the real one does: until its time runs out, or at once once `ended` says why.
 */
const project = (run: string, attachMs = 15_000) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-hostdown-'));
  fs.mkdirSync(path.join(root, 'cases'));
  for (const id of ['one', 'two']) fs.writeFileSync(path.join(root, 'cases', `${id}.md`), `---\nid: ${id}\n---\nsteps:\n  - app.press: "#x"\n`);
  fs.mkdirSync(path.join(root, 'kit', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'bundle'));
  const script = path.join(root, 'kit', 'bin', 'fastsim-run');
  fs.writeFileSync(script, `#!/bin/sh\nmkdir -p "$1/hosts"\n${run}\n`, { mode: 0o755 });
  const endedSeen: Ended[] = [];
  const waitFor = (ended: Ended) => () =>
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        clearInterval(poll);
        reject(new AgentError(`No app attached within ${attachMs}ms.`));
      }, attachMs);
      const poll = setInterval(() => {
        const why = ended?.();
        if (!why) return;
        clearTimeout(timer);
        clearInterval(poll);
        reject(new AgentError(why, 'gone'));
      }, 20);
    });
  const base: Base = {
    root,
    config: { cases: { dir: 'cases' } },
    attached: true,
    err: () => undefined,
    graph: () => {
      throw new Error('no graph');
    },
    device: waitFor(undefined),
    forPort: (_port, o) => {
      endedSeen.push(o?.ended);
      return { base: { ...base, device: waitFor(o?.ended) }, stop: async () => undefined };
    },
  };
  return { root, base, endedSeen, command: `"${script}" "${path.join(root, 'bundle')}" {port}` };
};

test('a kept FastSim host that exits at once ends its job within moments, says why from its log and runs no case', async () => {
  const [port] = await freePorts(1, 20_300 + (process.pid % 200));
  // What run 7's Android host said when the run restarted it on a grant past its hour.
  const p = project(
    'echo "Lynkeus FastSim has no valid license grant (expired): run it through fastsim-run, which gets one with \\`lynkeus fastsim grant\\`" > "$1/hosts/$2.err"; exit 3',
  );
  const out = path.join(p.root, 'run');
  const t0 = Date.now();
  const outcome = await execute(
    ['case', 'run', '--once', '--ports', String(port), '--host-command', p.command, '--keep-hosts', '--host-timeout', '600000', '--out', out],
    p.base,
  );
  const took = Date.now() - t0;
  assert.ok(took < 3000, `the run took ${took} ms`);
  assert.equal(outcome.code, 1);
  assert.match(
    outcome.text ?? '',
    new RegExp(
      `✖ the run could not go on after 0 of 2 cases: the host on port ${port} exited \\(3\\): Lynkeus FastSim has no valid license grant \\(expired\\)`,
    ),
  );
  assert.match(outcome.text ?? '', /the cases left were not run/);
  const events = fs
    .readFileSync(path.join(out, PROGRESS_FILE), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { type: string });
  assert.equal(events.filter((e) => e.type === 'case-start').length, 0);
});

test('a kept host that never brings its app ends its job at the host timeout, not one wait per step after it', async () => {
  const [port] = await freePorts(1, 20_500 + (process.pid % 200));
  const p = project('exec sleep 30', 400);
  const t0 = Date.now();
  const outcome = await execute(
    ['case', 'run', '--once', '--ports', String(port), '--host-command', p.command, '--keep-hosts', '--host-timeout', '600'],
    p.base,
  );
  const took = Date.now() - t0;
  assert.ok(took < 4000, `the run took ${took} ms`);
  assert.equal(outcome.code, 1);
  assert.match(outcome.text ?? '', new RegExp(`the host on port ${port} did not bring its app within 0.6 s; the cases left were not run`));
});

test('the wait for a case’s app knows its host, and says the host’s last words once it has exited', async () => {
  const [port] = await freePorts(1, 20_700 + (process.pid % 200));
  // A host per case that writes its reason and dies shortly after it starts.
  const p = project('(sleep 0.2; echo "Segmentation fault in Skia" > "$1/hosts/$2.err"; exit 139) & wait $!; exit $?', 60_000);
  const t0 = Date.now();
  const outcome = await execute(['case', 'run', '--once', '--ports', String(port), '--host-command', p.command, path.join(p.root, 'cases', 'one.md')], p.base);
  const took = Date.now() - t0;
  // Without the host's end the case's first wait alone would last its whole minute.
  assert.ok(took < 5000, `the run took ${took} ms`);
  const ended = p.endedSeen.find((e) => e !== undefined);
  assert.ok(ended, 'the case was given no way to know its host ended');
  assert.match(outcome.text ?? '', /exited \(139\): Segmentation fault in Skia/);
});

test('every case on FastSim gets a host of its own, --keep-hosts or not: nothing would reset the app a kept one holds', async () => {
  const [port] = await freePorts(1, 20_900 + (process.pid % 200));
  const p = project('echo "$2" >> "$1/starts"; exec sleep 30');
  for (const id of ['one', 'two']) fs.writeFileSync(path.join(p.root, 'cases', `${id}.md`), `---\nid: ${id}\n---\nsteps:\n  - exec: { run: "true" }\n`);
  const device = {
    server: { connected: true, hello: null, port },
    screen: async () => ({ route: 'Home', path: ['Home'], commit: 1, busy: false, window: { w: 390, h: 844 }, costMs: 1, elements: [] }),
    trace: async () => ({ last: 0, events: [] }),
    requests: async () => ({ inFlight: 0, requests: [] }),
    idle: async () => ({ idle: true, commit: 1 }),
    command: async () => ({}),
  };
  const said: string[] = [];
  let scoped = 0;
  const base: Base = {
    ...p.base,
    err: (line) => said.push(line),
    // The app of a host attaches once that host has started.
    forPort: () => {
      const n = ++scoped;
      const started = async () => {
        const file = path.join(p.root, 'bundle', 'starts');
        while ((fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').length : 0) < n) await new Promise((r) => setTimeout(r, 10));
        return device as never;
      };
      return { base: { ...p.base, device: started }, stop: async () => undefined };
    },
  };
  const outcome = await execute(['case', 'run', '--once', '--ports', String(port), '--host-command', p.command, '--keep-hosts'], base);
  assert.equal(outcome.code, 0, outcome.text);
  const starts = fs
    .readFileSync(path.join(p.root, 'bundle', 'starts'), 'utf8')
    .trim()
    .split('\n');
  assert.equal(starts.length, 2, 'one host per case');
  assert.ok(said.some((l) => /--keep-hosts: each case still gets a FastSim host of its own/.test(l)));
});

test('lastLogLine reads the last line of a log and nothing of one that is not there', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-log-'));
  const file = path.join(dir, 'x.err');
  fs.writeFileSync(file, 'one\ntwo\n\n');
  assert.equal(lastLogLine(file), 'two');
  assert.equal(lastLogLine(path.join(dir, 'missing')), undefined);
  assert.equal(lastLogLine(undefined), undefined);
});

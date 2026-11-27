import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pairs, parseArgs, splitLine, UsageError } from '../args.js';
import { driveCommands } from '../commands/drive.js';
import { headlessCommands } from '../commands/headless.js';
import { skillCommands } from '../commands/skill.js';
import { mapCommands } from '../commands/map.js';
import { osCommands } from '../commands/os.js';
import { describeCrawl } from '../commands/crawl.js';
import { runsCommands } from '../commands/runs.js';
import { argvFor, schemaFor } from '../mcp/server.js';

const FLAGS = {
  direct: { type: 'boolean' as const, help: '' },
  depth: { type: 'number' as const, help: '', default: 4 },
  var: { type: 'list' as const, help: '' },
  out: { type: 'string' as const, help: '' },
};

test('booleans never eat the next positional; numbers are numbers; lists collect', () => {
  const p = parseArgs(
    ['--direct', 'a.ts', 'b.ts', '--depth', '2', '--var', 'x=1', '--var', 'y=2'],
    [{ name: 'file', help: '', required: true, rest: true }],
    FLAGS,
  );
  assert.deepEqual(p.args, ['a.ts', 'b.ts']);
  assert.equal(p.flags.direct, true);
  assert.equal(p.flags.depth, 2);
  assert.deepEqual(p.flags.var, ['x=1', 'y=2']);
  assert.deepEqual(pairs(p.flags.var as string[]), { x: '1', y: '2' });
});

test('defaults, --no-flag, --flag=value and passthrough after --', () => {
  const p = parseArgs(['--no-direct', '--out=x.json', '--', '--jest-flag'], [], FLAGS);
  assert.equal(p.flags.direct, false);
  assert.equal(p.flags.depth, 4);
  assert.equal(p.flags.out, 'x.json');
  assert.deepEqual(p.passthrough, ['--jest-flag']);
});

test('unknown flags, missing values and missing positionals are usage errors that name what exists', () => {
  assert.throws(
    () => parseArgs(['--nope'], [], FLAGS),
    (e: unknown) => e instanceof UsageError && /--direct/.test((e as Error).message),
  );
  assert.throws(() => parseArgs(['--depth', '--direct'], [], FLAGS), /--depth needs a value/);
  assert.throws(() => parseArgs(['--depth', 'x'], [], FLAGS), /expects a number/);
  assert.throws(() => parseArgs([], [{ name: 'target', help: '', required: true }], FLAGS), /missing <target>/);
  assert.throws(() => parseArgs(['a', 'b'], [{ name: 'one', help: '' }], FLAGS), /unexpected argument "b"/);
});

test('a session line splits on spaces and keeps quoted text together', () => {
  assert.deepEqual(splitLine('press "Comenzar ya" --hold 200'), ['press', 'Comenzar ya', '--hold', '200']);
});

test('every command is named once, documented, and its aliases are unique', () => {
  const all = [...driveCommands, ...osCommands, ...mapCommands, ...runsCommands, ...headlessCommands];
  const names = new Set<string>();
  for (const c of all) {
    assert.ok(c.summary.length > 10, `${c.name} has a summary`);
    assert.ok(!names.has(c.name), `${c.name} defined once`);
    names.add(c.name);
    for (const a of c.aliases ?? []) {
      assert.ok(!names.has(a), `${a} unique`);
      names.add(a);
    }
    for (const [flag, spec] of Object.entries(c.flags ?? {})) assert.ok(spec.help, `${c.name} --${flag} has help`);
    for (const p of c.positionals ?? []) assert.ok(p.help, `${c.name} <${p.name}> has help`);
  }
  for (const short of ['plan', 'deeplink', 'appstate', 'network', 'clock', 'biometrics', 'scan', 'gallery', 'headless'])
    assert.ok(names.has(short), `${short} accepted`);
});

test('MCP serves a small core by default and everything else on request', () => {
  const all = [...driveCommands, ...osCommands, ...mapCommands, ...runsCommands, ...headlessCommands, ...skillCommands];
  const core = all.filter((c) => c.mcp === 'core').map((c) => c.name);
  assert.deepEqual(core.sort(), [
    'back',
    'call',
    'crawl',
    'guide',
    'headless doctor',
    'headless init',
    'init',
    'map plan',
    'map show',
    'mock',
    'os deeplink',
    'os language',
    'press',
    'screen',
    'status',
    'type',
    'wait',
    'why',
  ]);
});

test('crawl over MCP is one level and a few presses unless the call asks for more', () => {
  const crawl = runsCommands.find((c) => c.name === 'crawl')!;
  assert.deepEqual(argvFor(crawl, {}), ['crawl', '--depth', '1', '--max', '12']);
  assert.deepEqual(argvFor(crawl, { max: 80, depth: 3, Route: 'Settings.Main' }), ['crawl', 'Settings.Main', '--depth', '3', '--max', '80']);
  const { properties } = schemaFor(crawl);
  assert.match(properties.max!.description, /default 12/);
  assert.equal(properties.verbose, undefined);
  for (const flag of Object.keys(crawl.mcpDefaults ?? {})) assert.ok(crawl.flags?.[flag], `crawl has --${flag}`);
});

test("a crawl's answer is a few lines: screens, new edges, problems, never one per press", () => {
  const press = (i: number) => ({ from: 'k', fromRoute: 'Home', button: { testId: `item-${i}` }, to: 'k', toRoute: 'Home', ms: 1, problems: [] });
  const text = describeCrawl({
    transitions: [
      ...Array.from({ length: 30 }, (_, i) => press(i)),
      { from: 'k', fromRoute: 'Home', button: { testId: 'menu' }, to: 'm', toRoute: 'Home', toLayer: 'menu', ms: 1, problems: [] },
      {
        from: 'k',
        fromRoute: 'Home',
        button: { text: 'Buy' },
        to: 'c',
        toRoute: 'Checkout',
        ms: 1,
        problems: ['500 POST /api/cart'],
        wrote: ['POST /api/cart'],
      },
    ],
    learned: ['Home #menu → Home#menu', 'Home "Buy" → Checkout'],
    reinforced: 1,
    seconds: 9,
    spent: true,
    outDir: '/tmp/crawl',
  });
  assert.match(text, /32 presses on 3 screens in 9s; 2 new edges \(1 seen again\), 1 problems/);
  assert.match(text, /screens: Checkout, Home, Home#menu/);
  assert.match(text, /Home "Buy" → Checkout: 500 POST \/api\/cart/);
  assert.match(text, /not explored past/);
  assert.match(text, /crawl again/);
  assert.doesNotMatch(text, /item-3/);
  assert.ok(text.split('\n').length < 15);
});

test('what MCP leaves out of a tool is still a flag of the command', () => {
  for (const c of [...driveCommands, ...osCommands, ...mapCommands, ...runsCommands, ...headlessCommands]) {
    for (const flag of c.mcpOmit ?? []) assert.ok(c.flags?.[flag], `${c.name} omits --${flag}, which it does not have`);
  }
});

test('mock --lost refuses a status, a body or a delay, which a lost answer would drop', async () => {
  const mock = osCommands.find((c) => c.name === 'mock')!;
  const ctx = (flags: Record<string, unknown>) =>
    ({ args: ['GET /x'], flags: { status: 200, ...flags }, device: () => Promise.reject(new Error('no app')) }) as unknown as Parameters<typeof mock.run>[0];
  const refused = (await mock.run(ctx({ lost: true, status: 500, delay: 100 }))) as { code?: number; text?: string };
  assert.equal(refused.code, 2);
  assert.match(refused.text ?? '', /--status, --delay/);
  await assert.rejects(Promise.resolve(mock.run(ctx({ lost: true }))), /no app/);
});

test('os language takes the app, as the CLI flag does', () => {
  const language = osCommands.find((c) => c.name === 'os language');
  assert.ok(language?.flags?.app);
  assert.ok(!language.mcpOmit?.includes('app'));
});

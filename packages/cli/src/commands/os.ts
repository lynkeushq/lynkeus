/**
 * What the outside world hands the app. One vocabulary whether the app is
 * hosted in Node (lynkeus stands in for the OS) or runs on a simulator (simctl
 * and adb do it); each command's summary says which it supports.
 */
import { type Ctx, define } from '../registry.js';
import { simulatorCommand } from './device.js';

/** A command the agent answers in place of the OS, with parameters taken from the context. */
const agent =
  (name: string, params: (ctx: Ctx) => unknown = () => undefined) =>
  async (ctx: Ctx) => ({ json: await (await ctx.device()).command(name, params(ctx)) });

const simulator = (sub: string) => async (ctx: Ctx) => {
  const device = await ctx.device();
  const info = await device.resolved();
  const lines = await simulatorCommand(info.platform, info.id, sub, ctx.args, (ctx.flags.app as string | undefined) ?? device.appId ?? undefined);
  return { text: lines.join('\n'), json: { ran: lines } };
};

export const osCommands = [
  define({
    name: 'os deeplink',
    mcp: 'core',
    group: 'os',
    summary: 'Open a URL in the app, as the OS would hand it over',
    positionals: [{ name: 'url', help: 'myapp://pay/abc or https://…', required: true }],
    aliases: ['deeplink'],
    needs: 'app',
    run: async (ctx) => {
      await (await ctx.device()).openUrl(ctx.args[0]!);
      return { json: { opened: ctx.args[0] } };
    },
  }),
  define({
    name: 'os appstate',
    group: 'os',
    summary:
      'AppState listeners see the change (background, then active: what refetches or re-locks); a host answers it, a simulator or an emulator does it for real',
    positionals: [{ name: 'state', help: 'active | background | inactive (inactive: a host only)', required: true }],
    flags: { app: { type: 'string', help: 'the app to bring back on a simulator or emulator (default: the config’s app)', value: 'bundleId' } },
    aliases: ['appstate'],
    needs: 'app',
    run: async (ctx) => {
      const device = await ctx.device();
      try {
        return { json: await device.command('appstate', { state: ctx.args[0] }) };
      } catch (error) {
        // A host stands in for the OS; on a simulator or an emulator the OS itself moves the app.
        if ((await device.resolved()).id === 'headless') throw error;
        const done = await simulator('appstate')(ctx);
        // Back in front, the app dials in again; what comes next reads its screen.
        if (ctx.args[0] === 'active') await device.server.waitForApp(15_000);
        return done;
      }
    },
  }),
  define({
    name: 'os network',
    group: 'os',
    summary: 'Headless: airplane mode (requests fail, open sockets drop, NetInfo listeners hear it)',
    positionals: [{ name: 'state', help: 'off | on', required: true }],
    aliases: ['network'],
    needs: 'app',
    run: agent('network', (ctx) => ({ state: ctx.args[0] })),
  }),
  define({
    name: 'os clock',
    group: 'os',
    summary: 'Headless and Lynkeus FastSim: what Date answers; --settle runs what is pending without letting time pass',
    details:
      '`--now`, `--advance` and `--reset` move what `Date` answers; timers keep their own time. `--settle` runs what is pending now (microtasks, timers due at this instant, queued renders) until nothing is, without waiting for work that is due later, and answers `settled`, `inFlight` (requests still out) and, on Lynkeus FastSim, `nextDueMs` (when the next timer is due) and `advancedMs` (0: the virtual clock did not move). On the headless host timers are real, so a few milliseconds pass; on Lynkeus FastSim the host owns the clock and none does. `settled: false` means something re-arms itself (an animation loop) and never goes quiet. A Simulator or emulator has no such command: a case step on one is `unsupported`. `idle` is the other way to wait: it lets time pass until the screen is quiet. Combined with `--now` or `--advance`, the time moves first.',
    mcpDetails:
      'Headless and Lynkeus FastSim: `now`, `advance` and `reset` change what Date answers; `settle` runs everything pending (timers due now, microtasks, renders) to idle without letting time pass, and says what is still in flight. Use it after a press or `advance` instead of `idle` when the clock must stay where you put it. A Simulator or emulator answers that it has no such command.',
    flags: {
      now: { type: 'string', help: 'set the time', value: 'iso' },
      advance: { type: 'number', help: 'move the clock forward', value: 'ms' },
      reset: { type: 'boolean', help: 'back to the real clock' },
      settle: { type: 'boolean', help: 'run what is pending to idle without letting time pass (after any of the above)' },
    },
    aliases: ['clock'],
    needs: 'app',
    run: async (ctx) => {
      const answer = await (await ctx.device()).command<Record<string, unknown>>('clock', {
        now: ctx.flags.now || undefined,
        advanceMs: ctx.flags.advance,
        reset: ctx.flags.reset || undefined,
        settle: ctx.flags.settle || undefined,
      });
      // A host built before `settle` takes the other parameters and answers without it.
      if (ctx.flags.settle && typeof answer.settled !== 'boolean')
        throw new Error('this host’s clock command does not settle: update Lynkeus FastSim (`lynkeus fastsim install`) or lynkeus-headless');
      return { json: answer };
    },
  }),
  define({
    name: 'os biometrics',
    group: 'os',
    summary: 'The sensor and what the next prompts answer; on a simulator, --available enrolls Face ID or Touch ID or not',
    flags: {
      available: { type: 'string', help: 'FaceID | TouchID | none', value: 'kind' },
      next: { type: 'string', help: 'outcomes of the next prompts, in order', value: 'success,fail,cancel' },
      fallback: { type: 'string', help: 'what a fallback prompt answers', value: 'outcome' },
    },
    aliases: ['biometrics'],
    needs: 'app',
    run: async (ctx) => {
      const device = await ctx.device();
      const params = {
        available: ctx.flags.available || undefined,
        next: ctx.flags.next ? (ctx.flags.next as string).split(',') : undefined,
        fallback: ctx.flags.fallback || undefined,
      };
      try {
        return { json: await device.command('biometrics', params) };
      } catch (error) {
        const info = await device.resolved();
        if (info.id === 'headless') throw error;
        // A device's prompts answer the person in front of it: only a simulator's enrollment is set from outside.
        // Anything else stays the host's, and the runner says the step cannot run here.
        if (info.platform !== 'ios' || !params.available || params.next || params.fallback) throw error;
        ctx.args = [String(params.available)];
        return simulator('biometrics')(ctx);
      }
    },
  }),
  define({
    name: 'os scan',
    group: 'os',
    summary: "Headless: the open camera's code scanner receives a value",
    positionals: [{ name: 'value', help: 'what the code carries', required: true }],
    flags: { type: { type: 'string', help: 'code type', default: 'qr', value: 'qr|ean13|…' } },
    aliases: ['scan'],
    needs: 'app',
    run: agent('scan', (ctx) => ({ value: ctx.args[0], type: ctx.flags.type })),
  }),
  define({
    name: 'os gallery',
    group: 'os',
    summary: 'Headless: what the next image picker answers',
    positionals: [{ name: 'uri', help: 'file the picker returns' }],
    flags: {
      cancel: { type: 'boolean', help: 'the user cancelled' },
      name: { type: 'string', help: 'file name reported', value: 'name' },
      mime: { type: 'string', help: 'mime type reported', value: 'type' },
    },
    aliases: ['gallery'],
    needs: 'app',
    run: agent('gallery', ({ args, flags }) => (flags.cancel ? { cancel: true } : { uri: args[0], fileName: flags.name, type: flags.mime })),
  }),
  define({
    name: 'mock',
    group: 'os',
    summary:
      'Answer a request before the network, or hold it until you release it (--hold, --release): a host stands in for the network, on a device the agent does it in the app (--sticky survives a host reset)',
    details:
      "With a route and no other flag, the matching requests are answered by a rule (`--status`, `--body`, `--delay`, `--times`, `--lost`). `--hold` is a gate instead: matching requests wait, as far as the app can tell still in flight, so a loading state stays on screen as long as you want; `--release [route]` lets the held ones go on, to a rule or to the network, oldest first, and the gate stays for the next requests (`--times n` holds only the first n). `--clear` drops every rule and gate and lets whatever is held go; so does an app reset on a host, unless the hold is `--sticky`. `--list` also shows what is held and for how long. A held request counts as in flight, so `idle` and a frame's `--settle` wait out their timeout while one is held; `clock --settle` reports it in `inFlight` and does not wait. Works wherever `--status` does (headless, a device with the agent, Lynkeus FastSim); a host that has no netmock answers `Unknown method`.",
    mcpDetails:
      'Answer a request from a rule instead of the server (status, body, delay, times, lost), or hold requests with `hold` and let them go with `release`: for a loading state that must stay on screen while you look at it. Held requests wait before any rule or the network sees them; `release` (optionally with a route) sends them on, `clear` drops everything and lets them go. `list` shows what is held.',
    positionals: [{ name: 'route', help: "'GET /path' (a bare path matches any method)" }],
    flags: {
      status: { type: 'number', help: 'HTTP status to answer', default: 200, value: 'code' },
      body: { type: 'string', help: 'JSON body', value: 'json' },
      delay: { type: 'number', help: 'answer after', value: 'ms' },
      times: { type: 'number', help: 'only this many times', value: 'n' },
      sticky: { type: 'boolean', help: 'keep the rule across an app reset' },
      lost: { type: 'boolean', help: 'let the request reach the server and fail it on the way back' },
      hold: { type: 'boolean', help: 'hold matching requests where they are until --release (the route is required; --times holds only the first n)' },
      release: { type: 'boolean', help: 'let held requests go on: all of them, or those matching the route' },
      clear: { type: 'boolean', help: 'drop every rule and gate, and let held requests go' },
      list: { type: 'boolean', help: 'show the rules, the gates and what is held' },
    },
    example:
      "mock 'GET /path' [--status 500] [--body <json>] [--delay <ms>] [--times <n>] [--sticky] [--lost] | mock 'GET /path' --hold [--times <n>] [--sticky] | mock --release ['GET /path'] | --clear | --list",
    needs: 'app',
    run: async (ctx) => {
      // A lost request never gets an answer to shape: a status, a body or a delay would be dropped without a word.
      const shaped = (['status', 'body', 'delay'] as const).filter((f) => ctx.flags[f] !== undefined && !(f === 'status' && ctx.flags[f] === 200));
      if (ctx.flags.lost && shaped.length) return { text: `--lost loses the server's answer: --${shaped.join(', --')} would have nothing to shape`, code: 2 };
      const held = (['hold', 'release'] as const).filter((f) => ctx.flags[f]);
      if (held.length === 2) return { text: '--hold and --release are two commands: hold first, release later', code: 2 };
      const alone =
        held.length === 1
          ? (['status', 'body', 'delay', 'lost'] as const).filter((f) => ctx.flags[f] !== undefined && !(f === 'status' && ctx.flags[f] === 200))
          : [];
      if (alone.length) return { text: `--${held[0]} takes no answer to shape: --${alone.join(', --')} would be dropped`, code: 2 };
      const device = await ctx.device();
      if (ctx.flags.clear) return { json: await device.command('netmock', { action: 'clear' }) };
      const gate = (): { method: string; path: string } | undefined => {
        if (!ctx.args[0]) return undefined;
        const [method, path] = ctx.args[0].includes(' ') ? ctx.args[0].split(/\s+/, 2) : ['*', ctx.args[0]];
        return { method: method!, path: path! };
      };
      if (ctx.flags.release) return { json: await device.command('netmock', { action: 'release', ...gate() }) };
      if (ctx.flags.hold) {
        if (!ctx.args[0]) throw new Error("mock --hold needs 'METHOD /path' (what to hold)");
        return { json: await device.command('netmock', { action: 'hold', ...gate(), times: ctx.flags.times, sticky: ctx.flags.sticky || undefined }) };
      }
      if (ctx.flags.list) {
        const rules = await device.command('netmock', { action: 'list' });
        return { text: JSON.stringify(rules, null, 2), json: rules };
      }
      if (!ctx.args[0]) throw new Error("mock needs 'METHOD /path' (or --clear, --list)");
      const [method, route] = ctx.args[0].includes(' ') ? ctx.args[0].split(/\s+/, 2) : ['*', ctx.args[0]];
      return {
        json: await device.command('netmock', {
          action: 'add',
          method,
          path: route,
          status: ctx.flags.status,
          body: ctx.flags.body,
          delayMs: ctx.flags.delay,
          times: ctx.flags.times,
          sticky: ctx.flags.sticky || undefined,
          lost: ctx.flags.lost || undefined,
        }),
      };
    },
  }),
  define({
    name: 'os permissions',
    group: 'os',
    summary: 'Simulator: grant, revoke or reset a permission for the app',
    positionals: [
      { name: 'action', help: 'grant | revoke | reset', required: true },
      { name: 'service', help: 'camera, photos, location, microphone, contacts, …', required: true },
    ],
    needs: 'app',
    run: simulator('permissions'),
  }),
  define({
    name: 'os push',
    group: 'os',
    summary: 'Simulator: deliver a push notification to the app',
    positionals: [{ name: 'payload', help: '\'{"alert":"…"}\' or a .json file', required: true }],
    needs: 'app',
    run: simulator('push'),
  }),
  define({
    name: 'os appearance',
    group: 'os',
    summary: 'Simulator: light or dark',
    positionals: [{ name: 'mode', help: 'light | dark', required: true }],
    needs: 'app',
    run: simulator('appearance'),
  }),
  define({
    name: 'os location',
    group: 'os',
    summary: 'Simulator: where the device is',
    positionals: [{ name: 'where', help: '<lat>,<lon> | clear', required: true }],
    needs: 'app',
    run: simulator('location'),
  }),
  define({
    name: 'os language',
    group: 'os',
    summary: 'Simulator: relaunch the app in a locale',
    positionals: [{ name: 'tag', help: 'de-DE, en-US, … (default: the locale in lynkeus.config.json)' }],
    needs: 'app',
    run: async (ctx) => {
      const tag = ctx.args[0] ?? ctx.config.locale?.languageTag ?? ctx.config.language;
      if (!tag) throw new Error('os language needs a tag, or `locale` in lynkeus.config.json');
      return simulator('language')({ ...ctx, args: [tag] });
    },
  }),
];

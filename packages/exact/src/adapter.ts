import type { Element, Screen, Target, WaitForParams } from 'lynkeus-protocol';

import { type ExactBox, type ExactNode, mapElements } from './elements.js';
import { describe, pick } from './target.js';
import type { ExactWire } from './wire.js';

export type AdapterOptions = {
  /** The instant Exact's clock starts at, as a launch fact: `Date` answers this plus the driver-moved clock. */
  epochMs?: number;
  /** What `hello` says the host is (`linux`, `macos`, `ios`, …). */
  platform?: string;
  /** The app's name, for `hello`. */
  app?: Record<string, unknown>;
};

type Snapshot = Screen & { exactId: number[] };

const WAIT_STEP_MS = 100;
const DEFAULT_WAIT_MS = 5000;

export class MethodError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

const num = (value: unknown, fallback = 0): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

const digest = (nodes: ExactNode[], boxes: ExactBox[]): string => JSON.stringify([nodes, boxes]);

/**
 * Answers the Lynkeus protocol from an Exact host. Exact's clock moves only when this side moves it, so everything
 * that waits (`waitFor`, `idle`) spends the app's own time in small steps instead of sleeping.
 */
export const createAdapter = (wire: ExactWire, options: AdapterOptions = {}) => {
  const epochMs = options.epochMs ?? Date.now();
  let commit = 0;
  let lastDigest = '';
  let inFlight = 0;
  let held = 0;

  const ask = async (request: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const reply = await wire.ask(request);
    if (typeof reply.error === 'string') throw new MethodError(reply.error);
    return reply;
  };

  const snapshot = async (): Promise<Snapshot> => {
    const started = Date.now();
    const tree = await ask({ op: 'tree' });
    const layout = await ask({ op: 'layout' });
    const nodes = (tree.nodes ?? []) as ExactNode[];
    const boxes = (layout.nodes ?? []) as ExactBox[];
    const next = digest(nodes, boxes);
    if (next !== lastDigest) {
      lastDigest = next;
      commit += 1;
    }
    const { elements, exactId } = mapElements(nodes, boxes);
    const viewport = (layout.viewport ?? tree.viewport ?? {}) as { w?: number; h?: number };
    const route = typeof tree.route === 'string' ? tree.route : undefined;
    return {
      ...(route ? { route } : {}),
      path: route ? [route] : [],
      elements,
      commit,
      busy: inFlight > 0,
      window: { w: num(viewport.w), h: num(viewport.h) },
      costMs: Date.now() - started,
      exactId,
    };
  };

  const publicScreen = ({ exactId: _ids, ...screen }: Snapshot): Screen => screen;

  const settle = async (): Promise<{ settled: boolean; inFlight: number; held?: number; nextDueMs: number | null }> => {
    const reply = await ask({ op: 'clock', settle: true });
    inFlight = num(reply.inFlight, 0);
    held = num(reply.held, 0);
    return {
      settled: reply.settled !== false,
      inFlight,
      ...(held ? { held } : {}),
      nextDueMs: typeof reply.nextDueMs === 'number' ? reply.nextDueMs : null,
    };
  };

  const advance = async (ms: number, from?: number): Promise<number> => {
    const now = from ?? num((await ask({ op: 'state' })).clock);
    await ask({ op: 'clock', to: now + ms });
    return now + ms;
  };

  const find = (snap: Snapshot, target: Target): Element | undefined => pick(snap.elements, target);

  const need = async (target: Target): Promise<{ snap: Snapshot; element: Element }> => {
    const snap = await snapshot();
    const element = find(snap, target);
    if (!element) throw new MethodError(`No element matches ${describe(target)}`);
    return { snap, element };
  };

  const clockMs = async (): Promise<number> => num((await ask({ op: 'state' })).clock);

  const press = async (target: Target & { holdMs?: number }) => {
    const { snap, element } = await need(target);
    if (!element.enabled) throw new MethodError(`${describe(target)} is disabled: a press does nothing`);
    const id = snap.exactId[element.i];
    const hold = target.holdMs ?? 0;
    if (hold > 50) {
      await ask({ op: 'tap', id, phase: 'down' });
      await advance(hold);
      await ask({ op: 'tap', phase: 'up' });
    } else {
      await ask({ op: 'tap', id });
    }
    await settle();
    return {
      x: element.frame.x + element.frame.w / 2,
      y: element.frame.y + element.frame.h / 2,
      element,
      mode: 'native' as const,
    };
  };

  const type = async (params: { text: string; target?: Target; clear?: boolean; paste?: boolean; submit?: boolean }) => {
    const snap = await snapshot();
    const element = params.target ? find(snap, params.target) : snap.elements.find((e) => e.kind === 'input' && e.focused);
    if (!element) throw new MethodError(params.target ? `No element matches ${describe(params.target)}` : 'No input is focused: pass a target');
    const id = snap.exactId[element.i];
    if (params.target) await ask({ op: 'tap', id });
    if (params.clear) await ask({ op: 'type', id, text: '' });
    await ask({ op: 'type', id, text: params.text, ...(params.paste ? { clipboard: 'paste' } : {}) });
    if (params.submit) await ask({ op: 'type', id, key: 'Enter' });
    await settle();
    return { typed: params.text, element };
  };

  const satisfied = (snap: Snapshot, params: WaitForParams): Target | true | undefined => {
    const targets = [...(params.target ? [params.target] : []), ...(params.anyOf ?? [])];
    if (params.route !== undefined && snap.route === params.route) return true;
    for (const target of targets) {
      const element = find(snap, target);
      const present = element !== undefined && (params.enabled === undefined ? true : element.enabled === params.enabled);
      if (params.gone ? !present : present) return target;
    }
    return undefined;
  };

  const waitFor = async (params: WaitForParams) => {
    const budget = params.timeoutMs ?? DEFAULT_WAIT_MS;
    let waited = 0;
    for (;;) {
      await settle();
      const snap = await snapshot();
      const hit = satisfied(snap, params);
      if (hit !== undefined) {
        return { ...(snap.route ? { route: snap.route } : {}), ...(hit === true ? {} : { matched: hit }), waitedMs: waited };
      }
      if (waited >= budget) {
        const wanted = params.target ?? params.anyOf?.[0];
        throw new MethodError(
          `Timed out after ${budget} ms (app time) waiting for ${params.route ? `route ${params.route}` : wanted ? describe(wanted) : 'the screen'}`,
          'timeout',
        );
      }
      const step = Math.min(WAIT_STEP_MS, budget - waited);
      await advance(step);
      waited += step;
    }
  };

  const idle = async (params?: { quietMs?: number; timeoutMs?: number }) => {
    const quiet = params?.quietMs ?? 300;
    const budget = params?.timeoutMs ?? 5000;
    let waited = 0;
    let last = (await snapshot()).commit;
    let quietFor = 0;
    for (;;) {
      const state = await settle();
      const snap = await snapshot();
      if (snap.commit === last && state.inFlight === 0) quietFor += WAIT_STEP_MS;
      else quietFor = 0;
      last = snap.commit;
      if (quietFor >= quiet) return { commit: snap.commit, idle: true };
      if (waited >= budget) return { commit: snap.commit, idle: false };
      await advance(WAIT_STEP_MS);
      waited += WAIT_STEP_MS;
    }
  };

  /** The `clock` command (`lynkeus os clock`): Exact's own clock, which moves only by request. */
  const clock = async (params: { now?: string | number; advanceMs?: number; reset?: boolean; settle?: boolean } = {}) => {
    if (params.now !== undefined || params.reset) {
      throw new MethodError(
        "An Exact host's date is a launch fact: start the host with `epoch` (LYNKEUS_EPOCH) instead of moving `Date` afterwards",
        'unsupported',
      );
    }
    let advanced = 0;
    if (params.advanceMs !== undefined) {
      const before = await clockMs();
      await advance(params.advanceMs, before);
      advanced = params.advanceMs;
    }
    const state = params.settle || params.advanceMs === undefined ? await settle() : undefined;
    const now = await clockMs();
    return {
      now: new Date(epochMs + now).toISOString(),
      offsetMs: 0,
      nextDueMs: state?.nextDueMs ?? null,
      ...(params.advanceMs !== undefined ? { advancedMs: advanced } : {}),
      ...(state ? { settled: state.settled, inFlight: state.inFlight, ...(state.held ? { held: state.held } : {}) } : {}),
    };
  };

  const methods: Record<string, (params: never) => Promise<unknown>> = {
    ping: async () => ({ pong: true, native: true, commands: ['clock'] }),
    screen: async () => publicScreen(await snapshot()),
    find: async (target: Target) => find(await snapshot(), target) ?? null,
    press,
    type,
    waitFor,
    idle,
    back: async () => {
      await ask({ op: 'tap', back: true });
      await settle();
      const route = (await snapshot()).route;
      return route ? { route } : {};
    },
    dismissKeyboard: async () => true,
    requests: async () => ({ inFlight, ...(held ? { held } : {}), requests: [] }),
    trace: async () => ({ last: 0, events: [] }),
    clock,
  };

  const call = async (method: string, params: unknown): Promise<unknown> => {
    if (method === 'batch') {
      const results: unknown[] = [];
      for (const item of (params as { calls: { method: string; params?: unknown }[] }).calls) results.push(await call(item.method, item.params));
      return { results };
    }
    const handler = methods[method];
    if (!handler) throw new MethodError(`Unknown method ${method}`);
    return handler(params as never);
  };

  return {
    call,
    hello: () => ({
      platform: options.platform ?? 'exact',
      native: true,
      commands: ['clock'],
      app: options.app,
    }),
  };
};

export type Adapter = ReturnType<typeof createAdapter>;

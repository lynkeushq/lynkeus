/**
 * A scripted app behind the agent protocol, and a clock of its own, for the React Native invariance goldens and the
 * per-step budget. Everything the CLI sends goes through `call`, which writes it down: the goldens compare that list.
 *
 * Copied into a checkout of another ref by scripts/goldens-rn.mjs and run against that ref's CLI, so it imports
 * nothing from the CLI and keeps to the protocol.
 */
import fs from 'node:fs';
import path from 'node:path';

type Frame = { x: number; y: number; w: number; h: number };
type El = {
  i: number;
  kind: string;
  testId?: string;
  text?: string;
  value?: string;
  enabled: boolean;
  depth: number;
  frame: Frame;
  hidden?: string;
  parent?: number;
};
type Target = { testId?: string; text?: string; i?: number; x?: number; y?: number; nth?: number };
type Req = { id: number; method: string; url: string; status?: number; startedAt: number };
type TraceEv = { seq: number; t: number; kind: string; [key: string]: unknown };

export type Hello = {
  platform: string;
  native?: boolean;
  commands?: string[];
  app?: { name?: string; runtime?: string };
};

export type FakeOptions = {
  hello?: Partial<Hello>;
  /** Presses after which a consent sheet covers the screen until `#accept` is pressed. */
  consentAfter?: number;
  /** `find` calls `#later` takes to become enabled. */
  laterAfter?: number;
  /** `find` calls `#late` takes to appear. */
  lateAfter?: number;
  /** Methods the app answers with "Unknown method". */
  missing?: string[];
};

const WINDOW = { w: 390, h: 844 };
const START = 1_800_000_000_000;

/** Date.now and setTimeout on a clock that moves only when something waits: loops end the same way every run. */
export class VirtualClock {
  now = START;
  #saved?: { now: typeof Date.now; set: typeof setTimeout; clear: typeof clearTimeout };

  install(): void {
    this.#saved = { now: Date.now, set: globalThis.setTimeout, clear: globalThis.clearTimeout };
    Date.now = () => this.now;
    const fake = (fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      this.now += Math.max(0, Number(ms) || 0);
      return setImmediate(fn, ...args);
    };
    globalThis.setTimeout = fake as unknown as typeof setTimeout;
    const clear = this.#saved.clear;
    globalThis.clearTimeout = ((t: unknown) => {
      if (t && typeof t === 'object' && t.constructor?.name === 'Immediate') clearImmediate(t as NodeJS.Immediate);
      else clear(t as NodeJS.Timeout);
    }) as typeof clearTimeout;
  }

  restore(): void {
    if (!this.#saved) return;
    Date.now = this.#saved.now;
    globalThis.setTimeout = this.#saved.set;
    globalThis.clearTimeout = this.#saved.clear;
    this.#saved = undefined;
  }
}

export class FakeApp {
  readonly log: string[] = [];
  readonly hello: Hello;
  connected = true;
  port = 8123;
  #clock: { now: number };
  #o: FakeOptions;
  #s = this.#fresh();
  #seq = 0;
  #trace: TraceEv[] = [];
  #requests: Req[] = [];
  #events: { name: string; properties?: Record<string, unknown> }[] = [];
  #finds = new Map<string, number>();
  #presses = 0;

  constructor(clock: { now: number }, options: FakeOptions = {}) {
    this.#clock = clock;
    this.#o = options;
    this.hello = { platform: 'ios', native: false, commands: ['reset', 'events'], app: { name: 'Sample', runtime: 'react-native' }, ...options.hello };
  }

  #fresh() {
    return {
      stack: ['Home'],
      count: 0,
      name: '',
      sentTo: undefined as string | undefined,
      sentAt: 0,
      offset: 0,
      picked: undefined as number | undefined,
      dialog: false,
      deleted: false,
      consent: false,
      remember: false,
      commit: 1,
    };
  }

  get #route(): string {
    return this.#s.stack[this.#s.stack.length - 1]!;
  }

  #mark(kind: string, extra: Record<string, unknown> = {}): void {
    this.#seq += 1;
    this.#s.commit += 1;
    this.#trace.push({ seq: this.#seq, t: this.#clock.now, kind, ...extra });
  }

  #elements(): El[] {
    const s = this.#s;
    const out: El[] = [];
    const add = (e: Omit<El, 'i' | 'depth' | 'enabled'> & { enabled?: boolean }) => out.push({ i: out.length, depth: 0, enabled: true, ...e } as El);
    const native = !!this.hello.native;
    if (this.#route === 'Home') {
      add({ kind: 'text', text: 'Welcome', frame: { x: 16, y: 60, w: 200, h: 24 } });
      add({ kind: 'text', text: `Count: ${s.count}`, frame: { x: 16, y: 100, w: 200, h: 24 } });
      add({ kind: 'button', testId: 'increment', text: 'Increment', frame: { x: 16, y: 140, w: 120, h: 44 } });
      add({ kind: 'input', testId: 'name', value: s.name, frame: { x: 16, y: 200, w: 300, h: 44 } });
      add({ kind: 'button', testId: 'send', text: 'Send code', frame: { x: 16, y: 260, w: 120, h: 44 } });
      if (s.sentTo !== undefined) {
        add({ kind: 'text', text: `Code sent to ${s.sentTo}`, frame: { x: 16, y: 320, w: 300, h: 24 } });
        const left = 3 - Math.floor((this.#clock.now - s.sentAt) / 1000);
        if (left > 0) add({ kind: 'text', text: `Resend in ${left}`, frame: { x: 16, y: 350, w: 200, h: 24 } });
        else add({ kind: 'button', testId: 'resend', text: 'Resend now', frame: { x: 16, y: 350, w: 200, h: 44 } });
      }
      if (s.picked !== undefined) add({ kind: 'text', text: `Picked Item ${s.picked}`, frame: { x: 16, y: 400, w: 200, h: 24 } });
      if (s.deleted) add({ kind: 'text', text: 'Everything was deleted', frame: { x: 16, y: 430, w: 300, h: 24 } });
      add({ kind: 'button', testId: 'open-list', text: 'Open list', frame: { x: 16, y: 470, w: 160, h: 44 } });
      add({ kind: 'button', testId: 'open-settings', text: 'Settings', frame: { x: 16, y: 530, w: 160, h: 44 } });
      add({ kind: 'button', testId: 'delete', text: 'Delete everything', frame: { x: 16, y: 590, w: 200, h: 44 } });
      const later = (this.#finds.get('later') ?? 0) >= (this.#o.laterAfter ?? 0);
      add({ kind: 'button', testId: 'later', text: 'Later', enabled: later, frame: { x: 16, y: 650, w: 120, h: 44 } });
      if ((this.#finds.get('late') ?? 0) >= (this.#o.lateAfter ?? 0))
        add({ kind: 'button', testId: 'late', text: 'Late', frame: { x: 200, y: 650, w: 120, h: 44 } });
      // Below the window: listed by a React Native agent, cut by a native host's window.
      add({ kind: 'button', testId: 'footer', text: 'Footer', frame: { x: 16, y: 900 - s.offset, w: 200, h: 44 } });
    } else if (this.#route === 'List') {
      add({ kind: 'text', text: 'Items', frame: { x: 16, y: 60, w: 200, h: 24 } });
      for (let k = 1; k <= 50; k++) {
        const y = 100 + (k - 1) * 60 - s.offset;
        if (native && (y < -60 || y > WINDOW.h + 120)) continue;
        add({ kind: 'button', text: `Item ${k}`, frame: { x: 0, y, w: WINDOW.w, h: 56 } });
      }
    } else if (this.#route === 'Settings') {
      add({ kind: 'text', text: `Remember me: ${s.remember ? 'on' : 'off'}`, frame: { x: 16, y: 60, w: 300, h: 24 } });
      add({ kind: 'button', testId: 'remember', text: 'Remember me', frame: { x: 16, y: 100, w: 200, h: 44 } });
    } else add({ kind: 'text', text: this.#route, frame: { x: 16, y: 60, w: 200, h: 24 } });
    if (s.dialog || s.consent) for (const e of out) e.hidden = 'covered';
    if (s.dialog) {
      add({ kind: 'text', text: 'Delete everything?', frame: { x: 40, y: 300, w: 300, h: 24 } });
      add({ kind: 'button', testId: 'confirm', text: 'Delete', frame: { x: 40, y: 360, w: 120, h: 44 } });
    }
    if (s.consent) {
      add({ kind: 'view', testId: 'consent-sheet', frame: { x: 0, y: 500, w: WINDOW.w, h: 344 } });
      add({ kind: 'button', testId: 'accept', text: 'Accept', frame: { x: 16, y: 700, w: 160, h: 44 } });
    }
    return out;
  }

  #screen() {
    const s = this.#s;
    return {
      route: this.#route,
      path: [...s.stack],
      commit: s.commit,
      busy: false,
      window: WINDOW,
      costMs: 1,
      elements: this.#elements(),
      ...(s.dialog ? { presenting: { modal: true, testId: 'confirm-delete' } } : {}),
    };
  }

  #find(t: Target | undefined): El | null {
    if (!t) return null;
    const key = t.testId ?? t.text;
    if (key) this.#finds.set(key, (this.#finds.get(key) ?? 0) + 1);
    const all = this.#elements();
    let hits: El[];
    if (t.testId !== undefined) hits = all.filter((e) => e.testId === t.testId);
    else if (t.text !== undefined) {
      const exact = all.filter((e) => e.text === t.text);
      hits = exact.length ? exact : all.filter((e) => (e.text ?? '').includes(t.text!));
    } else if (t.i !== undefined) hits = all.filter((e) => e.i === t.i);
    else if (t.x !== undefined && t.y !== undefined)
      hits = all.filter((e) => t.x! >= e.frame.x && t.x! <= e.frame.x + e.frame.w && t.y! >= e.frame.y && t.y! <= e.frame.y + e.frame.h);
    else hits = [];
    return hits[t.nth ?? 0] ?? null;
  }

  #press(t: Target): void {
    const e = this.#find(t);
    if (!e) throw new Error(`No element matches ${JSON.stringify(t)}`);
    const s = this.#s;
    this.#presses += 1;
    this.#mark('touch', { testId: e.testId, text: e.text, route: this.#route });
    if (s.consent && e.testId !== 'accept') return;
    const name = e.testId ?? e.text ?? '';
    if (name === 'increment') s.count += 1;
    else if (name === 'send') {
      s.sentTo = s.name;
      s.sentAt = this.#clock.now;
      this.#requests.push({ id: this.#requests.length + 1, method: 'POST', url: 'http://api.test/api/code', status: 200, startedAt: this.#clock.now });
      this.#mark('request', { method: 'POST', url: 'http://api.test/api/code', status: 200 });
      this.#events.push({ name: 'code_sent', properties: { to: s.name } });
    } else if (name === 'open-list' || name === 'open-settings') this.#go(name === 'open-list' ? 'List' : 'Settings');
    else if (name.startsWith('Item ')) {
      s.picked = Number(name.slice(5));
      this.#back();
    } else if (name === 'delete') s.dialog = true;
    else if (name === 'confirm') {
      s.dialog = false;
      s.deleted = true;
      s.count = 0;
    } else if (name === 'accept') s.consent = false;
    else if (name === 'remember') s.remember = !s.remember;
    if (this.#o.consentAfter !== undefined && this.#presses === this.#o.consentAfter) s.consent = true;
  }

  #go(route: string): void {
    this.#s.stack.push(route);
    this.#s.offset = 0;
    this.#mark('route', { route, path: [...this.#s.stack] });
  }

  #back(): void {
    if (this.#s.stack.length > 1) this.#s.stack.pop();
    this.#s.offset = 0;
    this.#mark('route', { route: this.#route, path: [...this.#s.stack] });
  }

  #scroll(dy: number): void {
    const max = this.#route === 'List' ? 50 * 60 + 100 - WINDOW.h : this.#route === 'Home' ? 200 : 0;
    this.#s.offset = Math.min(max, Math.max(0, this.#s.offset + dy));
    this.#s.commit += 1;
  }

  #holds(p: Record<string, unknown>): boolean {
    if (typeof p.route === 'string') {
      const since = typeof p.since === 'number' ? p.since : undefined;
      if (this.#route === p.route) return true;
      return since !== undefined && this.#trace.some((e) => e.seq > since && e.kind === 'route' && e.route === p.route);
    }
    if (Array.isArray(p.anyOf)) return (p.anyOf as Target[]).some((t) => this.#find(t) !== null);
    const t = p.target as Target | undefined;
    if (p.scroll && t?.text?.startsWith('Item ')) {
      const k = Number(t.text.slice(5));
      this.#s.offset = Math.max(0, (k - 3) * 60);
    }
    const found = this.#find(t);
    const there = !!found && !found.hidden && (!p.enabled || found.enabled);
    return p.gone ? !there : there;
  }

  #waitFor(p: Record<string, unknown>) {
    const timeoutMs = typeof p.timeoutMs === 'number' ? p.timeoutMs : 5000;
    for (let waited = 0; ; waited += 100) {
      if (this.#holds(p)) return { waitedMs: waited };
      if (waited >= timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs}ms: ${JSON.stringify(p)}`);
      this.#clock.now += 100;
    }
  }

  async call<T = unknown>(method: string, params?: unknown): Promise<T> {
    this.log.push(`${method}${params === undefined ? '' : ` ${JSON.stringify(params)}`}`);
    this.#clock.now += 1;
    return this.#answer(method, (params ?? {}) as Record<string, unknown>) as T;
  }

  #answer(method: string, p: Record<string, unknown>): unknown {
    if (this.#o.missing?.includes(method)) throw new Error(`Unknown method ${method}`);
    switch (method) {
      case 'screen':
        return this.#screen();
      case 'find':
        return this.#find(p as Target);
      case 'press':
        this.#press(p as Target);
        return { x: 0, y: 0, mode: 'native' };
      case 'type': {
        const field = p.target ? this.#find(p.target as Target) : undefined;
        if (p.target && !field) throw new Error(`No element matches ${JSON.stringify(p.target)}`);
        if (!field || field.testId === 'name') this.#s.name = p.clear ? String(p.text) : this.#s.name + String(p.text);
        this.#mark('touch', { testId: field?.testId });
        return { typed: String(p.text).length };
      }
      case 'swipe': {
        const from = p.from as { y: number } | undefined;
        const to = p.to as { y: number } | undefined;
        if (from && to) this.#scroll(from.y - to.y);
        else this.#scroll(p.direction === 'up' ? 300 : p.direction === 'down' ? -300 : 0);
        return { swiped: true };
      }
      case 'back':
        this.#back();
        return { route: this.#route };
      case 'navigate':
        this.#go(String(p.name));
        return {};
      case 'waitFor':
        return this.#waitFor(p);
      case 'idle':
        this.#clock.now += typeof p.quietMs === 'number' ? p.quietMs : 0;
        return { idle: true };
      case 'requests': {
        const since = typeof p.since === 'number' ? p.since : undefined;
        return { inFlight: 0, requests: this.#requests.filter((r) => since === undefined || r.id > since) };
      }
      case 'trace': {
        const since = typeof p.since === 'number' ? p.since : undefined;
        return { last: this.#seq, events: this.#trace.filter((e) => since === undefined || e.seq > since) };
      }
      case 'reset':
        this.#s = this.#fresh();
        this.#mark('route', { route: 'Home', path: ['Home'] });
        return { ok: true };
      case 'events':
        if (p.clear) this.#events = [];
        return this.#events;
      case 'screenshot':
        if (typeof p.path === 'string') {
          fs.mkdirSync(path.dirname(p.path), { recursive: true });
          fs.writeFileSync(p.path, `${this.#route}|${this.#s.commit}`);
        }
        return {};
      case 'still':
        return { still: true };
      default:
        return {};
    }
  }

  async close(): Promise<void> {
    this.connected = false;
  }
  async listen(): Promise<void> {}
  async waitForApp(): Promise<void> {}
}

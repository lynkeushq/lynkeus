// `netmock` on a simulator, an emulator or a phone: the same rules a host answers (`lynkeus mock`, a case's
// `app.mock`), answered here, in the app's own XMLHttpRequest, before a request reaches the network. A host that
// stands in for the network registers its own `netmock` and these rules stay empty.
import { addDefault } from './registry';

export type NetRule = {
  method: string;
  path: string;
  status: number;
  body?: string;
  headers?: Record<string, string>;
  delayMs?: number;
  times?: number;
  hits: number;
  lost?: boolean;
};

let rules: NetRule[] = [];

const pathOf = (url: string) => {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
};

const matches = (rule: NetRule, method: string, path: string) =>
  (rule.method === '*' || rule.method === method) && (rule.path.startsWith('^') ? new RegExp(rule.path).test(path) : path.includes(rule.path));

/** The rule that answers this request instead of the network, counted as used; null when none does. */
export const mockFor = (method: string, url: string): NetRule | null => {
  if (rules.length === 0) return null;
  const path = pathOf(url);
  const rule = rules.find((r) => (r.times === undefined || r.hits < r.times) && matches(r, method.toUpperCase(), path));
  if (rule) rule.hits += 1;
  return rule ?? null;
};

type RnXhr = XMLHttpRequest & {
  __didCreateRequest?: (id: number) => void;
  __didReceiveResponse?: (id: number, status: number, headers?: Record<string, string>, url?: string) => void;
  __didReceiveData?: (id: number, data: unknown) => void;
  __didCompleteResponse?: (id: number, error: string, timedOut: boolean) => void;
};

let fakeId = 0;

/**
 * Answers a request from a rule through React Native's own XMLHttpRequest callbacks, as its networking module would.
 * False when this is not React Native's XMLHttpRequest: the request then goes to the network.
 */
export const answer = (xhr: XMLHttpRequest, rule: NetRule, url: string): boolean => {
  const rn = xhr as RnXhr;
  if (!rn.__didCreateRequest || !rn.__didReceiveResponse || !rn.__didReceiveData || !rn.__didCompleteResponse) return false;
  // Below any id the native module hands out, so no real response is taken for this one.
  fakeId -= 1;
  const id = fakeId;
  const body = rule.body ?? (rule.status === 204 ? '' : '{}');
  setTimeout(() => {
    rn.__didCreateRequest!(id);
    if (rule.lost) {
      rn.__didCompleteResponse!(id, 'Network request failed', false);
      return;
    }
    rn.__didReceiveResponse!(id, rule.status, { 'content-type': 'application/json', ...rule.headers }, url);
    // fetch asks for a blob: React Native reads a blob's response from the data its Blob keeps.
    const data = xhr.responseType === 'blob' && typeof Blob !== 'undefined' ? (new Blob([body]) as Blob & { data?: unknown }).data : body;
    rn.__didReceiveData!(id, data);
    rn.__didCompleteResponse!(id, '', false);
  }, rule.delayMs ?? 0);
  return true;
};

export const installNetmock = (): void => {
  addDefault('netmock', (params) => {
    const p = (params ?? {}) as Partial<NetRule> & { action?: string };
    switch (p.action ?? 'add') {
      case 'add': {
        if (!p.path) throw new Error('netmock: add needs a path (substring, or ^regex)');
        rules.unshift({
          method: (p.method ?? '*').toUpperCase(),
          path: p.path,
          status: p.status ?? 200,
          body: typeof p.body === 'string' || p.body === undefined ? p.body : JSON.stringify(p.body),
          headers: p.headers,
          delayMs: p.delayMs,
          times: p.times,
          hits: 0,
          lost: p.lost,
        });
        return { rules: rules.length };
      }
      case 'clear':
        rules = [];
        return { rules: 0 };
      case 'list':
        return { rules };
      default:
        throw new Error(`netmock: "${p.action}" is answered by a host only; add, clear and list work on a device`);
    }
  });
};

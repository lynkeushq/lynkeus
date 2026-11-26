import { afterEach, describe, expect, it } from '@jest/globals';

import { FetchXMLHttpRequest } from '../xhr.js';

const g = globalThis as { fetch?: unknown };
const original = g.fetch;

afterEach(() => {
  g.fetch = original;
});

const done = (xhr: FetchXMLHttpRequest) => new Promise<string>((resolve) => xhr.addEventListener('loadend', (e) => resolve(e.type)));

describe('FetchXMLHttpRequest', () => {
  it('sends through the global fetch and answers as XMLHttpRequest does', async () => {
    const calls: unknown[] = [];
    g.fetch = async (url: string, init: { method: string; headers: Record<string, string>; body?: unknown }) => {
      calls.push([url, init.method, init.headers, init.body]);
      return new Response('{"ok":true}', { status: 201, headers: { 'Content-Type': 'application/json' } });
    };
    const xhr = new FetchXMLHttpRequest();
    const states: number[] = [];
    xhr.onreadystatechange = () => states.push(xhr.readyState);
    xhr.open('post', 'http://127.0.0.1:3000/login');
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.responseType = 'json';
    const ended = done(xhr);
    xhr.send('{"a":1}');
    await ended;
    expect(calls).toEqual([['http://127.0.0.1:3000/login', 'POST', { 'Content-Type': 'application/json' }, '{"a":1}']]);
    expect(xhr.status).toBe(201);
    expect(xhr.response).toEqual({ ok: true });
    expect(xhr.getResponseHeader('content-type')).toBe('application/json');
    expect(states).toEqual([1, 2, 3, 4]);
  });

  it('fails as a network error when fetch rejects (a refused host, the network off)', async () => {
    g.fetch = async () => {
      throw new TypeError('Network request failed');
    };
    const xhr = new FetchXMLHttpRequest();
    let failed = false;
    xhr.onerror = () => {
      failed = true;
    };
    xhr.open('GET', 'https://example.test/');
    const ended = done(xhr);
    xhr.send();
    await ended;
    expect(failed).toBe(true);
    expect(xhr.status).toBe(0);
    expect(xhr.readyState).toBe(4);
  });
});

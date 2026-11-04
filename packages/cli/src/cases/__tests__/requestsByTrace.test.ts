import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fileRequestsByTrace, type StepReport } from '../runner.js';

test('a request read in the step after the one it left in moves to the step whose trace served it', () => {
  const span = (method: string, path: string, at: number) => ({
    name: method,
    kind: 'server',
    at,
    ms: 5,
    depth: 0,
    attributes: { 'http.method': method, 'http.target': path },
  });
  const steps: StepReport[] = [
    {
      step: 'app.call social',
      status: 'passed',
      ms: 40,
      backend: [span('POST', '/api/v3/social/authentication', 5), span('GET', '/api/v3/user', 22)],
      requests: [{ id: 1, method: 'POST', url: 'http://h/api/v3/social/authentication', startedAt: 1005 }],
    },
    {
      step: 'app.wait #numpad-1-button',
      status: 'passed',
      ms: 300,
      requests: [
        { id: 2, method: 'GET', url: 'http://h/api/v3/user', startedAt: 1021 },
        { id: 3, method: 'GET', url: 'http://h/api/v3/cards', startedAt: 1100 },
      ],
    },
  ];
  fileRequestsByTrace(
    steps,
    new Map([
      ['a', { index: 0, startedMs: 1000 }],
      ['b', { index: 1, startedMs: 1040 }],
    ]),
  );
  assert.deepEqual(
    steps[0]!.requests!.map((r) => r.id),
    [1, 2],
  );
  assert.deepEqual(
    steps[1]!.requests!.map((r) => r.id),
    [3],
  );
});

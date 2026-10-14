import assert from 'node:assert/strict';
import { test } from 'node:test';

import { serviceOf, trafficEvents } from '../knowledge/analyticsTraffic.js';

const req = (url: string, body?: unknown, method = 'POST') => ({
  id: 1,
  method,
  url,
  startedAt: 0,
  ...(body !== undefined ? { request: { body: typeof body === 'string' ? body : JSON.stringify(body) } } : {}),
});

test('known analytics services are read from what the app sent them', () => {
  assert.equal(serviceOf('https://api.segment.io/v1/batch'), 'segment');
  assert.equal(serviceOf('https://o123.ingest.sentry.io/api/4/envelope/'), 'sentry');
  assert.equal(serviceOf('https://api.example.com/v1/me'), undefined);
  const events = trafficEvents([
    req('https://api.segment.io/v1/batch', {
      batch: [
        { type: 'track', event: 'Signed In', properties: { method: 'google' } },
        { type: 'screen', name: 'Home' },
      ],
    }),
    req('https://api2.amplitude.com/2/httpapi', { events: [{ event_type: 'Tap Sign In', event_properties: { source: 'intro' } }] }),
    req('https://us.i.posthog.com/batch/', { batch: [{ event: '$screen', properties: { $screen_name: 'Intro' } }] }),
    req(
      `https://api.mixpanel.com/track?ip=1`,
      `data=${Buffer.from(JSON.stringify([{ event: 'View Screen', properties: { screen: 'Home' } }])).toString('base64')}`,
    ),
    req('https://o1.ingest.sentry.io/api/4/envelope/', '{"event_id":"x"}\n{"type":"event"}'),
    req('https://api.example.com/v1/me', undefined, 'GET'),
  ]);
  assert.deepEqual(
    events.map((e) => [e.provider, e.name]),
    [
      ['segment', 'Signed In'],
      ['segment', 'screen: Home'],
      ['amplitude', 'Tap Sign In'],
      ['posthog', '$screen'],
      ['mixpanel', 'View Screen'],
      ['sentry', 'POST /api/4/envelope/'],
    ],
  );
  assert.deepEqual(events[0]?.props, { method: 'google' });
});

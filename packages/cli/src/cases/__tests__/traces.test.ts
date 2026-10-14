import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decodeJson, decodeProtobuf, newSpanId, newTraceId, TraceSink, traceparent } from '../traces.js';

// Just enough of protobuf's wire format to write what a backend's exporter sends.
const varint = (n: bigint) => {
  const out: number[] = [];
  do {
    let b = Number(n & 0x7fn);
    n >>= 7n;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
};
const len = (no: number, body: number[]) => [...varint(BigInt((no << 3) | 2)), ...varint(BigInt(body.length)), ...body];
const str = (no: number, s: string) => len(no, [...Buffer.from(s, 'utf8')]);
const bytes = (no: number, hex: string) => len(no, [...Buffer.from(hex, 'hex')]);
const num = (no: number, n: number) => [...varint(BigInt(no << 3)), ...varint(BigInt(n))];
const fixed64 = (no: number, n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return [...varint(BigInt((no << 3) | 1)), ...b];
};
const kv = (no: number, key: string, value: number[]) => len(no, [...str(1, key), ...len(2, value)]);

const span = (o: { trace: string; id: string; parent?: string; name: string; kind: number; start: bigint; end: bigint; attrs?: number[]; error?: string }) =>
  len(2, [
    ...bytes(1, o.trace),
    ...bytes(2, o.id),
    ...(o.parent ? bytes(4, o.parent) : []),
    ...str(5, o.name),
    ...num(6, o.kind),
    ...fixed64(7, o.start),
    ...fixed64(8, o.end),
    ...(o.attrs ?? []),
    ...(o.error ? len(15, [...str(2, o.error), ...num(3, 2)]) : []),
  ]);

test('reads the protobuf an OTLP exporter sends', () => {
  const trace = newTraceId();
  const request = len(1, [
    ...len(1, kv(1, 'service.name', str(1, 'shop-api'))),
    ...len(2, [
      ...span({
        trace,
        id: 'aaaaaaaaaaaaaaaa',
        parent: 'bbbbbbbbbbbbbbbb',
        name: 'GET',
        kind: 2,
        start: 1_000_000_000n,
        end: 1_050_000_000n,
        attrs: [...kv(9, 'http.method', str(1, 'GET')), ...kv(9, 'http.status_code', num(3, 200))],
      }),
      ...span({
        trace,
        id: 'cccccccccccccccc',
        parent: 'aaaaaaaaaaaaaaaa',
        name: 'SELECT',
        kind: 3,
        start: 1_010_000_000n,
        end: 1_012_000_000n,
        error: 'deadlock',
      }),
    ]),
  ]);
  const spans = decodeProtobuf(new Uint8Array(request));
  assert.equal(spans.length, 2);
  assert.deepEqual(
    spans.map((s) => [s.name, s.parentSpanId, s.service]),
    [
      ['GET', 'bbbbbbbbbbbbbbbb', 'shop-api'],
      ['SELECT', 'aaaaaaaaaaaaaaaa', 'shop-api'],
    ],
  );
  assert.deepEqual(spans[0]!.attributes, { 'http.method': 'GET', 'http.status_code': 200 });
  assert.equal(spans[1]!.error, 'deadlock');
});

test('files each span under the step whose request set it off, and leaves out the rest', () => {
  const sink = new TraceSink(0);
  const trace = newTraceId();
  const step = newSpanId();
  const t0 = 1_700_000_000_000;
  const ns = (ms: number) => String(BigInt(t0 + ms) * 1_000_000n);
  sink.add(
    decodeJson({
      resourceSpans: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: 'api' } }] },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: trace,
                  spanId: '1111111111111111',
                  parentSpanId: step,
                  name: 'POST',
                  kind: 2,
                  startTimeUnixNano: ns(5),
                  endTimeUnixNano: ns(45),
                  attributes: [
                    { key: 'http.target', value: { stringValue: '/session' } },
                    { key: 'thread.id', value: { intValue: '7' } },
                  ],
                },
                {
                  traceId: trace,
                  spanId: '2222222222222222',
                  parentSpanId: '1111111111111111',
                  name: 'INSERT',
                  kind: 3,
                  startTimeUnixNano: ns(10),
                  endTimeUnixNano: ns(12),
                },
                // A query: it names the backend's tables, and never leaves the machine.
                {
                  traceId: trace,
                  spanId: '5555555555555555',
                  parentSpanId: '1111111111111111',
                  name: 'SELECT users',
                  kind: 3,
                  startTimeUnixNano: ns(13),
                  endTimeUnixNano: ns(14),
                  attributes: [
                    { key: 'db.system', value: { stringValue: 'postgresql' } },
                    { key: 'db.statement', value: { stringValue: 'SELECT * FROM users' } },
                  ],
                },
                // Polling the app did not cause: another trace, and a root span of this one.
                { traceId: newTraceId(), spanId: '3333333333333333', name: 'SELECT', kind: 3, startTimeUnixNano: ns(1), endTimeUnixNano: ns(2) },
                { traceId: trace, spanId: '4444444444444444', name: 'cron', kind: 1, startTimeUnixNano: ns(1), endTimeUnixNano: ns(2) },
              ],
            },
          ],
        },
      ],
    }),
  );
  const filed = sink.take(trace, new Map([[step, { index: 3, startedMs: t0 }]]));
  assert.deepEqual([...filed.keys()], [3]);
  assert.deepEqual(
    filed.get(3)!.map((s) => [s.name, s.depth, s.at, s.ms, s.service]),
    [
      ['POST', 0, 5, 40, 'api'],
      ['INSERT', 1, 10, 2, 'api'],
    ],
  );
  // Attributes are kept for what they say the span did.
  assert.deepEqual(filed.get(3)![0]!.attributes, { 'http.target': '/session' });
  assert.equal(traceparent(trace, step), `00-${trace}-${step}-01`);
});

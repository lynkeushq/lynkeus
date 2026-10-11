import { randomBytes } from 'node:crypto';
import http from 'node:http';

/** A span as a backend exported it over OTLP, reduced to what a report shows. */
export type Span = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startNs: bigint;
  endNs: bigint;
  attributes: Record<string, string | number | boolean>;
  error?: string;
  service?: string;
};

/** What a step did on the backend, as the run file keeps it: one line per span, children indented by depth. */
export type BackendSpan = {
  name: string;
  /** server, client, internal, producer or consumer */
  kind: string;
  /** ms after the step began */
  at: number;
  ms: number;
  depth: number;
  service?: string;
  error?: string;
  attributes?: Record<string, string | number | boolean>;
};

const KINDS = ['unspecified', 'internal', 'server', 'client', 'producer', 'consumer'];

export const newTraceId = () => randomBytes(16).toString('hex');
export const newSpanId = () => randomBytes(8).toString('hex');
export const traceparent = (traceId: string, spanId: string) => `00-${traceId}-${spanId}-01`;

// OTLP over HTTP sends protobuf by default (Ruby's exporter sends nothing else). This reads the few
// messages of ExportTraceServiceRequest a report needs, straight from the wire format.
type Field = { no: number; wire: number; value: bigint | Uint8Array };

const fields = (buf: Uint8Array): Field[] => {
  const out: Field[] = [];
  let i = 0;
  const varint = () => {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      const b = buf[i++]!;
      result |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return result;
      shift += 7n;
    }
  };
  while (i < buf.length) {
    const tag = Number(varint());
    const no = tag >> 3;
    const wire = tag & 7;
    if (wire === 0) out.push({ no, wire, value: varint() });
    else if (wire === 1) {
      out.push({ no, wire, value: buf.slice(i, i + 8) });
      i += 8;
    } else if (wire === 2) {
      const length = Number(varint());
      out.push({ no, wire, value: buf.subarray(i, i + length) });
      i += length;
    } else if (wire === 5) {
      out.push({ no, wire, value: buf.slice(i, i + 4) });
      i += 4;
    } else throw new Error(`unknown protobuf wire type ${wire}`);
  }
  return out;
};

const text = (v: bigint | Uint8Array) => (v instanceof Uint8Array ? Buffer.from(v).toString('utf8') : '');
const hex = (v: bigint | Uint8Array) => (v instanceof Uint8Array ? Buffer.from(v).toString('hex') : '');
const fixed64 = (v: bigint | Uint8Array) => (v instanceof Uint8Array ? Buffer.from(v).readBigUInt64LE(0) : 0n);

const anyValue = (buf: Uint8Array): string | number | boolean => {
  for (const f of fields(buf)) {
    if (f.no === 1) return text(f.value);
    if (f.no === 2) return f.value === 1n;
    if (f.no === 3) return Number(BigInt.asIntN(64, f.value as bigint));
    if (f.no === 4 && f.value instanceof Uint8Array) return Buffer.from(f.value).readDoubleLE(0);
  }
  return '';
};

const keyValues = (list: Field[], no: number) => {
  const out: Record<string, string | number | boolean> = {};
  for (const f of list) {
    if (f.no !== no || !(f.value instanceof Uint8Array)) continue;
    let key = '';
    let value: string | number | boolean = '';
    for (const kv of fields(f.value)) {
      if (kv.no === 1) key = text(kv.value);
      if (kv.no === 2 && kv.value instanceof Uint8Array) value = anyValue(kv.value);
    }
    if (key) out[key] = value;
  }
  return out;
};

export const decodeProtobuf = (buf: Uint8Array): Span[] => {
  const spans: Span[] = [];
  for (const rs of fields(buf)) {
    if (rs.no !== 1 || !(rs.value instanceof Uint8Array)) continue;
    const parts = fields(rs.value);
    const resource = parts.find((p) => p.no === 1);
    const service = resource?.value instanceof Uint8Array ? keyValues(fields(resource.value), 1)['service.name'] : undefined;
    for (const ss of parts) {
      if (ss.no !== 2 || !(ss.value instanceof Uint8Array)) continue;
      for (const sp of fields(ss.value)) {
        if (sp.no !== 2 || !(sp.value instanceof Uint8Array)) continue;
        const s = fields(sp.value);
        const get = (no: number) => s.find((f) => f.no === no)?.value;
        const status = get(15);
        let error: string | undefined;
        if (status instanceof Uint8Array) {
          const st = fields(status);
          const code = st.find((f) => f.no === 3)?.value;
          if (code === 2n) error = text(st.find((f) => f.no === 2)?.value ?? new Uint8Array()) || 'error';
        }
        const parent = get(4);
        spans.push({
          traceId: hex(get(1) ?? new Uint8Array()),
          spanId: hex(get(2) ?? new Uint8Array()),
          parentSpanId: parent instanceof Uint8Array && parent.length ? hex(parent) : undefined,
          name: text(get(5) ?? new Uint8Array()),
          kind: Number(get(6) ?? 0n),
          startNs: fixed64(get(7) ?? new Uint8Array(8)),
          endNs: fixed64(get(8) ?? new Uint8Array(8)),
          attributes: keyValues(s, 9),
          ...(error ? { error } : {}),
          ...(typeof service === 'string' ? { service } : {}),
        });
      }
    }
  }
  return spans;
};

type JsonValue = { stringValue?: string; boolValue?: boolean; intValue?: string | number; doubleValue?: number };
type JsonAttrs = { key: string; value: JsonValue }[] | undefined;

const jsonAttrs = (list: JsonAttrs) =>
  Object.fromEntries(
    (list ?? []).map(({ key, value }) => [
      key,
      value.stringValue ?? value.boolValue ?? (value.intValue !== undefined ? Number(value.intValue) : (value.doubleValue ?? '')),
    ]),
  );

export const decodeJson = (body: unknown): Span[] => {
  const spans: Span[] = [];
  const request = body as {
    resourceSpans?: {
      resource?: { attributes?: JsonAttrs };
      scopeSpans?: {
        spans?: {
          traceId: string;
          spanId: string;
          parentSpanId?: string;
          name: string;
          kind?: number;
          startTimeUnixNano: string;
          endTimeUnixNano: string;
          attributes?: JsonAttrs;
          status?: { code?: number; message?: string };
        }[];
      }[];
    }[];
  };
  for (const rs of request.resourceSpans ?? []) {
    const service = jsonAttrs(rs.resource?.attributes)['service.name'];
    for (const ss of rs.scopeSpans ?? [])
      for (const s of ss.spans ?? [])
        spans.push({
          traceId: s.traceId.toLowerCase(),
          spanId: s.spanId.toLowerCase(),
          parentSpanId: s.parentSpanId ? s.parentSpanId.toLowerCase() : undefined,
          name: s.name,
          kind: s.kind ?? 0,
          startNs: BigInt(s.startTimeUnixNano),
          endNs: BigInt(s.endTimeUnixNano),
          attributes: jsonAttrs(s.attributes),
          ...(s.status?.code === 2 ? { error: s.status.message || 'error' } : {}),
          ...(typeof service === 'string' ? { service } : {}),
        });
  }
  return spans;
};

// What a report keeps of a span's attributes: what it did, not every label an instrumentation adds.
const KEEP =
  /^(http\.(request\.)?method|http\.(response\.)?status_code|http\.route|http\.target|url\.(path|full)|server\.address|net\.peer\.name|db\.(system|statement|operation|sql\.table)|messaging\.|code\.(namespace|function)|rpc\.|exception\.message|enduser\.id)/;

/**
 * Listens for OTLP traces while a run goes on: a backend with OTEL_EXPORTER_OTLP_ENDPOINT pointed here sends
 * what each request did, and the steps that sent those requests (their ids travel in `traceparent`) get it.
 */
export class TraceSink {
  private readonly spans = new Map<string, Span[]>();
  private server?: http.Server;
  private lastArrival = 0;

  constructor(readonly port: number) {}

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      if (req.method !== 'POST' || !req.url?.startsWith('/v1/traces')) {
        res.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        try {
          const body = Buffer.concat(chunks);
          const spans = (req.headers['content-type'] ?? '').includes('json') ? decodeJson(JSON.parse(body.toString('utf8'))) : decodeProtobuf(body);
          this.add(spans);
          res.writeHead(200, { 'content-type': req.headers['content-type'] ?? 'application/x-protobuf' }).end();
        } catch (error) {
          res.writeHead(400).end(String(error));
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.port, '127.0.0.1', () => resolve());
    });
  }

  add(spans: Span[]) {
    this.lastArrival = Date.now();
    for (const span of spans) {
      const list = this.spans.get(span.traceId) ?? [];
      list.push(span);
      this.spans.set(span.traceId, list);
    }
  }

  /** Backends export in batches: wait until a trace has been quiet a moment, or `maxMs` has passed. */
  async settle(quietMs = 400, maxMs = 3000): Promise<void> {
    const deadline = Date.now() + maxMs;
    const started = Date.now();
    while (Date.now() < deadline) {
      if (Date.now() - Math.max(this.lastArrival, started) >= quietMs) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /**
   * The spans of one trace, each under the step whose id its chain of parents reaches: `steps` maps a step's
   * span id to its index and the epoch ms it began. Spans of the trace that reach no step are left out.
   */
  take(traceId: string, steps: Map<string, { index: number; startedMs: number }>): Map<number, BackendSpan[]> {
    const spans = this.spans.get(traceId) ?? [];
    this.spans.delete(traceId);
    const byId = new Map(spans.map((s) => [s.spanId, s]));
    const out = new Map<number, BackendSpan[]>();
    const place = (span: Span): { step: number; depth: number } | undefined => {
      let depth = 0;
      for (let at: Span | undefined = span; at; depth++) {
        const step = at.parentSpanId ? steps.get(at.parentSpanId) : undefined;
        if (step) return { step: step.index, depth };
        at = at.parentSpanId ? byId.get(at.parentSpanId) : undefined;
      }
      return undefined;
    };
    for (const span of [...spans].sort((a, b) => (a.startNs < b.startNs ? -1 : 1))) {
      const where = place(span);
      if (!where) continue;
      const startedMs = [...steps.values()].find((s) => s.index === where.step)!.startedMs;
      const attributes = Object.fromEntries(Object.entries(span.attributes).filter(([k]) => KEEP.test(k)));
      const list = out.get(where.step) ?? [];
      list.push({
        name: span.name,
        kind: KINDS[span.kind] ?? 'internal',
        at: Math.max(0, Math.round(Number(span.startNs / 1_000_000n) - startedMs)),
        ms: Math.round(Number(span.endNs - span.startNs) / 1e5) / 10,
        depth: where.depth,
        ...(span.service ? { service: span.service } : {}),
        ...(span.error ? { error: span.error } : {}),
        ...(Object.keys(attributes).length ? { attributes } : {}),
      });
      out.set(where.step, list);
    }
    return out;
  }

  close() {
    this.server?.close();
  }
}

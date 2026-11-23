// A stand-in for an Exact host's stdio carrier, for the adapter's tests. It answers the JSON-lines ops the way Exact's
// driver documents them (tree, layout, state, tap, type, clock) for one small app: a counter, a name field and a
// "resend" countdown that ticks once per second of the app's own clock, which moves only when a `clock` op moves it.
import readline from 'node:readline';

let clock = 0;
let count = 0;
let name = '';
let focused = false;
let sent = false;
let sentAt = 0;
let route = 'Home';

const remaining = () => (sent ? Math.max(0, 3 - Math.floor((clock - sentAt) / 1000)) : null);

const nodes = () => {
  const list = [
    { id: 1, type: 'View', depth: 0, props: {} },
    { id: 2, type: 'Text', depth: 1, props: { text: `Count: ${count}`, testId: 'count' } },
    { id: 3, type: 'Control', depth: 1, props: { testId: 'increment' }, handlers: ['press'] },
    { id: 4, type: 'Text', depth: 2, props: { text: 'Add one' } },
    { id: 5, type: 'TextInput', depth: 1, props: { testId: 'name', value: name, placeholder: 'Your name', focused } },
    { id: 6, type: 'Control', depth: 1, props: { testId: 'send' }, handlers: ['press'] },
    { id: 7, type: 'Text', depth: 2, props: { text: 'Send code' } },
    { id: 8, type: 'Control', depth: 1, props: { testId: 'locked', disabled: true }, handlers: ['press'] },
    { id: 9, type: 'Text', depth: 2, props: { text: 'Locked' } },
  ];
  const left = remaining();
  if (left !== null) list.push({ id: 10, type: 'Text', depth: 1, props: { text: left > 0 ? `Resend in ${left}` : 'Resend now', testId: 'resend' } });
  return list;
};

const boxes = () => nodes().map((n) => ({ id: n.id, testId: n.props.testId, x: 16, y: 40 + n.id * 48, w: 200, h: 44 }));

const reply = (request) => {
  switch (request.op) {
    case 'tree':
      return { clock, route, nodes: nodes() };
    case 'layout':
      return { clock, viewport: { w: 402, h: 874 }, nodes: boxes() };
    case 'state':
      return { clock, slots: { count, name } };
    case 'tap':
      if (request.back) {
        route = 'Home';
        return { ok: true };
      }
      if (request.id === 3) count += 1;
      if (request.id === 5) focused = true;
      if (request.id === 6 && !sent) {
        sent = true;
        sentAt = clock;
      }
      return { ok: true, id: request.id };
    case 'type':
      if (request.id !== 5) return { error: 'not a field' };
      if (request.key) return { ok: true };
      name = request.text === '' ? '' : name + request.text;
      return { ok: true, value: name };
    case 'clock':
      if (request.settle) return { settled: true, inFlight: 0, nextDueMs: remaining() ? 1000 - ((clock - sentAt) % 1000) : null };
      if (typeof request.to === 'number') clock = Math.max(clock, request.to);
      return { clock };
    default:
      return { error: `unknown op ${request.op}` };
  }
};

for await (const line of readline.createInterface({ input: process.stdin })) {
  process.stdout.write(`${JSON.stringify(reply(JSON.parse(line)))}\n`);
}

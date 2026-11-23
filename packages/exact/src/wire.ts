import { type ChildProcessByStdio, spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

/** One request to an Exact host and its reply: `{"op": "tree"}` in, a JSON object out. */
export type ExactWire = {
  ask(request: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): void;
  /** What the host wrote that was not a reply (its own log lines). */
  readonly hostLines: string[];
  /** Why the host stopped answering, once it has. */
  readonly failure: Error | null;
};

const HOST_LINES = 200;

/**
 * Exact's native carriers speak JSON lines over a duplex: each request line is answered by the next line the host
 * writes. A line that is not JSON is the host's own output and is kept for the error that explains a dead host.
 */
export const jsonLinesWire = (readable: Readable, writable: Writable, onClose?: () => void): ExactWire => {
  const waiting: { resolve: (reply: Record<string, unknown>) => void; reject: (error: Error) => void }[] = [];
  const hostLines: string[] = [];
  let failure: Error | null = null;
  let buffer = '';
  readable.setEncoding('utf8');
  readable.on('data', (chunk: string) => {
    buffer += chunk;
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      const next = waiting.shift();
      if (!next) {
        hostLines.push(line);
        if (hostLines.length > HOST_LINES) hostLines.shift();
        continue;
      }
      try {
        next.resolve(JSON.parse(line) as Record<string, unknown>);
      } catch {
        next.reject(new Error(`unreadable reply from the Exact host: ${line.slice(0, 200)}`));
      }
    }
  });
  const fail = (why: string) => {
    failure ??= new Error(`${why}${hostLines.length ? `\n${hostLines.slice(-10).join('\n')}` : ''}`);
    for (const w of waiting.splice(0)) w.reject(failure);
  };
  readable.on('close', () => fail('the Exact host closed its output'));
  writable.on('error', (error) => fail(`the Exact host's input failed: ${error.message}`));
  return {
    hostLines,
    get failure() {
      return failure;
    },
    ask: (request) => {
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        waiting.push({ resolve, reject });
        writable.write(`${JSON.stringify(request)}\n`);
      });
    },
    close: () => {
      onClose?.();
      fail('the Exact host was closed');
    },
  };
};

/** Starts an Exact host binary (`EXACT_LINUX_BIN`, `EXACT_MAC_BIN`, or a command that runs one) and talks to its stdio. */
export const spawnWire = (command: string, args: string[] = [], env: NodeJS.ProcessEnv = {}): ExactWire => {
  const child: ChildProcessByStdio<Writable, Readable, Readable> = spawn(command, args, {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const wire = jsonLinesWire(child.stdout, child.stdin, () => child.kill());
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    for (const line of chunk.split('\n')) if (line) wire.hostLines.push(line);
  });
  child.on('error', (error) => wire.hostLines.push(`spawn failed: ${error.message}`));
  return wire;
};

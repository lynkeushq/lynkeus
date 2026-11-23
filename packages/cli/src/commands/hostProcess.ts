import { spawn } from 'node:child_process';

import { describeExplanations, explainError } from '../knowledge/errors.js';
import type { Ctx } from '../registry.js';

/** Runs a host in a process group of its own, passes signals on, and explains its crash when it ends in one. */
export const runHost = async (ctx: Ctx, command: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> => {
  const child = spawn(command, args, {
    cwd: ctx.root,
    stdio: ['inherit', 'inherit', 'pipe'],
    env,
    // Its own process group: the runner (npx and jest, or flutter and flutter_tester) and the host end together.
    // Stopping only npx left the host dialing the port, where a later run's driver took it for the app it meant to drive.
    detached: true,
  });
  const stop = (signal: NodeJS.Signals) => {
    try {
      if (child.pid) process.kill(-child.pid, signal);
    } catch {
      // already gone
    }
  };
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const forward = signals.map((signal) => {
    const handler = () => stop(signal);
    process.on(signal, handler);
    return () => process.off(signal, handler);
  });
  const onExit = () => stop('SIGTERM');
  process.on('exit', onExit);
  let tail = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(chunk);
    tail = (tail + chunk.toString()).slice(-20000);
  });
  const code = await new Promise<number>((resolve) => child.on('exit', (c) => resolve(c ?? 0)));
  for (const off of forward) off();
  process.off('exit', onExit);
  if (code) {
    const found = explainError(tail);
    if (found.length) ctx.err(describeExplanations(found));
  }
  return code;
};

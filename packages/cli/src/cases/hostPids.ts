import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Where a case run lists the hosts it started and that have not exited yet, by its progress file. */
export const hostsFileOf = (progressFile: string): string => `${progressFile}.hosts`;

/**
 * The hosts a case run started, kept in a file as they come and go. Each host is the leader of its own process
 * group, so a run that dies without stopping them (out of memory, killed) leaves them running with nothing to
 * stop them: whoever started that run (`lynkeus ci`) reads the file and stops what is left.
 */
export class HostPids {
  readonly #file: string | undefined;
  readonly #pids = new Set<number>();

  constructor(file: string | undefined) {
    this.#file = file;
    // A list left by an earlier run names processes long gone, whose pids may be someone else's by now.
    if (file) fs.rmSync(file, { force: true });
  }

  add(host: ChildProcess): void {
    const pid = host.pid;
    if (!pid) return;
    this.#pids.add(pid);
    this.#write();
    host.once('exit', () => {
      this.#pids.delete(pid);
      this.#write();
    });
  }

  #write(): void {
    if (!this.#file) return;
    try {
      if (this.#pids.size === 0) fs.rmSync(this.#file, { force: true });
      else {
        fs.mkdirSync(path.dirname(this.#file), { recursive: true });
        fs.writeFileSync(this.#file, `${[...this.#pids].join('\n')}\n`);
      }
    } catch {
      // The run directory was removed under the run: there is nothing left to tell.
    }
  }
}

const groupAlive = (pid: number): boolean => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const signalGroup = (pid: number, signal: NodeJS.Signals) => {
  try {
    process.kill(-pid, signal);
  } catch {
    // Gone meanwhile.
  }
};

/**
 * Stops the process groups of the hosts a case run listed in `file` and did not see exit: SIGTERM, then SIGKILL for
 * any still there after `graceMs`. Answers how many there were; the file is removed.
 */
export const stopLeftHosts = async (file: string, graceMs = 2000): Promise<number> => {
  let pids: number[];
  try {
    pids = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .map(Number)
      .filter((pid) => Number.isInteger(pid) && pid > 1);
  } catch {
    return 0;
  }
  fs.rmSync(file, { force: true });
  const left = pids.filter(groupAlive);
  for (const pid of left) signalGroup(pid, 'SIGTERM');
  const until = Date.now() + graceMs;
  while (left.some(groupAlive) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  for (const pid of left.filter(groupAlive)) signalGroup(pid, 'SIGKILL');
  return left.length;
};

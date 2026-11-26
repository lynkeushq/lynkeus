import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

// The runs of this process by port, described: an MCP server or a session runs case_run calls side by side in one
// process, so the pid in a claim file cannot tell them apart.
const ours = new Map<number, string>();

/**
 * A run lets go of its driver port between cases, and the app dials whichever driver is listening: two runs
 * on one port take turns at the app, and each reports steps the other drove. A run claims its ports for as
 * long as it lasts; what it answers is the release, or why another run holds one. `run` describes this run, for
 * the refusal another run of this process gets.
 */
export const claimPorts = (ports: number[], dir = os.tmpdir(), run = 'a case run'): { release: () => void } | { refused: string } => {
  const busy = ports.find((port) => ours.has(port));
  if (busy !== undefined)
    return {
      refused: `port ${busy} is driving the app for another case run of this Lynkeus, still going: ${ours.get(busy)}. Wait for it (case status), or stop it (case stop; case_stop over MCP), then run again`,
    };
  const held: string[] = [];
  const mine: number[] = [];
  const release = () => {
    for (const port of mine.splice(0)) ours.delete(port);
    for (const file of held) {
      try {
        if (fs.readFileSync(file, 'utf8').trim() === String(process.pid)) fs.unlinkSync(file);
      } catch {
        // Already gone.
      }
    }
  };
  for (const port of ports) {
    const file = path.join(dir, `lynkeus-port-${port}.pid`);
    for (;;) {
      try {
        fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
        held.push(file);
        mine.push(port);
        ours.set(port, run);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const owner = Number(fs.readFileSync(file, 'utf8').trim());
      if (Number.isInteger(owner) && owner > 0 && owner !== process.pid && alive(owner)) {
        release();
        return {
          refused: `port ${port} is held by another lynkeus case run (pid ${owner}), which is probably still going: stop it, or give this run other --ports`,
        };
      }
      // Left by a run that ended without letting go.
      fs.rmSync(file, { force: true });
    }
  }
  return { release };
};

/**
 * Cases side by side (`case run --jobs`) share one backend. A case marked `exclusive` changes what every case sees (a
 * global flag, a setting for all users), so it runs alone: it waits for the cases in flight to end, and no other
 * starts until it ends. A case waiting to run alone goes before cases that ask after it, so a steady stream of
 * others cannot keep it waiting.
 */
export class Turns {
  #running = 0;
  #alone = false;
  #waitingAlone = 0;
  #waiters: (() => void)[] = [];

  /** Resolves when this case may start; call what it returns when the case has ended. */
  async take(alone: boolean): Promise<() => void> {
    if (alone) this.#waitingAlone += 1;
    while (alone ? this.#running > 0 : this.#alone || this.#waitingAlone > 0) await new Promise<void>((resolve) => this.#waiters.push(resolve));
    if (alone) {
      this.#waitingAlone -= 1;
      this.#alone = true;
    }
    this.#running += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#running -= 1;
      if (alone) this.#alone = false;
      const waiting = this.#waiters;
      this.#waiters = [];
      for (const wake of waiting) wake();
    };
  }

  /** Whether a case asking now would have to wait. */
  busy(alone: boolean): boolean {
    return alone ? this.#running > 0 : this.#alone || this.#waitingAlone > 0;
  }
}

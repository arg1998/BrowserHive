/** @module app/templates/keyed-queue — one task at a time per key (a template's state writes: checkpoint, versions, restore and seed never interleave, spec 13 §3.9 single writer). */

/** Runs tasks for the same key strictly one after another; different keys run in parallel. */
export class KeyedQueue {
  readonly #tails = new Map<string, Promise<unknown>>();

  /** Runs `task` after every task queued before it for `key`; its result or error is returned. */
  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    const next = previous.then(task, task);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.#tails.set(key, tail);
    void tail.then(() => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    });
    return next;
  }

  /** True while a task for `key` is queued or running. */
  busy(key: string): boolean {
    return this.#tails.has(key);
  }
}

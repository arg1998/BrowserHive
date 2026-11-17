/** @module kernel/bounded — runs reads over a list with bounded concurrency and stops at an abort signal (an overall deadline): what was not read by then is `null`. */

/** Options of {@link readBounded}. */
export interface BoundedReadOptions {
  /** At most this many reads run at once (at least 1). */
  readonly concurrency: number;
  /** When it aborts (an overall deadline), no new read starts and the call resolves at once. */
  readonly signal?: AbortSignal;
}

/**
 * Reads every item with at most `concurrency` reads in flight. Resolves with one result per item, in
 * order: the read's value, or `null` when it failed, returned `null`, or had not finished when
 * `signal` aborted (reads still running then are left to settle on their own; their results are
 * dropped).
 */
export function readBounded<T, R>(
  items: readonly T[],
  read: (item: T) => Promise<R | null>,
  options: BoundedReadOptions,
): Promise<(R | null)[]> {
  const results: (R | null)[] = items.map(() => null);
  const signal = options.signal;
  if (items.length === 0 || signal?.aborted === true) return Promise.resolve(results);
  const width = Math.max(1, Math.min(Math.floor(options.concurrency), items.length));
  let next = 0;
  let done = false;
  return new Promise((resolve) => {
    const finish = (): void => {
      if (done) return;
      done = true;
      signal?.removeEventListener('abort', finish);
      resolve(results.slice());
    };
    signal?.addEventListener('abort', finish, { once: true });
    const worker = async (): Promise<void> => {
      while (!done && next < items.length) {
        const index = next++;
        const value = await read(items[index] as T).catch(() => null);
        if (!done) results[index] = value;
      }
    };
    void Promise.all(Array.from({ length: width }, worker)).then(finish);
  });
}

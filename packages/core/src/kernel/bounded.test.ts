/** @module kernel/bounded.test — `readBounded`: order kept, at most `concurrency` in flight, failures and late reads are `null`, the signal stops it at once. */

import { describe, expect, it } from 'bun:test';
import { readBounded } from './bounded.ts';

/** A read per item that resolves only when the test says so. */
function controlled<T>() {
  const pending = new Map<T, (value: number | null) => void>();
  let inFlight = 0;
  let peak = 0;
  const read = (item: T): Promise<number | null> => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    return new Promise<number | null>((resolve) => {
      pending.set(item, (value) => {
        inFlight -= 1;
        pending.delete(item);
        resolve(value);
      });
    });
  };
  return { read, pending, peak: () => peak };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('readBounded', () => {
  it('keeps the order of the items and runs at most `concurrency` reads at once', async () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    const c = controlled<number>();
    const all = readBounded(items, c.read, { concurrency: 8 });
    for (let round = 0; round < 5; round += 1) {
      await tick();
      expect(c.pending.size).toBeLessThanOrEqual(8);
      for (const item of [...c.pending.keys()].reverse()) c.pending.get(item)?.(item * 10);
      await tick();
    }
    expect(await all).toEqual(items.map((i) => i * 10));
    expect(c.peak()).toBe(8);
  });

  it('a failed or empty read is null and does not stop the others', async () => {
    const out = await readBounded(
      [1, 2, 3],
      async (i) => {
        if (i === 2) throw new Error('page gone');
        return i === 3 ? null : i;
      },
      { concurrency: 2 },
    );
    expect(out).toEqual([1, null, null]);
  });

  it('an abort resolves at once: finished reads kept, the rest null, no new read starts', async () => {
    const c = controlled<number>();
    const deadline = new AbortController();
    const all = readBounded([0, 1, 2, 3, 4], c.read, { concurrency: 2, signal: deadline.signal });
    await tick();
    c.pending.get(0)?.(100);
    await tick();
    expect([...c.pending.keys()]).toEqual([1, 2]);
    deadline.abort();
    expect(await all).toEqual([100, null, null, null, null]);
    c.pending.get(1)?.(1);
    c.pending.get(2)?.(2);
    await tick();
    expect(c.pending.size).toBe(0);
  });

  it('nothing to read, or an aborted signal, resolves without reading', async () => {
    let reads = 0;
    const read = async () => {
      reads += 1;
      return 1;
    };
    expect(await readBounded([], read, { concurrency: 4 })).toEqual([]);
    expect(
      await readBounded([1, 2], read, { concurrency: 4, signal: AbortSignal.abort() }),
    ).toEqual([null, null]);
    expect(reads).toBe(0);
    expect(await readBounded([1, 2], read, { concurrency: 0 })).toEqual([1, 1]);
  });
});

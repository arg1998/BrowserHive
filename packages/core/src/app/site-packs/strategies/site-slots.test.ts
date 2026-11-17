/** @module app/site-packs/strategies/site-slots.test — `serialize-site` turns with a fake clock (spec 13 §9.4): at most `max_parallel` sessions at once, FIFO waiting, a refusal after exactly 30 s, aborts leave the queue, a session's own concurrent calls share its turn, and a released turn lets the next one in. */

import { describe, expect, it } from 'bun:test';
import { FakeClock } from '../../../../test/helpers/fake-clock.ts';
import { SERIALIZE_WAIT_MS, SiteSlots, type SlotTurn } from './site-slots.ts';

const KEY = 'tp-1\u0000site-a.test';
const never = new AbortController().signal;

function turnOf(value: SlotTurn | 'timeout'): SlotTurn {
  if (value === 'timeout') throw new Error('timed out');
  return value;
}

/** Lets pending promise continuations run. */
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('SiteSlots', () => {
  it('lets max_parallel sessions in at once and queues the next', async () => {
    const clock = new FakeClock();
    const slots = new SiteSlots(clock);
    const a = turnOf(await slots.acquire(KEY, 's-a', 2, never));
    const b = turnOf(await slots.acquire(KEY, 's-b', 2, never));
    const cGot: { v: SlotTurn | 'timeout' | null } = { v: null };
    void slots.acquire(KEY, 's-c', 2, never).then((t) => {
      cGot.v = t;
    });
    await flush();
    expect(cGot.v).toBeNull();
    expect(slots.holders(KEY)).toBe(2);
    expect(slots.waiting(KEY)).toBe(1);
    await clock.advance(1_200);
    a.release();
    await flush();
    expect(cGot.v).not.toBeNull();
    expect(turnOf(cGot.v ?? 'timeout').waitedMs).toBe(1_200);
    b.release();
    turnOf(cGot.v ?? 'timeout').release();
    expect(slots.holders(KEY)).toBe(0);
  });

  it('grants waiting turns in FIFO order', async () => {
    const clock = new FakeClock();
    const slots = new SiteSlots(clock);
    const first = turnOf(await slots.acquire(KEY, 's-1', 1, never));
    const order: string[] = [];
    const waiters = ['s-2', 's-3', 's-4'].map((id) =>
      slots.acquire(KEY, id, 1, never).then((t) => {
        order.push(id);
        return turnOf(t);
      }),
    );
    await flush();
    first.release();
    (await waiters[0])?.release();
    (await waiters[1])?.release();
    (await waiters[2])?.release();
    expect(order).toEqual(['s-2', 's-3', 's-4']);
  });

  it('refuses after exactly the 30 s wait (the production constant)', async () => {
    expect(SERIALIZE_WAIT_MS).toBe(30_000);
    const clock = new FakeClock();
    const slots = new SiteSlots(clock);
    turnOf(await slots.acquire(KEY, 's-1', 1, never));
    const outcome: { v: SlotTurn | 'timeout' | null } = { v: null };
    void slots.acquire(KEY, 's-2', 1, never).then((t) => {
      outcome.v = t;
    });
    await flush();
    await clock.advance(29_999);
    await flush();
    expect(outcome.v).toBeNull();
    await clock.advance(1);
    await flush();
    expect(outcome.v).toBe('timeout');
    expect(slots.waiting(KEY)).toBe(0);
  });

  it('an aborted wait leaves the queue and rejects with the signal reason', async () => {
    const clock = new FakeClock();
    const slots = new SiteSlots(clock);
    const held = turnOf(await slots.acquire(KEY, 's-1', 1, never));
    const controller = new AbortController();
    const waiting = slots.acquire(KEY, 's-2', 1, controller.signal);
    const later = slots.acquire(KEY, 's-3', 1, never);
    await flush();
    controller.abort(new Error('cancelled'));
    await expect(waiting).rejects.toThrow('cancelled');
    held.release();
    expect(turnOf(await later).waitedMs).toBe(0);
    await expect(slots.acquire(KEY, 's-4', 1, controller.signal)).rejects.toThrow('cancelled');
  });

  it("a session's own concurrent calls share its turn", async () => {
    const slots = new SiteSlots(new FakeClock());
    const one = turnOf(await slots.acquire(KEY, 's-1', 1, never));
    const two = turnOf(await slots.acquire(KEY, 's-1', 1, never));
    expect(slots.holders(KEY)).toBe(1);
    one.release();
    one.release();
    expect(slots.holders(KEY)).toBe(1);
    two.release();
    expect(slots.holders(KEY)).toBe(0);
  });

  it('the wait budget is a test seam', async () => {
    const clock = new FakeClock();
    const slots = new SiteSlots(clock, 500);
    turnOf(await slots.acquire(KEY, 's-1', 1, never));
    const waiting = slots.acquire(KEY, 's-2', 1, never);
    await flush();
    await clock.advance(500);
    expect(await waiting).toBe('timeout');
  });
});

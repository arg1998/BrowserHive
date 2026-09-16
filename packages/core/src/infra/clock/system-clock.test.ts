/** @module infra/clock/system-clock.test — system and fake clocks. */

import { describe, expect, it } from 'bun:test';
import { createFakeClock, createSystemClock } from './system-clock.ts';

describe('createSystemClock', () => {
  it('returns epoch milliseconds that move forward', async () => {
    const clock = createSystemClock();
    const a = clock.now();
    await clock.sleep(5);
    expect(clock.now()).toBeGreaterThanOrEqual(a + 4);
  });

  it('sleep rejects with the abort reason', async () => {
    const clock = createSystemClock();
    const controller = new AbortController();
    const pending = clock.sleep(1000, controller.signal);
    controller.abort(new Error('stop'));
    await expect(pending).rejects.toThrow('stop');
  });

  it('sleep rejects immediately when already aborted', async () => {
    const clock = createSystemClock();
    const controller = new AbortController();
    controller.abort('early');
    await expect(clock.sleep(10, controller.signal)).rejects.toBe('early');
  });
});

describe('createFakeClock', () => {
  it('is deterministic and advances on sleep', async () => {
    const clock = createFakeClock(1_000);
    expect(clock.now()).toBe(1_000);
    clock.advance(5);
    expect(clock.now()).toBe(1_005);
    await clock.sleep(10);
    expect(clock.now()).toBe(1_015);
    clock.set(7);
    expect(clock.now()).toBe(7);
  });
});

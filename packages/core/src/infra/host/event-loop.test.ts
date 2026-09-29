/** @module infra/host/event-loop.test — the event-loop delay monitor behind `browserhive.process.event_loop_lag` (spec 10 §7): a blocked loop shows up in the window's p99, and each read starts a new window. */

import { describe, expect, it } from 'bun:test';
import { startEventLoopLagMonitor } from './event-loop.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('startEventLoopLagMonitor', () => {
  it('reports the p99 delay of the window in ms, then resets', async () => {
    const monitor = startEventLoopLagMonitor(5);
    expect(monitor).not.toBeNull();
    await sleep(30);
    // Block the loop for ~60 ms.
    const until = performance.now() + 60;
    while (performance.now() < until) {
      // busy wait
    }
    await sleep(30);
    const p99 = monitor?.takeP99Ms() ?? null;
    expect(p99).toBeGreaterThan(20);
    expect(p99).toBeLessThan(10_000);
    await sleep(30);
    const next = monitor?.takeP99Ms() ?? null;
    // The next window did not block, so its p99 is far below the blocked one.
    expect(next === null || next < (p99 ?? 0)).toBe(true);
    monitor?.stop();
    monitor?.stop();
  });
});

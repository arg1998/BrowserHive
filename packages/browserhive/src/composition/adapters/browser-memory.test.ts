/** @module composition/adapters/browser-memory.test — the 10 s browser-memory sampler behind `browserhive.browser.rss_bytes` (spec 10 §7): one tree per live session keyed by session id, sessions without a pid skipped, overlapping samples coalesced, no timer without a reader, stop. */

import { describe, expect, it } from 'bun:test';
import type { ProcessTreeReader } from '@browserhive/core/runtime';
import { startBrowserMemorySampler } from './browser-memory.ts';

function manualTimer() {
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  return {
    timers,
    repeat: (fn: () => void, ms: number) => {
      const t = { fn, ms, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
  };
}

describe('startBrowserMemorySampler', () => {
  it('samples at once and every 10 s, one process tree per session', async () => {
    const reads: number[][] = [];
    const reader: ProcessTreeReader = {
      rssOfTrees: async (roots) => {
        reads.push([...roots]);
        return new Map(roots.filter((pid) => pid !== 30).map((pid) => [pid, pid * 1000]));
      },
    };
    let sessions = [
      { id: 's-a', browserPid: async () => 10 },
      { id: 's-b', browserPid: async () => 20 },
      { id: 's-launching' },
      { id: 's-unreadable', browserPid: async () => null },
      { id: 's-gone', browserPid: async () => 30 },
    ];
    const timer = manualTimer();
    const sampler = startBrowserMemorySampler({
      sessions: () => sessions,
      reader,
      repeat: timer.repeat,
    });
    await sampler.sample();
    expect(timer.timers.map((t) => t.ms)).toEqual([10_000]);
    expect(reads[0]).toEqual([10, 20, 30]);
    expect([...sampler.latest()]).toEqual([
      ['s-a', 10_000],
      ['s-b', 20_000],
    ]);
    // A closed session disappears at the next sample.
    sessions = sessions.slice(0, 1);
    timer.timers[0]?.fn();
    await sampler.sample();
    expect([...sampler.latest()]).toEqual([['s-a', 10_000]]);
    sampler.stop();
    expect(timer.timers[0]?.cancelled).toBe(true);
    expect(sampler.latest().size).toBe(0);
  });

  it('coalesces a sample requested while one is running', async () => {
    let release: () => void = () => undefined;
    let calls = 0;
    const reader: ProcessTreeReader = {
      rssOfTrees: () => {
        calls++;
        return new Promise((resolve) => {
          release = () => resolve(new Map([[10, 1]]));
        });
      },
    };
    const sampler = startBrowserMemorySampler({
      sessions: () => [{ id: 's-a', browserPid: async () => 10 }],
      reader,
      repeat: manualTimer().repeat,
    });
    const second = sampler.sample();
    await new Promise((resolve) => setTimeout(resolve, 5));
    release();
    await second;
    expect(calls).toBe(1);
    sampler.stop();
  });

  it('never starts a timer without a reader (Windows)', async () => {
    const timer = manualTimer();
    const sampler = startBrowserMemorySampler({
      sessions: () => [{ id: 's-a', browserPid: async () => 10 }],
      reader: null,
      repeat: timer.repeat,
    });
    await sampler.sample();
    expect(timer.timers).toEqual([]);
    expect(sampler.latest().size).toBe(0);
    sampler.stop();
  });

  it('reports a failing read and keeps the previous sample', async () => {
    const errors: unknown[] = [];
    let fail = false;
    const sampler = startBrowserMemorySampler({
      sessions: () => [{ id: 's-a', browserPid: async () => 10 }],
      reader: {
        rssOfTrees: async () => {
          if (fail) throw new Error('boom');
          return new Map([[10, 5]]);
        },
      },
      repeat: manualTimer().repeat,
      onError: (err) => errors.push(err),
    });
    await sampler.sample();
    fail = true;
    await sampler.sample();
    expect(errors).toHaveLength(1);
    expect([...sampler.latest()]).toEqual([['s-a', 5]]);
    sampler.stop();
  });
});

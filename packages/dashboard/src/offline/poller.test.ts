/** @module offline/poller.test — the offline page's probe schedule: 1, 2, 3, 3 … s, the hidden pause, immediate probes and Retry now's reset (04 §18.6.4) */
import { describe, expect, it } from 'bun:test';
import type { ProbeOutcome } from '@/lib/daemon-help/probe.ts';
import { manualTimers } from '../../test/helpers/manual-timers.ts';
import { Poller } from './poller.ts';

function setup() {
  const timers = manualTimers();
  const starts: number[] = [];
  let visible = true;
  const outcomes: ProbeOutcome[] = [];
  const poller = new Poller({
    probe: async () => {
      starts.push(timers.clock());
      return { kind: 'rejected' };
    },
    timers,
    clock: timers.clock,
    isVisible: () => visible,
    onProbe: () => undefined,
    onOutcome: (outcome) => outcomes.push(outcome),
  });
  const t0 = timers.clock();
  return {
    timers,
    poller,
    outcomes,
    /** Seconds after start of each probe. */
    at: () => starts.map((ms) => (ms - t0) / 1000),
    setVisible: (value: boolean) => {
      visible = value;
    },
  };
}

describe('Poller', () => {
  it('probes at load, then after 1 s, 2 s and every 3 s', async () => {
    const h = setup();
    h.poller.start();
    await h.timers.advance(15_000);
    expect(h.at()).toEqual([0, 1, 3, 6, 9, 12, 15]);
    expect(h.outcomes).toHaveLength(7);
  });

  it('exposes when the next probe starts', async () => {
    const h = setup();
    h.poller.start();
    await h.timers.flush();
    expect(h.poller.nextAt).toBe(h.timers.clock() + 1_000);
  });

  it('never probes while hidden, and probes at once on becoming visible', async () => {
    const h = setup();
    h.poller.start();
    await h.timers.advance(1_000);
    h.setVisible(false);
    h.poller.visibilityChanged();
    expect(h.poller.nextAt).toBeNull();
    await h.timers.advance(60_000);
    expect(h.at()).toEqual([0, 1]);
    h.setVisible(true);
    h.poller.visibilityChanged();
    await h.timers.advance(3_000);
    expect(h.at()).toEqual([0, 1, 61, 64]);
  });

  it('does not start while the page loads hidden', async () => {
    const h = setup();
    h.setVisible(false);
    h.poller.start();
    await h.timers.advance(10_000);
    expect(h.at()).toEqual([]);
  });

  it('Retry now probes at once and restarts the 1, 2, 3 s schedule', async () => {
    const h = setup();
    h.poller.start();
    await h.timers.advance(7_000);
    expect(h.at()).toEqual([0, 1, 3, 6]);
    h.poller.probeNow(true);
    await h.timers.advance(4_000);
    expect(h.at()).toEqual([0, 1, 3, 6, 7, 8, 10]);
  });

  it('online probes at once but keeps the schedule', async () => {
    const h = setup();
    h.poller.start();
    await h.timers.advance(3_500);
    h.poller.probeNow(false);
    await h.timers.advance(3_000);
    expect(h.at()).toEqual([0, 1, 3, 3.5, 6.5]);
  });

  it('stops for good', async () => {
    const h = setup();
    h.poller.start();
    await h.timers.flush();
    h.poller.stop();
    h.poller.probeNow(true);
    await h.timers.advance(10_000);
    expect(h.at()).toEqual([0]);
  });
});

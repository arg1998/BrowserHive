/** @module app/sessions/lease-sweeper.test — reaping with a FakeClock, per-item isolation, timer safety. */
import { describe, expect, it } from 'bun:test';
import { CollectingLogger } from '../../../test/helpers/collecting-logger.ts';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import type { Session } from '../../domain/session/session.ts';
import { LeaseSweeper, type SweepScheduler } from './lease-sweeper.ts';
import { testSession } from './test-support.ts';

const T0 = 1_700_000_000_000;
const WINDOW = 7_200_000;

function live(id: string, clock: FakeClock): Session {
  const session = testSession({ id, createdAt: clock.now(), leaseWindowMs: WINDOW });
  session.apply({ type: 'launch', phase: 'launch', at: clock.now() });
  session.apply({ type: 'launched', at: clock.now() });
  return session;
}

function setup() {
  const clock = new FakeClock(T0);
  const sessions = new Map<string, Session>();
  const closed: { id: string; reason: string }[] = [];
  const failing = new Set<string>();
  const target = {
    listAll: () => [...sessions.values()],
    close: async (
      id: string,
      reason:
        | 'user'
        | 'crash'
        | 'lease_expired'
        | 'shutdown'
        | 'operator'
        | 'interrupted'
        | 'launch_failed',
    ) => {
      if (failing.has(id)) throw new Error('close exploded');
      if (!sessions.has(id)) return false;
      sessions.delete(id);
      closed.push({ id, reason });
      return true;
    },
  };
  const logger = new CollectingLogger();
  const ticks: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const scheduler: SweepScheduler = {
    setInterval: (fn, ms) => {
      const entry = { fn, ms, cleared: false };
      ticks.push(entry);
      return () => {
        entry.cleared = true;
      };
    },
  };
  const sweeper = new LeaseSweeper({ target, clock, logger, scheduler, intervalMs: 60_000 });
  return { clock, sessions, closed, failing, logger, ticks, sweeper };
}

describe('LeaseSweeper', () => {
  it('reaps lease-expired sessions with reason lease_expired', async () => {
    const { clock, sessions, closed, sweeper } = setup();
    const a = live('a-00000001', clock);
    sessions.set(a.id, a);
    expect(await sweeper.sweepOnce()).toEqual([]);
    await clock.advance(WINDOW);
    expect(await sweeper.sweepOnce()).toEqual([{ sessionId: a.id, reason: 'lease_expired' }]);
    expect(closed).toEqual([{ id: a.id, reason: 'lease_expired' }]);
  });

  it('reaps crashed sessions with reason crash, before their lease runs out', async () => {
    const { clock, sessions, closed, sweeper } = setup();
    const a = live('a-00000001', clock);
    a.apply({ type: 'crash', detail: 'browser disconnected', at: clock.now() });
    sessions.set(a.id, a);
    expect(await sweeper.sweepOnce()).toEqual([{ sessionId: a.id, reason: 'crash' }]);
    expect(closed[0]?.reason).toBe('crash');
  });

  it('never reaps a session whose lease is paused, and resumes where it left off', async () => {
    const { clock, sessions, sweeper } = setup();
    const a = live('a-00000001', clock);
    sessions.set(a.id, a);
    await clock.advance(WINDOW - 1000);
    a.apply({ type: 'pause', reason: 'attention', at: clock.now() });
    a.pauseLease(clock.now());
    await clock.advance(WINDOW * 10);
    expect(await sweeper.sweepOnce()).toEqual([]);
    a.apply({ type: 'resume', at: clock.now() });
    a.resumeLease(clock.now());
    expect(await sweeper.sweepOnce()).toEqual([]);
    await clock.advance(1000);
    expect(await sweeper.sweepOnce()).toEqual([{ sessionId: a.id, reason: 'lease_expired' }]);
  });

  it('isolates a failing close: the other items are still reaped and the failure is logged', async () => {
    const { clock, sessions, closed, failing, logger, sweeper } = setup();
    const a = live('a-00000001', clock);
    const b = live('b-00000001', clock);
    sessions.set(a.id, a);
    sessions.set(b.id, b);
    failing.add(a.id);
    await clock.advance(WINDOW);
    expect(await sweeper.sweepOnce()).toEqual([{ sessionId: b.id, reason: 'lease_expired' }]);
    expect(closed.map((c) => c.id)).toEqual([b.id]);
    expect(logger.has('reap failed')).toBe(true);
  });

  it('start/stop are idempotent and the timer tick never throws', async () => {
    const { ticks, sweeper, sessions, clock, failing, logger } = setup();
    sweeper.start();
    sweeper.start();
    expect(ticks).toHaveLength(1);
    expect(ticks[0]?.ms).toBe(60_000);
    const a = live('a-00000001', clock);
    sessions.set(a.id, a);
    failing.add(a.id);
    await clock.advance(WINDOW);
    expect(() => ticks[0]?.fn()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(logger.has('reap failed')).toBe(true);
    sweeper.stop();
    sweeper.stop();
    expect(ticks[0]?.cleared).toBe(true);
  });

  it('coalesces overlapping passes', async () => {
    const { clock, sessions, sweeper } = setup();
    const a = live('a-00000001', clock);
    sessions.set(a.id, a);
    await clock.advance(WINDOW);
    const [first, second] = await Promise.all([sweeper.sweepOnce(), sweeper.sweepOnce()]);
    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
  });
});

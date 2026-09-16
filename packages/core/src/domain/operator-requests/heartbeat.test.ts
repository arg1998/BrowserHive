/** @module domain/operator-requests/heartbeat.test — heartbeat loop with FakeClock, floor/cap arithmetic, transport gate */

import { describe, expect, it } from 'bun:test';
import { FakeClock } from '../../../test/helpers/fake-clock.ts';
import { isAppError } from '../../kernel/errors/app-error.ts';
import {
  assertAttentionTransport,
  effectiveAttentionWaitMs,
  effectiveTimeoutMs,
  HEARTBEAT_INTERVAL_MS,
  type ProgressReport,
  waitWithHeartbeats,
} from './heartbeat.ts';

/** Lets the wait loop re-arm its next sleep after a tick. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('waitWithHeartbeats', () => {
  it('reports progress every 25 s until the promise settles', async () => {
    const clock = new FakeClock(0);
    const reports: ProgressReport[] = [];
    let settle: (v: string) => void = () => undefined;
    const promise = new Promise<string>((r) => {
      settle = r;
    });
    const waiting = waitWithHeartbeats(promise, {
      clock,
      reportProgress: async (r) => {
        reports.push(r);
      },
      totalMs: 100_000,
    });
    await clock.advance(HEARTBEAT_INTERVAL_MS);
    await flush();
    await clock.advance(HEARTBEAT_INTERVAL_MS);
    await flush();
    settle('done');
    expect(await waiting).toBe('done');
    expect(reports).toEqual([
      { progress: 25_000, total: 100_000 },
      { progress: 50_000, total: 100_000 },
    ]);
    // The pending sleep was aborted when the promise settled.
    expect(clock.pendingSleeps).toBe(0);
  });

  it('omits total when waiting indefinitely', async () => {
    const clock = new FakeClock(0);
    const reports: ProgressReport[] = [];
    let settle: (v: number) => void = () => undefined;
    const waiting = waitWithHeartbeats(new Promise<number>((r) => (settle = r)), {
      clock,
      reportProgress: async (r) => {
        reports.push(r);
      },
      totalMs: null,
    });
    await clock.advance(HEARTBEAT_INTERVAL_MS);
    await flush();
    settle(1);
    await waiting;
    expect(reports).toEqual([{ progress: 25_000 }]);
  });

  it('a rejected heartbeat means the client is gone: onClientGone runs once, the loop stops', async () => {
    const clock = new FakeClock(0);
    let gone = 0;
    let settle: (v: string) => void = () => undefined;
    const promise = new Promise<string>((r) => {
      settle = r;
    });
    const waiting = waitWithHeartbeats(promise, {
      clock,
      reportProgress: () => Promise.reject(new Error('client disconnected')),
      onClientGone: () => {
        gone += 1;
        settle('cancelled');
      },
    });
    await clock.advance(HEARTBEAT_INTERVAL_MS);
    await flush();
    expect(await waiting).toBe('cancelled');
    expect(gone).toBe(1);
    expect(clock.pendingSleeps).toBe(0);
  });

  it('without reportProgress it is a plain await', async () => {
    const clock = new FakeClock(0);
    expect(await waitWithHeartbeats(Promise.resolve(7), { clock })).toBe(7);
    expect(clock.pendingSleeps).toBe(0);
  });

  it('propagates a rejection of the awaited promise', async () => {
    const clock = new FakeClock(0);
    await expect(
      waitWithHeartbeats(Promise.reject(new Error('boom')), {
        clock,
        reportProgress: () => Promise.resolve(),
      }),
    ).rejects.toThrow('boom');
  });
});

describe('floor / cap arithmetic', () => {
  it('effectiveAttentionWaitMs: undefined/0 → undefined; positive → max(value, floor)', () => {
    expect(effectiveAttentionWaitMs(undefined, 1_800_000)).toBeUndefined();
    expect(effectiveAttentionWaitMs(0, 1_800_000)).toBeUndefined();
    expect(effectiveAttentionWaitMs(60, 1_800_000)).toBe(1_800_000);
    expect(effectiveAttentionWaitMs(3600, 1_800_000)).toBe(3_600_000);
    expect(effectiveAttentionWaitMs(60, 0)).toBe(60_000);
  });

  it('effectiveTimeoutMs: never above the cap', () => {
    expect(effectiveTimeoutMs(undefined, 21_600_000)).toBe(21_600_000);
    expect(effectiveTimeoutMs(5, 21_600_000)).toBe(5);
    expect(effectiveTimeoutMs(99_999_999, 21_600_000)).toBe(21_600_000);
  });
});

describe('assertAttentionTransport', () => {
  it('throws ATTENTION_REQUIRES_HTTP with its registry text under stdio', () => {
    expect(() => assertAttentionTransport('http', 'request_attention')).not.toThrow();
    try {
      assertAttentionTransport('stdio', 'request_attention');
      throw new Error('expected throw');
    } catch (err) {
      expect(isAppError(err, 'ATTENTION_REQUIRES_HTTP')).toBe(true);
      if (isAppError(err, 'ATTENTION_REQUIRES_HTTP')) {
        expect(err.publicMessage).toBe(
          "'request_attention' requires the http transport; human-in-the-loop attention is not available under stdio.",
        );
        expect(err.details).toEqual({ tool: 'request_attention' });
      }
    }
  });
});

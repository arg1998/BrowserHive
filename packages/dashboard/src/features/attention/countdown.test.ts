/** @module features/attention/countdown.test — waited time prefers the server value once settled; deadline tones and expiry */
import { describe, expect, it } from 'bun:test';
import { deadlineCountdown, waitedLabel, waitedMs } from './countdown.ts';

describe('countdown', () => {
  it('derives waited time from created_at while pending and from waited_ms once settled', () => {
    expect(waitedMs({ created_at: 1_000, waited_ms: null, status: 'pending' }, 61_000)).toBe(
      60_000,
    );
    expect(waitedMs({ created_at: 1_000, waited_ms: 5_000, status: 'pending' }, 61_000)).toBe(
      60_000,
    );
    expect(waitedMs({ created_at: 1_000, waited_ms: 5_000, status: 'resolved' }, 61_000)).toBe(
      5_000,
    );
    expect(waitedMs({ created_at: 9_000, waited_ms: null, status: 'pending' }, 1_000)).toBe(0);
    expect(waitedLabel({ created_at: 0, waited_ms: null, status: 'pending' }, 252_000)).toBe(
      'waited 4m 12s',
    );
  });

  it('counts down to the deadline with warn/danger tones and an expired state', () => {
    expect(deadlineCountdown(null, 0)).toBeNull();
    expect(deadlineCountdown(600_000, 0)).toMatchObject({
      tone: 'neutral',
      expired: false,
      label: '10m 00s left',
    });
    expect(deadlineCountdown(90_000, 0)).toMatchObject({ tone: 'warn', remainingMs: 90_000 });
    expect(deadlineCountdown(20_000, 0)).toMatchObject({ tone: 'danger', label: '20s left' });
    expect(deadlineCountdown(1_000, 5_000)).toMatchObject({
      tone: 'danger',
      expired: true,
      remainingMs: 0,
    });
  });
});

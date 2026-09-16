/** @module app/auth/rate-limit.test — 5 per minute per IP, 6th locks for 5 minutes, reset on success. */

import { describe, expect, it } from 'bun:test';
import { createLoginRateLimiter } from './rate-limit.ts';

function limiter(start = 0) {
  let now = start;
  const l = createLoginRateLimiter({
    now: () => now,
    maxAttempts: 5,
    windowMs: 60_000,
    lockoutMs: 300_000,
  });
  return {
    l,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('login rate limiter', () => {
  it('allows five attempts, locks on the sixth with retry_after = lockout', () => {
    const { l, advance } = limiter();
    for (let i = 0; i < 5; i += 1) expect(l.attempt('1.1.1.1')).toEqual({ allowed: true });
    expect(l.attempt('1.1.1.1')).toEqual({
      allowed: false,
      retryAfterMs: 300_000,
      justLocked: true,
    });
    advance(10_000);
    expect(l.attempt('1.1.1.1')).toEqual({
      allowed: false,
      retryAfterMs: 290_000,
      justLocked: false,
    });
    expect(l.attempt('2.2.2.2')).toEqual({ allowed: true });
    advance(290_000);
    expect(l.attempt('1.1.1.1')).toEqual({ allowed: true });
  });

  it('a new window starts after 60 s; reset clears; sweep drops stale buckets', () => {
    const { l, advance } = limiter();
    for (let i = 0; i < 5; i += 1) l.attempt('a');
    advance(60_001);
    expect(l.attempt('a')).toEqual({ allowed: true });
    l.reset('a');
    expect(l.size()).toBe(0);
    l.attempt('b');
    expect(l.sweep()).toBe(0);
    advance(60_001);
    expect(l.sweep()).toBe(1);
  });
});

/** @module interface/http/middleware/rate-limit — middleware 10–11: token buckets per principal/IP and the login semaphore (spec 03 §2). */

import { AppError } from '../../../kernel/errors/app-error.ts';

/** Default budget: 600 requests per minute per key. */
export const DEFAULT_RATE = { limit: 600, windowMs: 60_000 } as const;
/**
 * Budget for safe (GET/HEAD) requests of an operator signed in with the password session cookie,
 * i.e. the dashboard. Every open tab shares the principal and one page load issues 12–17
 * cheap reads, so the default 600/min is exhausted by a few busy tabs; 6000/min (100/s) still bounds
 * a runaway client. Mutations, bearer and grant callers keep {@link DEFAULT_RATE}; login keeps its
 * own per-IP limiter and lockout.
 */
export const OPERATOR_READ_RATE = { limit: 6000, windowMs: 60_000 } as const;
/** Concurrent Argon2 verifications allowed process-wide. */
export const LOGIN_CONCURRENCY = 2;

/** Outcome of taking one token. */
export interface RateDecision {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  /** Seconds until the bucket is full again. */
  readonly resetS: number;
  readonly retryAfterMs: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/** Token buckets keyed by `<rule>:<key>`; refill is continuous, state is swept lazily. */
export class TokenBuckets {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly now: () => number) {}

  /** Takes one token from `key` under `limit` per `windowMs`. */
  take(key: string, limit: number, windowMs: number): RateDecision {
    const now = this.now();
    const rate = limit / windowMs;
    const bucket = this.buckets.get(key) ?? { tokens: limit, updatedAt: now };
    bucket.tokens = Math.min(limit, bucket.tokens + (now - bucket.updatedAt) * rate);
    bucket.updatedAt = now;
    this.buckets.set(key, bucket);
    const resetS = Math.ceil((limit - bucket.tokens) / rate / 1000);
    if (bucket.tokens < 1) {
      const retryAfterMs = Math.ceil((1 - bucket.tokens) / rate);
      return { allowed: false, limit, remaining: 0, resetS, retryAfterMs };
    }
    bucket.tokens -= 1;
    return { allowed: true, limit, remaining: Math.floor(bucket.tokens), resetS, retryAfterMs: 0 };
  }

  /** Drops full buckets (they carry no state). */
  sweep(): void {
    const now = this.now();
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.updatedAt > 10 * 60_000) this.buckets.delete(key);
    }
  }

  /** Number of tracked keys. */
  get size(): number {
    return this.buckets.size;
  }
}

/** `RATE_LIMITED` for a refused decision. */
export function rateLimited(retryAfterMs: number): AppError<'RATE_LIMITED'> {
  return new AppError(
    'RATE_LIMITED',
    { retry_after_ms: retryAfterMs },
    { publicMessage: 'Too many requests.' },
  );
}

/** At most `size` concurrent holders; excess callers are refused immediately. */
export class Semaphore {
  private inFlight = 0;

  constructor(private readonly size: number) {}

  /** Runs `fn` holding a slot; throws `RATE_LIMITED` (retry after 1 s) when none is free. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inFlight >= this.size) throw rateLimited(1000);
    this.inFlight += 1;
    try {
      return await fn();
    } finally {
      this.inFlight -= 1;
    }
  }
}

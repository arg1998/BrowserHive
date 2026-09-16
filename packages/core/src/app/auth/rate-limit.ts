/** @module app/auth/rate-limit — per-IP login attempt limiter with lockout. */

interface Bucket {
  windowStart: number;
  count: number;
  lockedUntil: number;
}

/** Outcome of {@link LoginRateLimiter.attempt}. */
export type RateDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      /** ms until the caller may try again. */
      readonly retryAfterMs: number;
      /** True on the attempt that flipped the bucket into lockout (audit it once). */
      readonly justLocked: boolean;
    };

/** Options for {@link createLoginRateLimiter}. */
export interface LoginRateLimiterOptions {
  readonly now: () => number;
  readonly maxAttempts: number;
  readonly windowMs: number;
  readonly lockoutMs: number;
}

/**
 * 5 attempts per 60 s per IP; the 6th within the window locks the IP for 5 minutes. A locked
 * bucket rejects without consuming budget; a successful login resets the IP.
 */
export interface LoginRateLimiter {
  /** Registers an attempt from `ip` (call before verifying the password). */
  attempt(ip: string): RateDecision;
  /** Clears an IP after a successful login. */
  reset(ip: string): void;
  /** Drops buckets whose window and lockout both elapsed; returns how many were dropped. */
  sweep(): number;
  /** Number of tracked IPs. */
  size(): number;
}

/** Builds a {@link LoginRateLimiter}. */
export function createLoginRateLimiter(options: LoginRateLimiterOptions): LoginRateLimiter {
  const buckets = new Map<string, Bucket>();
  return {
    attempt(ip) {
      const now = options.now();
      let bucket = buckets.get(ip);
      if (bucket !== undefined && bucket.lockedUntil > now) {
        return { allowed: false, retryAfterMs: bucket.lockedUntil - now, justLocked: false };
      }
      if (bucket === undefined || now - bucket.windowStart > options.windowMs) {
        bucket = { windowStart: now, count: 0, lockedUntil: 0 };
        buckets.set(ip, bucket);
      }
      bucket.count += 1;
      if (bucket.count > options.maxAttempts) {
        bucket.lockedUntil = now + options.lockoutMs;
        return { allowed: false, retryAfterMs: options.lockoutMs, justLocked: true };
      }
      return { allowed: true };
    },
    reset(ip) {
      buckets.delete(ip);
    },
    sweep() {
      const now = options.now();
      let dropped = 0;
      for (const [ip, bucket] of buckets) {
        if (now - bucket.windowStart > options.windowMs && bucket.lockedUntil <= now) {
          buckets.delete(ip);
          dropped += 1;
        }
      }
      return dropped;
    },
    size: () => buckets.size,
  };
}

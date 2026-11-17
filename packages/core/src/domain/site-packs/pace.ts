/** @module domain/site-packs/pace — the token buckets of `pace-writes` (spec 13 §9.4): continuous refill of `limit × ramp factor` per period, a write over budget held for the next token when it is at most 60 s away (plus 0–20 % jitter), refused otherwise. Pure: the caller keeps the buckets and the clock. */

import type { PACE_PERIODS } from '@browserhive/contracts/site-packs';

/** A pace rule's period. */
export type PacePeriod = (typeof PACE_PERIODS)[number];

/** Milliseconds per pacing period. */
export const PACE_PERIOD_MS: { readonly [P in PacePeriod]: number } = Object.freeze({
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
});

/** A write waits for its token when it is at most this far away; beyond it, it is refused. */
export const MAX_PACE_HOLD_MS = 60_000;
/** A held write waits up to this much longer than its token (0–20 %, spec 13 §9.4). */
export const PACE_HOLD_JITTER = 0.2;

/** A bucket's tokens at `at`; negative while held writes have reserved future tokens. */
export interface PaceBucket {
  readonly tokens: number;
  readonly at: number;
}

/** One rule's budget: `capacity` tokens per `periodMs`, refilled continuously. */
export interface PaceBudget {
  readonly capacity: number;
  readonly periodMs: number;
}

/** What to do with one write. */
export type PacePlan =
  | { readonly kind: 'go' }
  /** Its tokens are reserved; it goes out after `waitMs` (before jitter). */
  | { readonly kind: 'hold'; readonly waitMs: number }
  /** Over budget for longer than {@link MAX_PACE_HOLD_MS}: no token was taken. */
  | { readonly kind: 'refuse'; readonly waitMs: number };

/**
 * The bucket at `now`: a bucket never seen is full; tokens grow by `capacity / periodMs` per
 * millisecond up to `capacity` (a capacity that shrank clamps them).
 */
export function refilled(
  bucket: PaceBucket | undefined,
  budget: PaceBudget,
  now: number,
): PaceBucket {
  if (bucket === undefined) return { tokens: budget.capacity, at: now };
  const elapsed = Math.max(0, now - bucket.at);
  const tokens = bucket.tokens + (elapsed * budget.capacity) / budget.periodMs;
  return { tokens: Math.min(budget.capacity, tokens), at: Math.max(now, bucket.at) };
}

/** Milliseconds until the bucket holds a whole token (0 when it has one). */
export function waitForToken(bucket: PaceBucket, budget: PaceBudget): number {
  if (bucket.tokens >= 1) return 0;
  return Math.ceil(((1 - bucket.tokens) * budget.periodMs) / budget.capacity);
}

/**
 * Plans one write over every bucket its guard has (one per pace rule naming the guard): the
 * longest wait decides. `go` and `hold` take one token from each bucket (a hold reserves a future
 * token, so the next write waits behind it); `refuse` takes none. Returns the buckets to store.
 */
export function planWrite(
  entries: readonly { readonly bucket: PaceBucket | undefined; readonly budget: PaceBudget }[],
  now: number,
): { readonly plan: PacePlan; readonly buckets: readonly PaceBucket[] } {
  const current = entries.map((e) => refilled(e.bucket, e.budget, now));
  let waitMs = 0;
  for (const [i, bucket] of current.entries()) {
    const budget = entries[i]?.budget;
    if (budget !== undefined) waitMs = Math.max(waitMs, waitForToken(bucket, budget));
  }
  if (waitMs > MAX_PACE_HOLD_MS) return { plan: { kind: 'refuse', waitMs }, buckets: current };
  const taken = current.map((b) => ({ tokens: b.tokens - 1, at: b.at }));
  return { plan: waitMs === 0 ? { kind: 'go' } : { kind: 'hold', waitMs }, buckets: taken };
}

/** Gives back the token of a held write that never went out. */
export function refund(bucket: PaceBucket, budget: PaceBudget, now: number): PaceBucket {
  const current = refilled(bucket, budget, now);
  return { tokens: Math.min(budget.capacity, current.tokens + 1), at: current.at };
}

/** How long a held write waits: its token plus 0–20 % jitter (`random` in `[0, 1)`). */
export function holdMs(waitMs: number, random: number): number {
  return Math.round(waitMs * (1 + PACE_HOLD_JITTER * Math.min(1, Math.max(0, random))));
}

/** @module domain/session/lease — sliding, pausable inactivity lease; pure over an injected `now` (touch/pause/resume). */

/** The lease of one session: when it expires and, if frozen, when it was frozen. */
export interface Lease {
  /** Epoch ms at which the session is reaped unless touched first. */
  readonly expiresAt: number;
  /** Epoch ms of the pause, or `null` while running. */
  readonly pausedAt: number | null;
}

/** A fresh lease: `now + windowMs`, running. */
export function newLease(now: number, windowMs: number): Lease {
  return { expiresAt: now + windowMs, pausedAt: null };
}

/**
 * Reset the sliding deadline to `now + windowMs`. A no-op while paused — the banked remaining time
 * is what the session gets back on resume, not a fresh window.
 */
export function touchLease(lease: Lease, now: number, windowMs: number): Lease {
  return lease.pausedAt === null ? { expiresAt: now + windowMs, pausedAt: null } : lease;
}

/**
 * Freeze the lease while an operator request is open. The remaining time is banked (as the distance
 * between `pausedAt` and `expiresAt`) and restored by {@link resumeLease}, so waiting on a human
 * never expires the session. Idempotent.
 */
export function pauseLease(lease: Lease, now: number): Lease {
  return lease.pausedAt === null ? { expiresAt: lease.expiresAt, pausedAt: now } : lease;
}

/**
 * Resume a paused lease: `now + banked remaining`, so the session gets exactly the time it had left
 * when it paused. Idempotent when not paused.
 */
export function resumeLease(lease: Lease, now: number): Lease {
  if (lease.pausedAt === null) return lease;
  const remaining = Math.max(0, lease.expiresAt - lease.pausedAt);
  return { expiresAt: now + remaining, pausedAt: null };
}

/** True once the deadline passed. Always false while paused — the sweeper uses this. */
export function isLeaseExpired(lease: Lease, now: number): boolean {
  return lease.pausedAt === null && now >= lease.expiresAt;
}

/** Milliseconds left: banked time while paused, distance to the deadline otherwise (never negative). */
export function leaseRemainingMs(lease: Lease, now: number): number {
  const reference = lease.pausedAt ?? now;
  return Math.max(0, lease.expiresAt - reference);
}

/** @module features/attention/countdown — pure time math for the board: waited time, deadline countdown and its tone (spec 04 §12.4) */
import type { OperatorRequestRow } from '@browserhive/contracts/http';
import { formatDuration } from '@/lib/format/time.ts';
import type { Tone } from '@/lib/status-registry.ts';

/** Deadline within which the countdown turns warn. */
export const DEADLINE_WARN_MS = 2 * 60_000;
/** Deadline within which the countdown turns danger. */
export const DEADLINE_DANGER_MS = 30_000;

/** Milliseconds the agent has been blocked: server `waited_ms` once settled, else `now − created_at`. */
export function waitedMs(
  row: Pick<OperatorRequestRow, 'created_at' | 'waited_ms' | 'status'>,
  now: number,
): number {
  if (row.status !== 'pending' && row.waited_ms !== null) return row.waited_ms;
  return Math.max(0, now - row.created_at);
}

/** Deadline countdown. `null` when the request has no deadline. */
export interface Countdown {
  readonly remainingMs: number;
  readonly tone: Tone;
  readonly label: string;
  readonly expired: boolean;
}

/** Remaining time until `deadline_at`, with the tone thresholds applied. */
export function deadlineCountdown(deadlineAt: number | null, now: number): Countdown | null {
  if (deadlineAt === null) return null;
  const remainingMs = deadlineAt - now;
  if (remainingMs <= 0)
    return { remainingMs: 0, tone: 'danger', label: 'deadline passed', expired: true };
  const tone: Tone =
    remainingMs <= DEADLINE_DANGER_MS
      ? 'danger'
      : remainingMs <= DEADLINE_WARN_MS
        ? 'warn'
        : 'neutral';
  return { remainingMs, tone, label: `${formatDuration(remainingMs)} left`, expired: false };
}

/** "waited 4m 12s" text for a row. */
export function waitedLabel(
  row: Pick<OperatorRequestRow, 'created_at' | 'waited_ms' | 'status'>,
  now: number,
): string {
  return `waited ${formatDuration(waitedMs(row, now))}`;
}

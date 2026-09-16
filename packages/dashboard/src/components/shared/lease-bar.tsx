/** @module components/shared/lease-bar — remaining-lease meter with registry thresholds (< 10 m warn, < 2 m danger), frozen state and a text alternative (spec 04 §7) */
import { Progress as ProgressPrimitive } from '@base-ui/react/progress';
import { ProgressIndicator, ProgressTrack } from '@/components/ui/progress.tsx';
import { formatDuration } from '@/lib/format/time.ts';
import { leaseTone, type Tone } from '@/lib/status-registry.ts';
import { cn } from '@/lib/utils.ts';
import { TonePill } from './StatusBadge.tsx';
import { TONE_CLASSES } from './tones.ts';

/** Props. */
export interface LeaseBarProps {
  /** Milliseconds until the lease expires (≤ 0 = expired). */
  readonly remainingMs: number;
  /** Full lease length; defaults to `max(remaining, 60 s)` when unknown. */
  readonly totalMs?: number;
  /** When set the lease is frozen (blocked on an attention request). */
  readonly pausedAt?: number | null;
  /** Accessible name prefix (default `Lease`). */
  readonly label?: string;
  readonly className?: string;
}

/** Frozen pill entry: a frozen lease blocks the agent. */
const FROZEN = { label: 'frozen · blocked', tone: 'warn' as Tone };
/** Expired pill entry. */
const EXPIRED = { label: 'expired', tone: 'neutral' as Tone };

/** Percentage of the lease left, clamped to 0–100. */
export function leasePercent(remainingMs: number, totalMs?: number): number {
  const total = totalMs !== undefined && totalMs > 0 ? totalMs : Math.max(remainingMs, 60_000);
  return Math.max(0, Math.min(100, (remainingMs / total) * 100));
}

/** Lease meter. */
export function LeaseBar({
  remainingMs,
  totalMs,
  pausedAt,
  label = 'Lease',
  className,
}: LeaseBarProps) {
  if (pausedAt !== undefined && pausedAt !== null) {
    return (
      <span className={cn('inline-flex items-center', className)}>
        <TonePill entry={FROZEN} />
        <span className="sr-only">{label}: frozen while an attention request is open</span>
      </span>
    );
  }
  if (remainingMs <= 0) {
    return (
      <span className={cn('inline-flex items-center', className)}>
        <TonePill entry={EXPIRED} />
        <span className="sr-only">{label}: expired</span>
      </span>
    );
  }
  const pct = leasePercent(remainingMs, totalMs);
  const tone = leaseTone(remainingMs);
  const text = formatDuration(remainingMs);
  return (
    <ProgressPrimitive.Root
      value={pct}
      aria-label={`${label}: ${text} remaining`}
      className={cn('flex min-w-24 items-center gap-2', className)}
    >
      <ProgressTrack className="flex-1">
        <ProgressIndicator className={TONE_CLASSES[tone].dot} />
      </ProgressTrack>
      <span className={cn('shrink-0 text-sm tabular-nums', TONE_CLASSES[tone].text)}>{text}</span>
    </ProgressPrimitive.Root>
  );
}

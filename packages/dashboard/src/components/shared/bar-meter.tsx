/** @module components/shared/bar-meter — horizontal bar/meter on Base UI Progress: value/max, tone from the registry, accessible label; used by bar rows and the retention meter (spec 04 §7, §12.10) */
import { Progress as ProgressPrimitive } from '@base-ui/react/progress';
import { ProgressIndicator, ProgressTrack } from '@/components/ui/progress.tsx';
import type { Tone } from '@/lib/status-registry.ts';
import { cn } from '@/lib/utils.ts';
import { TONE_CLASSES } from './tones.ts';

/** Props. */
export interface BarMeterProps {
  readonly value: number;
  readonly max: number;
  /** Accessible name. */
  readonly label: string;
  /** `undefined` → chart-1 (data), a tone → registry colour (status). */
  readonly tone?: Tone | undefined;
  /** Track height. */
  readonly size?: 'sm' | 'md';
  /** Minimum visible width (%) for non-zero values. */
  readonly floor?: number;
  readonly className?: string;
}

/** Bar meter. */
export function BarMeter({
  value,
  max,
  label,
  tone,
  size = 'sm',
  floor = 2,
  className,
}: BarMeterProps) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const shown = value > 0 ? Math.max(floor, ratio * 100) : 0;
  return (
    <ProgressPrimitive.Root
      value={shown}
      max={100}
      aria-label={label}
      className={cn('flex w-full items-center', className)}
    >
      <ProgressTrack className={size === 'md' ? 'h-2.5 rounded-sm' : 'h-2 rounded-sm'}>
        <ProgressIndicator
          className={cn('rounded-sm', tone === undefined ? 'bg-chart-1' : TONE_CLASSES[tone].dot)}
        />
      </ProgressTrack>
    </ProgressPrimitive.Root>
  );
}

/** @module components/shared/Sparkline — hand-rolled SVG line + soft area, full width of its container, `aria-hidden` with a text alternative */
import { useId } from 'react';
import type { Tone } from '@/lib/status-registry.ts';
import { cn } from '@/lib/utils.ts';
import { TONE_CLASSES } from './tones.ts';

/** Props. */
export interface SparklineProps {
  readonly points: readonly number[];
  readonly tone?: Tone;
  readonly width?: number;
  readonly height?: number;
  /** Text alternative (e.g. "12 calls, peak 5"). */
  readonly label: string;
  readonly className?: string;
}

/** Build the polyline `points` attribute (viewBox units). Exported for tests. */
export function sparklinePath(points: readonly number[], width: number, height: number): string {
  if (points.length === 0) return '';
  const max = Math.max(...points, 1);
  const step = points.length > 1 ? width / (points.length - 1) : 0;
  return points
    .map((value, index) => {
      const x = points.length > 1 ? index * step : width / 2;
      const y = height - (value / max) * (height - 2) - 1;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

/** Sparkline (32px tall, stretches to the container width). */
export function Sparkline({
  points,
  tone = 'accent',
  width = 120,
  height = 32,
  label,
  className,
}: SparklineProps) {
  const path = sparklinePath(points, width, height);
  const gradient = useId();
  return (
    <span className={cn('block h-8 w-full', TONE_CLASSES[tone].text, className)}>
      <svg
        aria-hidden="true"
        viewBox={`0 0 ${width} ${height}`}
        className="h-full w-full overflow-visible"
        preserveAspectRatio="none"
      >
        <defs>
          <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="currentColor" stopOpacity="0.18" />
            <stop offset="1" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        {path.length > 0 ? (
          <>
            <polygon points={`0,${height} ${path} ${width},${height}`} fill={`url(#${gradient})`} />
            <polyline
              points={path}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          </>
        ) : null}
      </svg>
      <span className="sr-only">{label}</span>
    </span>
  );
}

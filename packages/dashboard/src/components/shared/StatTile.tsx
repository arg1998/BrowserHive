/** @module components/shared/StatTile — KPI tile: sentence-case label, 24px value (truncates), sub line, sparkline; `to` makes it a link that lifts on hover and shows an arrow */
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { ICONS } from '@/lib/icons.ts';
import type { Tone } from '@/lib/status-registry.ts';
import { cn } from '@/lib/utils.ts';
import { type InfoDocs, InfoDot } from './InfoDot.tsx';
import { Sparkline } from './Sparkline.tsx';
import { TONE_CLASSES } from './tones.ts';

/** Props. */
export interface StatTileProps {
  readonly label: string;
  readonly value: ReactNode;
  readonly sub?: ReactNode;
  /** Colours the value (e.g. `danger` for errors > 0). */
  readonly tone?: Tone;
  /** Trend points; drawn as an area sparkline under the value. */
  readonly spark?: readonly number[];
  /** Explainer behind an info button next to the label (static tiles only). */
  readonly info?: ReactNode;
  /** "Read the docs" link under `info`. */
  readonly infoDocs?: InfoDocs;
  /** Makes the whole tile a link (hover lift + arrow + pointer). */
  readonly to?: string;
  /** Search params for `to`. */
  readonly search?: Record<string, unknown>;
  readonly className?: string;
}

/** KPI tile. Only for real metrics; static configuration belongs in `KeyValue`. */
export function StatTile({
  label,
  value,
  sub,
  tone,
  spark,
  info,
  infoDocs,
  to,
  search,
  className,
}: StatTileProps) {
  const Arrow = ICONS.arrowUpRight;
  const linked = to !== undefined;
  const body = (
    <>
      <div className="flex min-h-6 items-center justify-between gap-2">
        <span className="section-label truncate">{label}</span>
        {linked ? (
          <Arrow
            aria-hidden="true"
            className="size-4 shrink-0 text-subtle-foreground transition-[color,transform] duration-(--duration-fast) group-hover/tile:translate-x-0.5 group-hover/tile:-translate-y-0.5 group-hover/tile:text-foreground"
          />
        ) : info !== undefined ? (
          <InfoDot
            label={`About ${label}`}
            align="end"
            {...(infoDocs !== undefined && { docs: infoDocs })}
          >
            {info}
          </InfoDot>
        ) : null}
      </div>
      <div
        className={cn(
          'min-w-0 truncate text-2xl font-semibold tabular-nums',
          tone !== undefined && TONE_CLASSES[tone].text,
        )}
      >
        {value}
      </div>
      {spark !== undefined && spark.length > 1 ? (
        <Sparkline
          points={spark}
          tone={tone ?? 'accent'}
          label={`${label} trend`}
          className="-mx-1 mt-1"
        />
      ) : null}
      {sub !== undefined ? (
        <div className="mt-auto min-w-0 truncate pt-0.5 text-sm text-muted-foreground">{sub}</div>
      ) : null}
    </>
  );
  const surface =
    'group/tile flex h-full min-w-0 flex-col gap-1 rounded-xl border bg-card p-4 shadow-xs dark:shadow-none';
  if (linked) {
    return (
      <Link
        to={to}
        {...(search !== undefined && { search })}
        className={cn(
          surface,
          'transition-[transform,box-shadow,border-color,background-color] duration-(--duration-base) ease-(--ease-out) hover:-translate-y-0.5 hover:border-border-strong hover:shadow-md dark:hover:bg-[color-mix(in_oklch,var(--card),white_3%)]',
          className,
        )}
      >
        {body}
      </Link>
    );
  }
  return <div className={cn(surface, className)}>{body}</div>;
}

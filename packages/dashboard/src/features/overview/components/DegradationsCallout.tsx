/** @module features/overview/components/DegradationsCallout — open `system.degradations` rolled into one callout with a link to /system (spec 04 §12.1, spec 10 §3) */
import type { SystemEvent } from '@browserhive/contracts/http';
import { Link } from '@tanstack/react-router';
import { Callout } from '@/components/shared/Callout.tsx';
import { formatNumber } from '@/lib/format/bytes.ts';

/** Props. */
export interface DegradationsCalloutProps {
  readonly degradations: readonly SystemEvent[];
}

/** Open degradations only (resolved rows are history). */
export function openDegradations(rows: readonly SystemEvent[]): SystemEvent[] {
  return rows.filter((row) => row.resolved_at === null);
}

/** Degradations callout; renders nothing when the daemon is healthy. */
export function DegradationsCallout({ degradations }: DegradationsCalloutProps) {
  const open = openDegradations(degradations);
  if (open.length === 0) return null;
  const worst = open.some((d) => d.severity === 'error') ? 'danger' : 'warn';
  return (
    <Callout
      tone={worst}
      title={`${formatNumber(open.length)} degradation${open.length === 1 ? '' : 's'} open`}
      action={
        <Link to="/system" className="text-sm font-medium underline">
          Open system
        </Link>
      }
    >
      <ul className="flex flex-col gap-0.5">
        {open.slice(0, 3).map((d) => (
          <li key={d.event_id} className="flex flex-wrap gap-x-2">
            <span className="font-mono text-xs">{d.code}</span>
            <span>{d.message}</span>
            {d.count > 1 ? (
              <span className="text-muted-foreground">×{formatNumber(d.count)}</span>
            ) : null}
          </li>
        ))}
        {open.length > 3 ? (
          <li className="text-muted-foreground">and {formatNumber(open.length - 3)} more</li>
        ) : null}
      </ul>
    </Callout>
  );
}

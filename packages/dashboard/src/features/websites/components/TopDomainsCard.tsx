/** @module features/websites/components/TopDomainsCard — "Most visited domains" panel: compact `BarList` (optionally in columns for a full-width panel); rows link to `/websites?domain=` (Overview) or toggle the domain filter (Websites), Top-N select in the header (spec 04 §12.5) */
import type { PageDomainsResponse } from '@browserhive/contracts/http';
import type { UseQueryResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { DataPanel } from '@/components/shared/DataPanel.tsx';
import { EmptyState } from '@/components/shared/EmptyState.tsx';
import { Panel } from '@/components/shared/Section.tsx';
import { SimpleSelect } from '@/components/ui/select.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { formatNumber } from '@/lib/format/bytes.ts';
import { BarList } from './BarList.tsx';

/** Top-N choices (spec 04 §12.5). */
export const TOP_N = [5, 10, 25, 100] as const;
/** Top-N value. */
export type TopN = (typeof TOP_N)[number];

/** Props. */
export interface TopDomainsCardProps {
  readonly query: UseQueryResult<PageDomainsResponse, unknown>;
  readonly rangeLabel: string;
  readonly top: number;
  readonly onTop?: (top: TopN) => void;
  /** Domain currently filtered (Websites). */
  readonly active?: string | undefined;
  /** Toggle the domain filter (Websites). */
  readonly onPick?: (domain: string) => void;
  /** Link each row (Overview → `/websites?domain=`). Wins over `onPick`. */
  readonly hrefFor?: (domain: string) => string;
  /** Hide the list (collapsed panel); the header stays. */
  readonly collapsed?: boolean;
  /** Full-width panel: flow the bars into columns. */
  readonly columns?: boolean;
  /** Extra header actions. */
  readonly actions?: ReactNode;
  readonly className?: string;
}

/** Bar-row skeleton at the real row height. */
export function BarListSkeleton({
  rows = 5,
  columns = false,
}: {
  readonly rows?: number;
  readonly columns?: boolean;
}) {
  return (
    <div
      className={columns ? 'columns-1 gap-x-6 sm:columns-2 xl:columns-3' : 'flex flex-col gap-1'}
      aria-hidden="true"
    >
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
          key={i}
          className={columns ? 'mb-1 h-8 break-inside-avoid rounded-md' : 'h-8 rounded-md'}
          style={{ width: `${100 - (i % 5) * 14}%` }}
        />
      ))}
    </div>
  );
}

/** Most visited domains panel. */
export function TopDomainsCard({
  query,
  rangeLabel,
  top,
  onTop,
  active,
  onPick,
  hrefFor,
  actions,
  columns = false,
  collapsed = false,
  className,
}: TopDomainsCardProps) {
  return (
    <Panel
      title="Most visited domains"
      description={`Visits · ${rangeLabel}`}
      {...(className !== undefined && { className })}
      bodyClassName={collapsed ? 'hidden' : 'px-2.5 pt-1 pb-3'}
      padding="none"
      actions={
        onTop !== undefined || actions !== undefined ? (
          <>
            {onTop !== undefined ? (
              <SimpleSelect
                aria-label="How many domains"
                size="sm"
                className="w-24"
                value={String(top)}
                options={TOP_N.map((n) => ({ value: String(n), label: `Top ${n}` }))}
                onValueChange={(value) => {
                  const next = TOP_N.find((n) => n === Number(value));
                  if (next !== undefined) onTop(next);
                }}
              />
            ) : null}
            {actions}
          </>
        ) : undefined
      }
    >
      {/* Skeleton from the first paint: a late one would push the panels below it. */}
      {query.isPending && query.failureCount === 0 ? (
        <BarListSkeleton rows={columns ? Math.min(top, 12) : Math.min(top, 8)} columns={columns} />
      ) : (
        <DataPanel
          query={query}
          skeleton={
            <BarListSkeleton
              rows={columns ? Math.min(top, 12) : Math.min(top, 8)}
              columns={columns}
            />
          }
          empty={
            <EmptyState
              kind="zero-data"
              size="sm"
              icon="globe"
              title="No domains visited"
              description={`Nothing recorded · ${rangeLabel}`}
            />
          }
        >
          {(data) => (
            <BarList
              label="Domains by visits"
              columns={columns}
              items={data.data.map((d) => ({
                key: d.domain,
                label: <span className="font-mono text-sm">{d.domain}</span>,
                value: d.count,
                active: active === d.domain,
                ...(hrefFor !== undefined
                  ? { href: hrefFor(d.domain) }
                  : onPick !== undefined
                    ? { onClick: () => onPick(d.domain) }
                    : {}),
                hint:
                  hrefFor !== undefined
                    ? `${formatNumber(d.count)} visit${d.count === 1 ? '' : 's'} · open in Websites`
                    : active === d.domain
                      ? 'Filtered · click to clear'
                      : `Show only ${d.domain}`,
              }))}
            />
          )}
        </DataPanel>
      )}
    </Panel>
  );
}

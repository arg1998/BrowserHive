/** @module features/attention/history-parts — pieces of the settled-requests table: the facet chip options, the "Site check" / "Write approval" label of a site pack's request, the expanded decision record, the phone card and the session link */
import type { Facet, OperatorRequestRow } from '@browserhive/contracts/http';
import { isPlainClick, useHrefNavigate } from '@/components/shared/DataTableBody.tsx';
import { JsonView } from '@/components/shared/JsonView.tsx';
import { KeyValue } from '@/components/shared/KeyValue.tsx';
import { RelativeTime } from '@/components/shared/RelativeTime.tsx';
import { StatusBadge } from '@/components/shared/StatusBadge.tsx';
import { UrlCell } from '@/components/shared/url-cell.tsx';
import { buttonVariants } from '@/components/ui/button.tsx';
import { formatAbsolute, formatDuration } from '@/lib/format/time.ts';
import { ICONS } from '@/lib/icons.ts';
import { cn } from '@/lib/utils.ts';
import { interceptBadge, interceptOf } from './SecurityIntercept.tsx';
import { sessionHref } from './session-link.ts';

/** "Site check" / "Write approval" for a site pack's request, else `null`. */
export function interceptLabel(row: OperatorRequestRow): string | null {
  const options = interceptOf(row);
  return options === null ? null : interceptBadge(options).label;
}

export const MODE_LABEL: Record<string, string> = { takeover: 'Take over', notify: 'Notify' };
export const STATUS_LABEL: Record<string, string> = {
  resolved: 'Resolved',
  rejected: 'Rejected',
  timeout: 'Timed out',
  cancelled: 'Cancelled',
};

/**
 * Chip options for a facet dimension: every known value in `values` order, with the API count
 * (the server omits zero counts, so missing values read 0).
 */
export function facetOptions(
  facets: readonly Facet[] | undefined,
  values: readonly string[],
): Facet[] {
  return values.map((value) => ({
    value,
    count: facets?.find((f) => f.value === value)?.count ?? 0,
  }));
}

/** Expanded row: the full decision record. */
export function RowDetail({ row }: { readonly row: OperatorRequestRow }) {
  const go = useHrefNavigate();
  const href = sessionHref(row.session_id);
  const Arrow = ICONS.arrowRight;
  const hasOptions =
    row.options !== null &&
    row.options !== undefined &&
    (typeof row.options !== 'object' || Object.keys(row.options).length > 0);
  return (
    <div className="flex flex-col gap-4 py-2 text-base">
      <p className="font-medium text-pretty break-words">{row.reason}</p>
      <KeyValue
        columns={2}
        items={[
          {
            key: 'Message to agent',
            value: row.message !== null && row.message !== '' ? row.message : '—',
          },
          { key: 'Resolution', value: row.resolution_reason ?? '—' },
          { key: 'Page', value: <UrlCell url={row.page_url} head={40} tail={20} /> },
          { key: 'Tool', value: row.tool ?? '—', mono: true },
          { key: 'Requested', value: formatAbsolute(row.created_at) },
          {
            key: 'Settled',
            value:
              row.resolved_at === null
                ? '—'
                : `${formatAbsolute(row.resolved_at)}${row.resolved_by !== null ? ` by ${row.resolved_by}` : ''}`,
          },
        ]}
      />
      {hasOptions ? (
        <div className="flex flex-col gap-1.5">
          <span className="section-label">Options from the agent</span>
          <JsonView value={row.options} />
        </div>
      ) : null}
      <div>
        <a
          href={href}
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
          onClick={(event) => {
            if (!isPlainClick(event)) return;
            event.preventDefault();
            go(href);
          }}
        >
          Open session
          <Arrow aria-hidden="true" />
        </a>
      </div>
    </div>
  );
}

/**
 * Phone card: outcome and mode, the reason over three lines, then session · waited ·
 * requested. Tapping the card expands the full decision record in place.
 */
export function HistoryCard({
  row,
  expanded,
}: {
  readonly row: OperatorRequestRow;
  readonly expanded: boolean;
}) {
  const Chevron = ICONS.chevronDown;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2 text-sm">
          <StatusBadge domain="request" value={row.status} />
          {row.mode !== null ? (
            <>
              <span aria-hidden="true" className="text-muted-foreground">
                ·
              </span>
              <span className="text-muted-foreground">{MODE_LABEL[row.mode] ?? row.mode}</span>
            </>
          ) : null}
        </span>
        <Chevron
          aria-hidden="true"
          className={cn(
            'size-4 shrink-0 text-muted-foreground transition-transform duration-(--duration-fast)',
            expanded && 'rotate-180',
          )}
        />
      </div>
      {expanded ? (
        <RowDetail row={row} />
      ) : (
        <>
          <p className="line-clamp-3 break-words">{row.reason}</p>
          {row.message !== null && row.message !== '' ? (
            <p className="truncate text-sm text-muted-foreground">“{row.message}”</p>
          ) : null}
          <p className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
            <span className="min-w-0 truncate">{row.session_slug}</span>
            <span aria-hidden="true">·</span>
            <span className="shrink-0 tabular-nums">
              waited {formatDuration(row.waited_ms ?? 0)}
            </span>
            <span aria-hidden="true">·</span>
            <RelativeTime at={row.created_at} className="shrink-0" />
          </p>
        </>
      )}
    </div>
  );
}

/** A session link inside an expandable row (a real link; clicks never toggle the row). */
export function SessionLink({ id, slug }: { readonly id: string; readonly slug: string }) {
  const go = useHrefNavigate();
  const href = sessionHref(id);
  return (
    <a
      href={href}
      className="block truncate font-medium text-foreground decoration-muted-foreground/60 underline-offset-4 hover:underline"
      onClick={(event) => {
        if (!isPlainClick(event)) return;
        event.preventDefault();
        go(href);
      }}
    >
      {slug}
    </a>
  );
}

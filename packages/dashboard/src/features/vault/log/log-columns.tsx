/** @module features/vault/log/log-columns — access log columns (whitelisted fields only) and the expanded row detail (reason, origin check, safe details) (spec 04 §12.8) */
import type { VaultAccessRow } from '@browserhive/contracts/http';
import { Chip, VaultChip } from '@/components/shared/Chip.tsx';
import { RelativeTime } from '@/components/shared/RelativeTime.tsx';
import { StatusBadge } from '@/components/shared/StatusBadge.tsx';
import { SessionRef } from '@/components/shared/session-ref.tsx';
import { UrlCell } from '@/components/shared/url-cell.tsx';
import type { DataTableColumn } from '@/components/shared/use-data-table.ts';
import { safeDetails } from './safe-fields.ts';

/** Expanded detail: reason, origin check result, whitelisted detail keys. Raw `details` is never rendered. */
export function AccessDetail({ row }: { readonly row: VaultAccessRow }) {
  const pairs = safeDetails(row.details);
  return (
    <dl className="grid grid-cols-[minmax(7rem,auto)_minmax(0,1fr)] gap-x-4 gap-y-1.5 py-1 text-sm">
      <dt className="text-muted-foreground">reason</dt>
      <dd>{row.reason ?? '—'}</dd>
      <dt className="text-muted-foreground">origin check</dt>
      <dd>
        <StatusBadge domain="originCheck" value={row.origin_check} />
      </dd>
      <dt className="text-muted-foreground">page</dt>
      <dd className="min-w-0">
        <UrlCell url={row.page_url} />
      </dd>
      <dt className="text-muted-foreground">handle</dt>
      <dd className="font-mono text-sm">{row.handle ?? '—'}</dd>
      <dt className="text-muted-foreground">principal</dt>
      <dd className="font-mono text-sm">{row.principal_id ?? '—'}</dd>
      <dt className="text-muted-foreground">tool event</dt>
      <dd className="font-mono text-sm">{row.tool_event_id ?? '—'}</dd>
      {pairs.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="font-mono text-sm text-muted-foreground">{key}</dt>
          <dd className="font-mono text-sm [overflow-wrap:anywhere]">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Column set. */
export function logColumns(): readonly DataTableColumn<VaultAccessRow>[] {
  return [
    {
      id: 'time',
      header: 'Time',
      sortable: true,
      nowrap: true,
      cell: (r) => <RelativeTime at={r.ts} mode="absolute" />,
    },
    {
      id: 'entry',
      nowrap: true,
      header: 'Entry',
      sortable: true,
      cell: (r) => <VaultChip handle={r.entry_name} />,
    },
    {
      id: 'result',
      nowrap: true,
      header: 'Result',
      sortable: true,
      cell: (r) => <StatusBadge domain="vaultResult" value={r.result} />,
    },
    {
      id: 'origin',
      nowrap: true,
      header: 'Origin',
      priority: 3,
      cell: (r) => <StatusBadge domain="originCheck" value={r.origin_check} />,
    },
    {
      id: 'evaluate',
      header: 'Evaluate',
      priority: 3,
      cell: (r) =>
        r.evaluate_enabled ? (
          <Chip tone="warn">on</Chip>
        ) : (
          <span className="text-sm text-muted-foreground">off</span>
        ),
    },
    {
      id: 'session',
      header: 'Session',
      sortable: true,
      cell: (r) => (
        <SessionRef id={r.session_id} {...(r.session_slug !== null && { slug: r.session_slug })} />
      ),
    },
    {
      id: 'page',
      header: 'Page',
      priority: 3,
      className: 'max-w-72',
      cell: (r) => <UrlCell url={r.page_url} />,
    },
    {
      id: 'detail',
      header: 'Detail',
      priority: 3,
      grow: true,
      className: 'min-w-48',
      cell: (r) => <span className="text-sm text-muted-foreground">{r.reason ?? '—'}</span>,
    },
  ];
}

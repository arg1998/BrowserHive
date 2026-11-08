/** @module features/saved-logins/columns — saved-login table columns (name, kind, owner, size, saved, source session, delete) and the mobile card; a source session links to its page while its record exists */
import type { AuthStateRow } from '@browserhive/contracts/http';
import { Chip } from '@/components/shared/Chip.tsx';
import { RelativeTime } from '@/components/shared/RelativeTime.tsx';
import { SessionRef } from '@/components/shared/session-ref.tsx';
import type { DataTableColumn } from '@/components/shared/use-data-table.ts';
import { Button } from '@/components/ui/button.tsx';
import { Hint } from '@/components/ui/tooltip.tsx';
import { formatBytes } from '@/lib/format/bytes.ts';
import { truncateId } from '@/lib/format/ids.ts';
import { ICONS } from '@/lib/icons.ts';
import { KIND_LABEL } from './api.ts';

/** The kind as a quiet chip. */
export function KindChip({ kind }: { readonly kind: AuthStateRow['kind'] }) {
  return <Chip tone={kind === 'profile' ? 'info' : 'neutral'}>{KIND_LABEL[kind]}</Chip>;
}

/** The source session: a link while the session exists, otherwise its id marked as deleted. */
export function SourceSession({ row }: { readonly row: AuthStateRow }) {
  if (row.source_session_slug !== null) {
    return <SessionRef id={row.source_session_id} slug={row.source_session_slug} />;
  }
  return (
    <Hint
      label={
        <>
          Session <span className="font-mono">{row.source_session_id}</span> was deleted
        </>
      }
    >
      <span className="inline-flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
        <span className="truncate font-mono">{truncateId(row.source_session_id)}</span>
        <span className="shrink-0">· deleted</span>
      </span>
    </Hint>
  );
}

function DeleteButton({
  row,
  onDelete,
}: {
  readonly row: AuthStateRow;
  readonly onDelete: (row: AuthStateRow) => void;
}) {
  const Delete = ICONS.delete;
  return (
    <Button
      type="button"
      variant="destructive-ghost"
      size="icon-sm"
      aria-label={`Delete saved login ${row.name} of ${row.owner}`}
      onClick={() => onDelete(row)}
    >
      <Delete aria-hidden="true" />
    </Button>
  );
}

/** Column set. */
export function savedLoginColumns(options: {
  readonly onDelete: (row: AuthStateRow) => void;
}): readonly DataTableColumn<AuthStateRow>[] {
  return [
    {
      id: 'name',
      header: 'Name',
      sortable: true,
      priority: 1,
      grow: true,
      className: 'min-w-40',
      cell: (r) => (
        <Hint label={r.name.length > 24 ? <span className="font-mono">{r.name}</span> : null}>
          <span className="block min-w-0 truncate font-mono text-sm font-medium">{r.name}</span>
        </Hint>
      ),
    },
    {
      id: 'kind',
      header: 'Kind',
      sortable: true,
      priority: 1,
      nowrap: true,
      cell: (r) => <KindChip kind={r.kind} />,
    },
    {
      id: 'owner',
      header: 'Owner',
      sortable: true,
      priority: 1,
      className: 'max-w-48',
      cell: (r) => <span className="block truncate font-mono text-sm">{r.owner}</span>,
    },
    {
      id: 'size',
      header: 'Size',
      sortable: true,
      priority: 2,
      align: 'end',
      nowrap: true,
      cell: (r) => <span className="text-sm tabular-nums">{formatBytes(r.size)}</span>,
    },
    {
      id: 'saved',
      header: 'Saved',
      sortable: true,
      priority: 1,
      nowrap: true,
      cell: (r) => <RelativeTime at={r.saved_at} className="text-sm" />,
    },
    {
      id: 'source',
      header: 'Source session',
      priority: 2,
      className: 'min-w-60',
      cell: (r) => <SourceSession row={r} />,
    },
    {
      id: 'actions',
      header: 'Actions',
      hideHeader: true,
      align: 'end',
      nowrap: true,
      priority: 1,
      className: 'w-14',
      cell: (r) => (
        <Hint label="Delete saved login">
          <DeleteButton row={r} onDelete={options.onDelete} />
        </Hint>
      ),
    },
  ];
}

/** Mobile card: name and kind, owner · size · saved, source session, delete. */
export function SavedLoginCard({
  row,
  onDelete,
}: {
  readonly row: AuthStateRow;
  readonly onDelete: (row: AuthStateRow) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="font-mono text-sm font-medium [overflow-wrap:anywhere]">{row.name}</span>
          <span>
            <KindChip kind={row.kind} />
          </span>
        </div>
        <DeleteButton row={row} onDelete={onDelete} />
      </div>
      <span className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
        <span className="font-mono">{row.owner}</span> · {formatBytes(row.size)} · saved{' '}
        <RelativeTime at={row.saved_at} />
      </span>
      <SourceSession row={row} />
    </div>
  );
}

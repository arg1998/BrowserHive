/** @module features/site-packs/HistoryTabs — the History tab of `/site-packs` and of a pack's page (`GET /site-packs/changes`: every approval, update, rejection and revert, newest first; `packId` narrows it to one pack) and `PagedList`, the loading, error, empty and "Show older" frame it shares with the Guard hits tab (spec 13 §9.9, §11.4) */
import type { SitePackChangeRow } from '@browserhive/contracts/http';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { Chip } from '@/components/shared/Chip.tsx';
import { EmptyState } from '@/components/shared/EmptyState.tsx';
import { ErrorState } from '@/components/shared/ErrorState.tsx';
import { RelativeTime } from '@/components/shared/RelativeTime.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { toAppError } from '@/lib/api/errors.ts';
import { useSitePackChanges } from './api.ts';
import { SOURCE_LABEL } from './model.ts';
import { ShaText } from './PackBits.tsx';

const DECISION_LABEL: { readonly [K in SitePackChangeRow['decision']]: string } = {
  available: 'Available',
  downloaded: 'Waiting for review',
  auto: 'Applied automatically',
  approved: 'Approved',
  rejected: 'Rejected',
  superseded: 'Superseded',
  reverted: 'Reverted',
};

/** Loading, error, empty and "Show older" around a paged list. */
export function PagedList({
  query,
  label,
  empty,
  more,
  children,
}: {
  readonly query: {
    readonly isPending: boolean;
    readonly isError: boolean;
    readonly error: unknown;
    readonly refetch: () => unknown;
    readonly hasNextPage: boolean;
    readonly isFetchingNextPage: boolean;
    readonly fetchNextPage: () => unknown;
  };
  readonly label: string;
  readonly empty: ReactNode;
  readonly more: string;
  readonly children: ReactNode[];
}) {
  if (query.isPending)
    return (
      <div
        className="flex flex-col gap-2"
        role="status"
        aria-busy="true"
        aria-label={`Loading ${label}`}
      >
        <Skeleton className="h-14 rounded-xl" />
        <Skeleton className="h-14 rounded-xl" />
      </div>
    );
  if (query.isError)
    return (
      <ErrorState
        tier="region"
        error={toAppError(query.error)}
        onRetry={() => void query.refetch()}
      />
    );
  if (children.length === 0) return <>{empty}</>;
  return (
    <section
      aria-label={label}
      className="overflow-hidden rounded-xl border bg-card shadow-xs dark:shadow-none"
    >
      <ul className="flex flex-col divide-y">{children}</ul>
      {query.hasNextPage ? (
        <div className="flex justify-center border-t px-5 py-3">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            {query.isFetchingNextPage ? <Spinner /> : null}
            {more}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

/** One history row. */
function ChangeRow({
  row,
  showPack,
}: {
  readonly row: SitePackChangeRow;
  readonly showPack: boolean;
}) {
  // Local content has no version of its own: say "local file" (review S-L4); the short SHA-256 below names it.
  const to = row.to_version === null ? 'local file' : `v${row.to_version}`;
  const versions = row.from_version === null ? to : `v${row.from_version} → ${to}`;
  return (
    <li className="flex min-w-0 flex-col gap-1 px-5 py-3 sm:flex-row sm:items-start sm:gap-6">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
          {showPack ? (
            <Link
              to="/site-packs/$id"
              params={{ id: row.pack_id }}
              className="font-medium hover:underline underline-offset-4 focus-ring rounded-sm"
            >
              <bdi>{row.pack_id}</bdi>
            </Link>
          ) : null}
          <span className="tabular-nums">{versions}</span>
          <Chip tone={row.decision === 'rejected' ? 'muted' : 'neutral'}>
            {DECISION_LABEL[row.decision]}
          </Chip>
          <span className="text-sm text-muted-foreground">{SOURCE_LABEL[row.source]}</span>
        </p>
        {row.new_domains.length > 0 ? (
          <p className="text-sm text-warn-text">New domains: {row.new_domains.join(', ')}</p>
        ) : null}
        {row.notes !== null ? (
          <p className="text-sm text-pretty">
            <bdi>{row.notes}</bdi>
          </p>
        ) : null}
        <ShaText sha256={row.to_sha256} className="text-muted-foreground" />
      </div>
      <div className="flex shrink-0 flex-col gap-0.5 text-sm text-muted-foreground sm:items-end">
        <RelativeTime at={row.decided_at ?? row.created_at} className="text-sm" />
        {row.decided_by !== null ? <span>by {row.decided_by}</span> : null}
      </div>
    </li>
  );
}

/** History tab. */
export function HistoryTab({ packId }: { readonly packId?: string }) {
  const query = useSitePackChanges(packId);
  const rows = query.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <PagedList
      query={query}
      label="Pack history"
      more="Show older changes"
      empty={
        <EmptyState
          kind="zero-data"
          variant="panel"
          icon="versions"
          title="No pack changes yet"
          description="Approvals, applied updates, rejections and reverts are listed here, newest first."
        />
      }
    >
      {rows.map((row) => (
        <ChangeRow key={row.event_id} row={row} showPack={packId === undefined} />
      ))}
    </PagedList>
  );
}

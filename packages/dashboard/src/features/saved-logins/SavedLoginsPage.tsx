/** @module features/saved-logins/SavedLoginsPage — `/saved-logins`: every principal's saved logins (storage states and full profiles) with name, kind, owner, size, when saved and the source session; search and owner filter; confirmed delete; live via the `auth-states` topic (spec 04 §12.7.1) */
import type { AuthStateRow } from '@browserhive/contracts/http';
import { useConfirm } from '@/app/providers/ConfirmProvider.tsx';
import { useTopic } from '@/app/providers/SocketProvider.tsx';
import { DataTable } from '@/components/shared/DataTable.tsx';
import { EmptyState } from '@/components/shared/EmptyState.tsx';
import { ErrorState } from '@/components/shared/ErrorState.tsx';
import { FilterBar, type FilterToken } from '@/components/shared/FilterBar.tsx';
import { Stack } from '@/components/shared/layout.tsx';
import { PageHeader } from '@/components/shared/PageHeader.tsx';
import { SkeletonTable } from '@/components/shared/Skeletons.tsx';
import { toAppError } from '@/lib/api/errors.ts';
import { formatBytes, formatNumber } from '@/lib/format/bytes.ts';
import { useSearchState } from '@/lib/search/use-search-state.ts';
import { savedLoginId, useDeleteSavedLogin, useSavedLogins, viewOf } from './api.ts';
import { SavedLoginCard, savedLoginColumns } from './columns.tsx';
import { SAVED_LOGIN_SORT_KEYS, type SavedLoginsSearch } from './search.ts';

const NO_ROWS: readonly AuthStateRow[] = [];

/** Saved logins. */
export function SavedLoginsPage() {
  const { search, set, clear } = useSearchState<SavedLoginsSearch>();
  const list = useSavedLogins();
  const remove = useDeleteSavedLogin();
  const confirm = useConfirm();
  useTopic('auth-states');
  const all = list.data?.data ?? NO_ROWS;
  const view = viewOf(all, search);
  const filtered = search.q !== undefined || search.owner !== undefined;
  const onDelete = async (row: AuthStateRow) => {
    const ok = await confirm({
      title: `Delete saved login ${row.name}?`,
      description: `Owner: ${row.owner}. Agents of this principal can no longer restore it, and the identity saved with it goes too. Sessions already restored from it keep running.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (ok) remove.mutate(row);
  };
  const tokens: FilterToken[] =
    search.owner !== undefined
      ? [{ key: 'owner', value: search.owner, onRemove: () => set({ owner: undefined }) }]
      : [];
  const totalSize = all.reduce((sum, r) => sum + r.size, 0);
  return (
    <Stack gap={4}>
      <PageHeader
        title="Saved logins"
        description="Logins agents saved to reuse in later sessions, for every principal."
        learnMore={
          <>
            <p>
              An agent saves a login with <code>save_storage_state</code> (cookies, local storage
              and IndexedDB) or <code>save_full_profile</code> (the whole browser profile), and
              restores it when it launches a session. Each principal sees and restores only its own.
            </p>
            <p>
              They hold live cookies and tokens. Delete the ones nobody needs: a session already
              restored from one keeps running, and the agent can save it again.
            </p>
          </>
        }
        learnMoreDocs="dashboardSavedLogins"
        {...(list.data !== undefined &&
          all.length > 0 && {
            meta: (
              <span className="text-muted-foreground">
                {formatNumber(all.length)} saved login{all.length === 1 ? '' : 's'} ·{' '}
                {formatBytes(totalSize)}
              </span>
            ),
          })}
      />
      {list.data !== undefined && all.length === 0 && !filtered ? null : (
        <FilterBar
          search={{ param: 'q', placeholder: 'Search name, owner or session…', value: search.q }}
          tokens={tokens}
          {...(list.data !== undefined && { matching: view.total })}
          onChange={(param, value) => set({ [param]: value })}
          onClear={() => clear()}
        />
      )}
      {list.isError ? (
        <ErrorState
          tier="region"
          variant="panel"
          error={toAppError(list.error)}
          onRetry={() => void list.refetch()}
        />
      ) : list.data === undefined ? (
        <SkeletonTable rowCount={6} />
      ) : all.length === 0 && !filtered ? (
        <EmptyState
          kind="zero-data"
          variant="panel"
          icon="savedLogins"
          title="No saved logins"
          description={
            <>
              When an agent calls <code>save_storage_state</code> or <code>save_full_profile</code>,
              the login shows up here.
            </>
          }
        />
      ) : (
        <DataTable<AuthStateRow>
          label="Saved logins"
          columns={savedLoginColumns({ onDelete: (row) => void onDelete(row) })}
          rows={view.rows}
          rowCount={view.total}
          hasNext={search.page * search.ps < view.total}
          state={{ sort: search.sort, dir: search.dir, page: search.page, pageSize: search.ps }}
          sortKeys={SAVED_LOGIN_SORT_KEYS}
          getRowId={savedLoginId}
          rowLabel={(r) => `${r.name} (${r.owner})`}
          renderCard={(r) => <SavedLoginCard row={r} onDelete={(row) => void onDelete(row)} />}
          onStateChange={(patch) => set({ ...patch })}
          emptyState={
            <EmptyState kind="zero-results" title="No saved logins match" onClear={() => clear()} />
          }
        />
      )}
    </Stack>
  );
}

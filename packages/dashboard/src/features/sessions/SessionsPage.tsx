/** @module features/sessions/SessionsPage — `/sessions` fleet list: header count, time-window callout, filters or bulk bar (selection is local state), whole-row linked DataTable with cards under `md`, topics `sessions` + `attention` ; one count on screen, and columns that follow the table's width (spec 04 §12.2) */
import type { SessionSummary } from '@browserhive/contracts/http';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTopic } from '@/app/providers/SocketProvider.tsx';
import { SelectionToolbar } from '@/components/shared/bulk-bar.tsx';
import { Callout } from '@/components/shared/Callout.tsx';
import { DataPanel } from '@/components/shared/DataPanel.tsx';
import { DataTable } from '@/components/shared/DataTable.tsx';
import { Stack } from '@/components/shared/layout.tsx';
import { PageHeader } from '@/components/shared/PageHeader.tsx';
import { SkeletonTable } from '@/components/shared/Skeletons.tsx';
import { Button } from '@/components/ui/button.tsx';
import { formatNumber } from '@/lib/format/bytes.ts';
import { formatAbsolute } from '@/lib/format/time.ts';
import { useSearchState } from '@/lib/search/use-search-state.ts';
import { useServerNow } from '@/lib/server-now.ts';
import { useSessionsListQuery } from './api.ts';
import { SessionCard } from './list/SessionCard.tsx';
import { SessionRowActions } from './list/SessionRowActions.tsx';
import { SessionsBulk } from './list/SessionsBulk.tsx';
import { SessionsFilters } from './list/SessionsFilters.tsx';
import { SessionsEmpty } from './list/session-empty.tsx';
import { sessionColumns } from './list/sessions-columns.tsx';
import {
  hasSessionFilters,
  SESSION_FILTER_KEYS,
  SESSION_SORT_KEYS,
  type SessionsSearch,
  sessionsKeyParams,
} from './search.ts';
import { useCursorPage } from './use-cursor-page.ts';

/** Header count text: "{total} sessions · {live} live" or "{total} archived". */
export function countText(
  total: number | undefined,
  live: number,
  archived: boolean,
): string | undefined {
  if (total === undefined) return undefined;
  if (archived) return `${formatNumber(total)} archived`;
  return `${formatNumber(total)} ${total === 1 ? 'session' : 'sessions'} · ${formatNumber(live)} live`;
}

const EMPTY_SELECTION: ReadonlyMap<string, boolean> = new Map();

/** Sessions list. */
export function SessionsPage() {
  const { search, set, clear } = useSearchState<SessionsSearch>();
  const now = useServerNow();
  const signature = JSON.stringify(sessionsKeyParams({ ...search, page: 1 }, undefined));
  const resetPage = useCallback(() => set({ page: undefined }), [set]);
  const cursorPage = useCursorPage(signature, search.page, resetPage);
  const query = useSessionsListQuery(search, cursorPage.cursor, cursorPage.known);
  const nextCursor = query.data?.page.next_cursor;
  useEffect(() => {
    if (nextCursor !== undefined) cursorPage.remember(search.page, nextCursor);
  }, [nextCursor, search.page, cursorPage]);
  useTopic('sessions');
  useTopic('attention');

  // Selection is local (never in the URL) and resets when the filters change.
  const [picked, setPicked] = useState<{
    readonly signature: string;
    readonly rows: ReadonlyMap<string, boolean>;
  }>({ signature, rows: new Map() });
  const selected = picked.signature === signature ? picked.rows : EMPTY_SELECTION;
  const selection = useMemo(() => new Set(selected.keys()), [selected]);
  const setSelected = useCallback(
    (rows: ReadonlyMap<string, boolean>) => setPicked({ signature, rows }),
    [signature],
  );
  const liveOf = useCallback(
    (ids: readonly string[]) => {
      const known = new Map<string, boolean>(
        (query.data?.data ?? []).map((row) => [row.session_id, row.live] as const),
      );
      return new Map(ids.map((id) => [id, known.get(id) ?? selected.get(id) ?? false] as const));
    },
    [query.data, selected],
  );
  const onFilter = useCallback(
    (param: string, value: string | readonly string[] | undefined) => set({ [param]: value }),
    [set],
  );
  const onClear = useCallback(() => clear(['ps', 'sort', 'dir']), [clear]);
  const showOwner = (query.data?.facets.owners.length ?? 0) > 1;
  const columns = useMemo(
    () => sessionColumns(now, (session) => <SessionRowActions session={session} />, { showOwner }),
    [now, showOwner],
  );
  const total = query.data?.page.total;
  const liveShown = query.data?.facets.states.find((f) => f.value === 'live')?.count ?? 0;
  // One count on screen: the header counts the fleet while unfiltered; once a filter is
  // on, the filter row says how many match and the header goes back to its description.
  const filtered = hasSessionFilters(search) && search.view !== 'archived';
  const count = filtered ? undefined : countText(total, liveShown, search.view === 'archived');

  return (
    <Stack gap={4}>
      <PageHeader
        title="Sessions"
        description={count ?? 'Every browser an agent launched.'}
        learnMore={
          <>
            Sessions are started by MCP clients with the <code>launch_session</code> tool. The
            dashboard observes them and takes over when an agent asks; it never launches browsers
            itself.
          </>
        }
      />
      {search.since !== undefined || search.until !== undefined ? (
        <Callout
          tone="info"
          action={
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto px-0"
              onClick={() => set({ since: undefined, until: undefined })}
            >
              clear time filter
            </Button>
          }
        >
          Showing sessions active{' '}
          {search.since !== undefined ? formatAbsolute(search.since) : 'the beginning'} –{' '}
          {search.until !== undefined ? formatAbsolute(search.until) : 'now'}
        </Callout>
      ) : null}
      <SelectionToolbar
        bulk={
          selection.size > 0 ? (
            <SessionsBulk
              search={search}
              selection={selected}
              total={total}
              onSelection={setSelected}
            />
          ) : null
        }
      >
        <SessionsFilters
          search={search}
          facets={query.data?.facets}
          matching={filtered ? total : undefined}
          onChange={onFilter}
          onClear={onClear}
        />
      </SelectionToolbar>
      <DataPanel query={query} skeleton={<SkeletonTable />} isEmpty={() => false} empty={null}>
        {(page) => (
          // The columns answer to the table's width, not the viewport's: the sidebar may be expanded
          // or a rail at the same window size.
          <div className="@container min-w-0">
            <DataTable<SessionSummary>
              label="Sessions"
              columns={columns}
              rows={page.data}
              {...(page.page.total !== undefined && { rowCount: page.page.total })}
              hasNext={page.page.next_cursor !== null}
              state={{
                page: search.page,
                pageSize: search.ps,
                sort: search.sort,
                dir: search.dir,
                selection,
              }}
              sortKeys={SESSION_SORT_KEYS}
              getRowId={(row) => row.session_id}
              onStateChange={(patch) => {
                if (patch.sel !== undefined) setSelected(liveOf(patch.sel));
                else set(patch);
              }}
              rowHref={(row) => `/sessions/${encodeURIComponent(row.session_id)}`}
              rowLabel={(row) => row.slug}
              loading={query.isPending}
              emptyState={<SessionsEmpty search={search} onClear={onClear} />}
              renderCard={(row) => (
                <SessionCard
                  session={row}
                  now={now}
                  selected={selection.has(row.session_id)}
                  onSelect={(on) => {
                    const next = new Map(selected);
                    if (on) next.set(row.session_id, row.live);
                    else next.delete(row.session_id);
                    setSelected(next);
                  }}
                  actions={<SessionRowActions session={row} compact />}
                />
              )}
            />
          </div>
        )}
      </DataPanel>
    </Stack>
  );
}

/** Keys the "Clear all" control removes (documented for tests). */
export const CLEARED_KEYS = SESSION_FILTER_KEYS;

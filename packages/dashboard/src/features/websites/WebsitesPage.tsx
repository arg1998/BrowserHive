/** @module features/websites/WebsitesPage — cross-session navigation history: header count + range, filter bar (search, category chips, domain/session tokens), a table that fits (URL grows and truncates; whole-row link to the session; a hover-revealed "filter to this domain" button), and "Most visited domains" as a collapsible full-width panel above the table at every width (bars flow into 1–3 columns) (spec 04 §12.5) */
import type { Facet, FleetPageRow, PagesPage } from '@browserhive/contracts/http';
import { useRef, useState } from 'react';
import { useTopic } from '@/app/providers/SocketProvider.tsx';
import { DataTable } from '@/components/shared/DataTable.tsx';
import { EmptyState } from '@/components/shared/EmptyState.tsx';
import { ErrorState } from '@/components/shared/ErrorState.tsx';
import { FilterBar, type FilterToken } from '@/components/shared/FilterBar.tsx';
import { PageHeader } from '@/components/shared/PageHeader.tsx';
import { RelativeTime } from '@/components/shared/RelativeTime.tsx';
import { TimeRangeControl } from '@/components/shared/time-range-control.tsx';
import { UrlCell } from '@/components/shared/url-cell.tsx';
import type { DataTableColumn } from '@/components/shared/use-data-table.ts';
import { Button } from '@/components/ui/button.tsx';
import { Hint } from '@/components/ui/tooltip.tsx';
import { NewRowsPill } from '@/features/overview/components/NewRowsPill.tsx';
import { useLiveHold } from '@/features/overview/live-hold.ts';
import { toAppError } from '@/lib/api/errors.ts';
import { formatAbsoluteShort } from '@/lib/format/time.ts';
import { ICONS } from '@/lib/icons.ts';
import { useSearchState } from '@/lib/search/use-search-state.ts';
import { URL_CATEGORY } from '@/lib/status-registry.ts';
import { cn } from '@/lib/utils.ts';
import { useWebsitesHistory } from './api.ts';
import { SessionTitle } from './components/SessionTitle.tsx';
import { TopDomainsCard } from './components/TopDomainsCard.tsx';
import type { WebsitesSearch } from './search.ts';

const SORT_KEYS = ['time', 'session', 'category', 'domain'] as const;
const CATEGORY_VALUES = Object.keys(URL_CATEGORY);
const KEEP = ['range', 'since', 'until', 'top'] as const;
const EMPTY_ROWS: readonly FleetPageRow[] = [];

/** Hover-revealed "show only this domain" button (toggles off when already filtered). */
function DomainFilterButton({
  domain,
  active,
  onToggle,
}: {
  readonly domain: string;
  readonly active: boolean;
  readonly onToggle: (domain: string) => void;
}) {
  const Filter = ICONS.filter;
  return (
    <Hint label={active ? `Clear the ${domain} filter` : `Show only ${domain}`}>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-pressed={active}
        aria-label={active ? `Clear the ${domain} filter` : `Filter to ${domain}`}
        onClick={() => onToggle(domain)}
      >
        <Filter aria-hidden="true" />
      </Button>
    </Hint>
  );
}

function columns(
  activeDomain: string | undefined,
  onDomain: (domain: string) => void,
): DataTableColumn<FleetPageRow>[] {
  return [
    {
      id: 'time',
      header: 'Time',
      sortable: true,
      nowrap: true,
      priority: 1,
      className: 'w-36',
      cell: (row) => <RelativeTime at={row.ts} mode="absolute" className="text-muted-foreground" />,
    },
    {
      id: 'session',
      header: 'Session',
      sortable: true,
      priority: 1,
      className: 'max-w-60',
      cell: (row) => <SessionTitle id={row.session_id} slug={row.session_slug} />,
    },
    {
      id: 'url',
      header: 'URL',
      priority: 1,
      grow: true,
      cell: (row) => (
        <UrlCell url={row.url} category={row.category} head={40} tail={24} className="min-w-0" />
      ),
    },
    {
      id: 'tab',
      header: 'Tab',
      priority: 3,
      mono: true,
      nowrap: true,
      cell: (row) => <span className="text-muted-foreground">{row.tab_id}</span>,
    },
    {
      id: 'actions',
      header: 'Filter',
      hideHeader: true,
      revealOnHover: true,
      align: 'end',
      className: 'w-12',
      cell: (row) => (
        <DomainFilterButton
          domain={row.domain}
          active={activeDomain === row.domain}
          onToggle={onDomain}
        />
      ),
    },
  ];
}

/**
 * Category chip options. With server facets: known categories in registry order with their counts,
 * zero-count ones hidden unless selected. Without them (a response that omits `facets`) every category, and no
 * counts: counting the loaded page would contradict the matching total.
 */
export function categoryFacets(
  page: Pick<PagesPage, 'facets'> | undefined,
  selected: readonly string[] = [],
): { readonly options: readonly Facet[]; readonly counts: boolean } {
  // Read defensively: the contract requires `facets`, but a response without them must not crash the page.
  const server = (page?.facets as PagesPage['facets'] | undefined)?.category;
  if (server === undefined) {
    return { options: CATEGORY_VALUES.map((value) => ({ value, count: 0 })), counts: false };
  }
  const options = CATEGORY_VALUES.map((value) => ({
    value,
    count: server.find((f) => f.value === value)?.count ?? 0,
  })).filter((f) => f.count > 0 || selected.includes(f.value));
  return { options, counts: true };
}

const rowId = (row: FleetPageRow): string => row.event_id;

/** Websites. */
export function WebsitesPage() {
  const { search, set, clear } = useSearchState<WebsitesSearch>();
  const { history, domains, window } = useWebsitesHistory(search);
  const [domainsOpen, setDomainsOpen] = useState(true);
  useTopic('pages');
  const total = history.data?.page.total;
  const tableRef = useRef<HTMLDivElement>(null);
  const hold = useLiveHold(history.data?.data ?? EMPTY_ROWS, tableRef, {
    getId: rowId,
    listKey: JSON.stringify({ ...search, top: undefined }),
    enabled: search.page === 1 && (search.sort ?? 'time') === 'time' && search.dir !== 'asc',
  });
  const categories = categoryFacets(history.data, search.category);
  const toggleDomain = (domain: string) =>
    set({ domain: search.domain === domain ? undefined : domain, page: 1 });
  const tokens: FilterToken[] = [
    ...(search.domain !== undefined
      ? [{ key: 'domain', value: search.domain, onRemove: () => set({ domain: undefined }) }]
      : []),
    ...(search.session_id !== undefined
      ? [
          {
            key: 'session',
            value: search.session_id,
            onRemove: () => set({ session_id: undefined }),
          },
        ]
      : []),
  ];
  const filtersActive =
    tokens.length > 0 || search.q !== undefined || (search.category?.length ?? 0) > 0;
  const emptyDescription = filtersActive
    ? 'Try widening the filters or the time range.'
    : search.range !== 'all' || search.since !== undefined
      ? `Nothing in the last ${window.label}. Widen the range, or pick All.`
      : 'As agents navigate, every visited URL is recorded here.';
  const Chevron = ICONS.chevronDown;

  const domainsPanel = (
    <TopDomainsCard
      query={domains}
      rangeLabel={window.label}
      top={search.top}
      onTop={(top) => set({ top })}
      active={search.domain}
      onPick={toggleDomain}
      columns
      actions={
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-expanded={domainsOpen}
          aria-label={domainsOpen ? 'Hide domains' : 'Show domains'}
          onClick={() => setDomainsOpen((v) => !v)}
        >
          <Chevron
            aria-hidden="true"
            className={cn(
              'transition-transform duration-(--duration-fast)',
              domainsOpen && 'rotate-180',
            )}
          />
        </Button>
      }
      collapsed={!domainsOpen}
    />
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Websites"
        description="Every page agents navigated to, across all sessions."
        learnMore={
          <>
            <p>
              One row per navigation, from any tab of any session. Destinations that are not public
              web pages get a category tag: raw IP addresses, local hosts (<code>localhost</code>,
              <code>file://</code>), FTP and other schemes.
            </p>
            <p>
              Query strings and fragments are stripped before a URL is stored, except parameters
              listed in <code>urlQueryAllowlist</code>.
            </p>
          </>
        }
        learnMoreDocs="dashboardWebsites"
        actions={
          <TimeRangeControl
            value={search.range}
            since={search.since}
            until={search.until}
            onChange={(patch) => set(patch)}
          />
        }
      />
      <div className="min-w-0">{domainsPanel}</div>
      <div className="flex min-w-0 flex-col gap-4">
        <FilterBar
          search={{ param: 'q', placeholder: 'Search URL or session…', value: search.q }}
          chips={[
            {
              param: 'category',
              label: 'Category',
              options: categories.options,
              counts: categories.counts,
              selected: search.category ?? [],
              format: (value) => URL_CATEGORY[value as keyof typeof URL_CATEGORY]?.label ?? value,
            },
          ]}
          tokens={tokens}
          {...(total !== undefined && { matching: total })}
          onChange={(param, value) => set({ [param]: value })}
          onClear={() => clear(KEEP)}
        />
        {history.isError ? (
          <ErrorState
            tier="region"
            error={toAppError(history.error)}
            onRetry={() => void history.refetch()}
          />
        ) : (
          <div ref={tableRef}>
            <NewRowsPill
              count={hold.pending}
              added={hold.added}
              noun="navigation"
              onShow={hold.release}
              offsetClassName="mt-12"
            />
            <DataTable<FleetPageRow>
              label="Navigation history"
              columns={columns(search.domain, toggleDomain)}
              rows={hold.shown}
              {...(total !== undefined && { rowCount: total })}
              hasNext={history.data?.page.next_cursor !== null}
              state={{
                sort: search.sort,
                dir: search.dir,
                page: search.page,
                pageSize: search.ps,
              }}
              sortKeys={SORT_KEYS}
              getRowId={(row) => row.event_id}
              onStateChange={(patch) => set(patch)}
              loading={history.isPending}
              rowHref={(row) => `/sessions/${encodeURIComponent(row.session_id)}`}
              rowLabel={(row) => `Open session ${row.session_slug ?? row.session_id} at ${row.url}`}
              renderCard={(row) => (
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex min-w-0 items-center justify-between gap-3">
                    <SessionTitle id={row.session_id} slug={row.session_slug} />
                    <span className="shrink-0 text-sm text-muted-foreground tabular-nums">
                      {formatAbsoluteShort(row.ts)}
                    </span>
                  </div>
                  <UrlCell url={row.url} category={row.category} copy={false} className="min-w-0" />
                </div>
              )}
              emptyState={
                <EmptyState
                  kind={filtersActive ? 'zero-results' : 'zero-data'}
                  icon="globe"
                  title="No navigations match"
                  description={emptyDescription}
                  onClear={() => clear(KEEP)}
                />
              }
            />
          </div>
        )}
      </div>
    </div>
  );
}

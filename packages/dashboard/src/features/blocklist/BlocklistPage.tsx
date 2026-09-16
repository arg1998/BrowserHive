/** @module features/blocklist/BlocklistPage — `/blocklist`: short header (explainer in Learn more, Reload with a tooltip reason when disabled); not configured and never used → one compact empty state with a docs link; otherwise tiles, patterns + refused hosts as capped bar lists, and the attempts filter bar + table; live via the `blocklist` topic (spec 04 §12.6) */
import type { BlockedRequestRow } from '@browserhive/contracts/http';
import { useRef } from 'react';
import { useTopic } from '@/app/providers/SocketProvider.tsx';
import { Callout } from '@/components/shared/Callout.tsx';
import { CopyValue } from '@/components/shared/CopyButton.tsx';
import { EmptyState } from '@/components/shared/EmptyState.tsx';
import { ErrorState } from '@/components/shared/ErrorState.tsx';
import { FilterBar, type FilterToken } from '@/components/shared/FilterBar.tsx';
import { PageHeader } from '@/components/shared/PageHeader.tsx';
import { Panel, Section } from '@/components/shared/Section.tsx';
import { SkeletonTiles } from '@/components/shared/Skeletons.tsx';
import { StatTile } from '@/components/shared/StatTile.tsx';
import { TimeRangeControl } from '@/components/shared/time-range-control.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Hint } from '@/components/ui/tooltip.tsx';
import { NewRowsPill } from '@/features/overview/components/NewRowsPill.tsx';
import { tileGridClass } from '@/features/overview/components/OverviewTiles.tsx';
import { useLiveHold } from '@/features/overview/live-hold.ts';
import { BarList } from '@/features/websites/components/BarList.tsx';
import { toAppError } from '@/lib/api/errors.ts';
import { formatNumber } from '@/lib/format/bytes.ts';
import { ICONS } from '@/lib/icons.ts';
import { useSearchState } from '@/lib/search/use-search-state.ts';
import { cn } from '@/lib/utils.ts';
import { useBlocklist, useReloadBlocklist } from './api.ts';
import { AttemptsTable } from './components/AttemptsTable.tsx';
import { PatternsCard } from './components/PatternsCard.tsx';
import type { BlocklistSearch } from './search.ts';

const KEEP = ['range', 'since', 'until'] as const;
const EMPTY_ATTEMPTS: readonly BlockedRequestRow[] = [];
const attemptId = (row: BlockedRequestRow): string => row.event_id;

/** How to configure a blocklist (shared by the empty state and the history callout). */
function HowToConfigure() {
  return (
    <>
      Start the server with <code className="font-mono text-sm">--blocklist &lt;file&gt;</code> (or
      set <code className="font-mono text-sm">BROWSERHIVE_BLOCKLIST</code>), a text file with one
      URL pattern per line.
    </>
  );
}

/** Blocklist. */
export function BlocklistPage() {
  const { search, set, clear } = useSearchState<BlocklistSearch>();
  const { state, attempts, window } = useBlocklist(search);
  const reload = useReloadBlocklist();
  useTopic('blocklist');
  const Refresh = ICONS.refresh;
  const attemptsRef = useRef<HTMLDivElement>(null);
  const hold = useLiveHold(attempts.data?.data ?? EMPTY_ATTEMPTS, attemptsRef, {
    getId: attemptId,
    listKey: JSON.stringify(search),
    enabled: search.page === 1 && (search.sort ?? 'time') === 'time' && search.dir !== 'asc',
  });
  const configured = state.data?.configured === true;
  const neverUsed =
    state.isSuccess && !state.data.configured && state.data.stats.total_all_time === 0;
  const total = attempts.data?.page.total;
  const tokens: FilterToken[] = [
    ...(search.pattern !== undefined
      ? [{ key: 'pattern', value: search.pattern, onRemove: () => set({ pattern: undefined }) }]
      : []),
    ...(search.domain !== undefined
      ? [{ key: 'host', value: search.domain, onRemove: () => set({ domain: undefined }) }]
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
    tokens.length > 0 || search.q !== undefined || (search.source?.length ?? 0) > 0;

  const reloadButton = (
    <Button
      type="button"
      variant="outline"
      disabled={reload.isPending || !configured}
      onClick={() => reload.mutate()}
    >
      <Refresh aria-hidden="true" className={cn(reload.isPending && 'animate-spin')} />
      Reload blocklist
    </Button>
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Blocklist"
        description="URLs agents are refused, at the tool call and in the page."
        learnMore={
          <>
            The navigation tools reject a blocked target outright, and in-page navigations to one
            are aborted at the network layer, so a link or a redirect cannot get around the tool
            check. A bare host such as <code className="font-mono">ads.example.com</code> blocks
            that site and everything under it; <code className="font-mono">*.example.com</code>{' '}
            covers subdomains.
          </>
        }
        actions={
          state.isPending ? undefined : (
            <div className="flex max-w-[calc(100vw-2rem)] flex-wrap items-center gap-2">
              {neverUsed ? null : (
                <TimeRangeControl
                  value={search.range}
                  since={search.since}
                  until={search.until}
                  onChange={(patch) => set(patch)}
                />
              )}
              {configured ? (
                <Hint label="Re-read the blocklist file without restarting the server">
                  {reloadButton}
                </Hint>
              ) : (
                <Hint label="No blocklist file is configured, so there is nothing to reload">
                  {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a disabled button cannot take focus, so its wrapper carries the tooltip reason */}
                  <span tabIndex={0} className="inline-flex rounded-md">
                    {reloadButton}
                  </span>
                </Hint>
              )}
            </div>
          )
        }
      />

      {state.isError ? (
        <ErrorState
          tier="region"
          error={toAppError(state.error)}
          onRetry={() => void state.refetch()}
        />
      ) : null}
      {state.isPending ? (
        <SkeletonTiles count={4} className={cn('grid gap-3 sm:gap-4', tileGridClass(4))} />
      ) : null}

      {neverUsed ? (
        <EmptyState
          kind="not-enabled"
          variant="panel"
          icon="blocklist"
          title="No blocklist is configured"
          className="max-w-2xl"
          description={
            <>
              <HowToConfigure /> Refused navigations will show up here.
            </>
          }
        />
      ) : null}

      {state.data !== undefined && !neverUsed ? (
        <>
          {!state.data.configured ? (
            <Callout tone="info" title="No blocklist is configured">
              <HowToConfigure /> The history below is from a previous run.
            </Callout>
          ) : null}
          {state.data.skipped.length > 0 ? (
            <Callout tone="warn" title="Some lines in the blocklist file do nothing">
              These lines were parsed and discarded, so they are <b>not</b> blocking anything:
              <ul className="mt-2 flex flex-col gap-0.5">
                {state.data.skipped.map((s) => (
                  <li key={`${s.line}-${s.text}`}>
                    <span className="font-mono text-sm">line {s.line}</span>:{' '}
                    <span className="font-mono text-sm">{s.text}</span> — {s.reason}
                  </li>
                ))}
              </ul>
            </Callout>
          ) : null}
          <section
            aria-label="Blocklist metrics"
            className={cn('grid gap-3 sm:gap-4', tileGridClass(4))}
          >
            <StatTile
              label={`Attempts · ${window.label}`}
              value={formatNumber(state.data.stats.attempts)}
              {...(state.data.stats.attempts > 0 && { tone: 'warn' as const })}
              sub={`${formatNumber(state.data.stats.total_all_time)} all-time`}
            />
            <StatTile
              label="Patterns loaded"
              value={formatNumber(state.data.patterns.length)}
              sub={
                state.data.path !== null ? (
                  <CopyValue
                    value={state.data.path}
                    truncate={[18, 12]}
                    label="Copy blocklist path"
                  />
                ) : (
                  'no file'
                )
              }
            />
            <StatTile
              label={`Sessions affected · ${window.label}`}
              value={formatNumber(state.data.stats.sessions)}
              sub="distinct sessions refused"
              info="How many distinct sessions hit the blocklist. One agent repeatedly reaching for a blocked host looks very different from many agents doing it once."
            />
            <StatTile
              label={`Hosts refused · ${window.label}`}
              value={formatNumber(state.data.stats.domains)}
              sub="distinct hosts"
            />
          </section>
          {state.data.configured ? (
            <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-2">
              <PatternsCard
                state={state.data}
                rangeLabel={window.label}
                active={search.pattern}
                onPick={(p) => set({ pattern: search.pattern === p ? undefined : p })}
              />
              <Panel
                title="Top refused hosts"
                description={`Refusals · ${window.label}`}
                padding="none"
                bodyClassName="px-2.5 pt-1 pb-3"
              >
                {state.data.stats.top_domains.length === 0 ? (
                  <EmptyState
                    kind="zero-data"
                    size="sm"
                    icon="check"
                    title="No hosts refused"
                    description={`Nothing was blocked · ${window.label}`}
                  />
                ) : (
                  <BarList
                    label="Refused hosts"
                    tone="warn"
                    items={state.data.stats.top_domains.slice(0, 10).map((d) => ({
                      key: d.domain,
                      label: <span className="font-mono text-sm">{d.domain}</span>,
                      value: d.count,
                      active: search.domain === d.domain,
                      onClick: () =>
                        set({ domain: search.domain === d.domain ? undefined : d.domain }),
                      hint:
                        search.domain === d.domain
                          ? 'Filtered · click to clear'
                          : `Show only attempts on ${d.domain}`,
                    }))}
                  />
                )}
              </Panel>
            </div>
          ) : null}

          <Section
            title="Attempts"
            description={
              window.since === undefined && window.until === undefined
                ? 'Every refused navigation'
                : `Refused navigations in the last ${window.label}`
            }
          >
            <FilterBar
              search={{
                param: 'q',
                placeholder: 'Search URL, pattern or session…',
                value: search.q,
              }}
              chips={[
                {
                  param: 'source',
                  label: 'Source',
                  options: attempts.data?.facets?.['source'] ?? [
                    { value: 'tool', count: 0 },
                    { value: 'request', count: 0 },
                  ],
                  selected: search.source ?? [],
                  counts: attempts.data?.facets?.['source'] !== undefined,
                  format: (value) =>
                    value === 'tool' ? 'Tool call' : value === 'request' ? 'In-page' : value,
                },
              ]}
              tokens={tokens}
              {...(total !== undefined && { matching: total })}
              onChange={(param, value) => set({ [param]: value })}
              onClear={() => clear(KEEP)}
            />
            {attempts.isError ? (
              <ErrorState
                tier="region"
                error={toAppError(attempts.error)}
                onRetry={() => void attempts.refetch()}
              />
            ) : (
              <div ref={attemptsRef}>
                <NewRowsPill
                  count={hold.pending}
                  added={hold.added}
                  noun="attempt"
                  onShow={hold.release}
                  offsetClassName="mt-12"
                />
                <AttemptsTable
                  rows={hold.shown}
                  total={total}
                  hasNext={attempts.data?.page.next_cursor !== null}
                  loading={attempts.isPending}
                  state={{
                    sort: search.sort,
                    dir: search.dir,
                    page: search.page,
                    pageSize: search.ps,
                  }}
                  onStateChange={(patch) => set(patch)}
                  onFilter={(patch) => set(patch)}
                  emptyState={
                    <EmptyState
                      kind={filtersActive ? 'zero-results' : 'zero-data'}
                      icon="check"
                      title="No blocked attempts"
                      description={
                        filtersActive
                          ? 'Nothing matches these filters.'
                          : configured
                            ? 'No agent reached for a blocked URL in this window. That is the good outcome.'
                            : 'Nothing was refused in this window.'
                      }
                      onClear={() => clear(KEEP)}
                    />
                  }
                />
              </div>
            )}
          </Section>
        </>
      ) : null}
    </div>
  );
}

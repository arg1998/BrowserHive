/** @module features/vault/log/VaultLogPage — `/vault/log`: header "{total} events", FilterBar (search, result, origin, evaluate, session/entry tokens, window), table with expandable detail; not-enabled explainer distinct from transient errors (spec 04 §12.8) */
import type { VaultAccessRow } from '@browserhive/contracts/http';
import { useState } from 'react';
import { VaultChip } from '@/components/shared/Chip.tsx';
import { DataTable } from '@/components/shared/DataTable.tsx';
import { EmptyState } from '@/components/shared/EmptyState.tsx';
import { ErrorState } from '@/components/shared/ErrorState.tsx';
import { FilterBar } from '@/components/shared/FilterBar.tsx';
import { Stack } from '@/components/shared/layout.tsx';
import { PageHeader } from '@/components/shared/PageHeader.tsx';
import { RelativeTime } from '@/components/shared/RelativeTime.tsx';
import { SkeletonTable } from '@/components/shared/Skeletons.tsx';
import { StatusBadge } from '@/components/shared/StatusBadge.tsx';
import { TimeRangeControl } from '@/components/shared/time-range-control.tsx';
import { UrlCell } from '@/components/shared/url-cell.tsx';
import { useCursorPager } from '@/components/shared/use-cursor-pages.ts';
import { toAppError } from '@/lib/api/errors.ts';
import { formatNumber } from '@/lib/format/bytes.ts';
import { useSearchState } from '@/lib/search/use-search-state.ts';
import { isVaultOff, useVaultEnabled } from '../api.ts';
import { VaultDisabled } from '../status/VaultDisabled.tsx';
import { useVaultLog, useVaultLogFeed } from './api.ts';
import { AccessDetail, logColumns } from './log-columns.tsx';
import { hasLogFilters, LOG_SORT_KEYS, type VaultLogSearch } from './search.ts';

const RESULTS = ['success', 'origin_mismatch', 'auth_failed', 'blocked', 'denied'] as const;
const ORIGINS = ['pass', 'fail', 'skipped'] as const;

/** Vault log page. */
export function VaultLogPage() {
  const { search, set, clear } = useSearchState<VaultLogSearch>();
  const enabled = useVaultEnabled();
  const pager = useCursorPager();
  const log = useVaultLog(search, pager, enabled === true);
  useVaultLogFeed(search.session, enabled === true);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const patch = (values: Record<string, unknown>) => {
    pager.reset();
    set(values);
  };
  const total = log.data?.page.total;
  const header = (
    <PageHeader
      title="Vault log"
      description="One secret-free audit row per vault_fill: entry, outcome, origin check and page."
      learnMore={
        <>
          <p>
            Every <code>vault_fill</code> and every denied listing is recorded: the entry name, the
            result, whether the page origin matched the entry, whether <code>evaluate</code> was
            enabled, the session and the page URL.
          </p>
          <p>Credentials, usernames and form values are never written here.</p>
        </>
      }
      learnMoreDocs="vaultAudit"
      {...(total !== undefined && {
        meta: <span className="text-muted-foreground">{formatNumber(total)} events</span>,
      })}
    />
  );
  if (enabled === false || isVaultOff(log.error)) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <VaultDisabled page="log" />
      </div>
    );
  }
  const facets = log.data?.facets;
  // The server does not report facets yet; show counts only when it does (no misleading zeros).
  const counted = (param: string) => facets?.[param] !== undefined;
  const options = (param: string, values: readonly string[]) =>
    values.map((value) => ({
      value,
      count: facets?.[param]?.find((f) => f.value === value)?.count ?? 0,
    }));
  const tokens = [
    ...(search.session !== undefined
      ? [{ key: 'session', value: search.session, onRemove: () => patch({ session: undefined }) }]
      : []),
    ...(search.entry !== undefined
      ? [{ key: 'entry', value: search.entry, onRemove: () => patch({ entry: undefined }) }]
      : []),
    ...(search.evaluate !== undefined
      ? [
          {
            key: 'evaluate',
            value: search.evaluate,
            onRemove: () => patch({ evaluate: undefined }),
          },
        ]
      : []),
  ];
  return (
    <Stack gap={4}>
      {header}
      <FilterBar
        search={{ param: 'q', placeholder: 'Search entry, page URL or session…', value: search.q }}
        chips={[
          {
            param: 'result',
            counts: counted('result'),
            label: 'Result',
            options: options('result', RESULTS),
            selected: search.result ?? [],
            format: (v) => v.replace('_', ' '),
          },
          {
            param: 'origin_check',
            counts: counted('origin_check'),
            label: 'Origin',
            options: options('origin_check', ORIGINS),
            selected: search.origin_check ?? [],
          },
          {
            param: 'evaluate',
            counts: counted('evaluate'),
            label: 'Evaluate',
            options: options('evaluate', ['on', 'off']),
            selected: search.evaluate === undefined ? [] : [search.evaluate],
          },
        ]}
        tokens={tokens}
        range={
          <TimeRangeControl
            value={search.range}
            since={search.since}
            until={search.until}
            onChange={(p) => patch({ ...p })}
          />
        }
        {...(total !== undefined && { matching: total })}
        onChange={(param, value) =>
          patch({
            [param]: param === 'evaluate' && Array.isArray(value) ? value[value.length - 1] : value,
          })
        }
        onClear={() => {
          pager.reset();
          clear();
        }}
      />
      {log.isError ? (
        <ErrorState
          tier="region"
          variant="panel"
          error={toAppError(log.error)}
          onRetry={() => void log.refetch()}
        />
      ) : log.data === undefined ? (
        <SkeletonTable rowCount={8} />
      ) : (
        <DataTable<VaultAccessRow>
          label="Vault access log"
          columns={logColumns()}
          rows={log.data.data}
          {...(total !== undefined && { rowCount: total })}
          hasNext={log.data.page.next_cursor !== null}
          state={{ sort: search.sort, dir: search.dir, page: search.page, pageSize: search.ps }}
          sortKeys={LOG_SORT_KEYS}
          getRowId={(r) => r.event_id}
          expandable={(r) => <AccessDetail row={r} />}
          expanded={expanded}
          onToggleExpanded={(r) => toggle(r.event_id)}
          renderCard={(r) => (
            <div className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <VaultChip handle={r.entry_name} />
                <StatusBadge domain="vaultResult" value={r.result} />
              </div>
              <UrlCell url={r.page_url} />
              <span className="text-sm text-muted-foreground">
                <RelativeTime at={r.ts} mode="absolute" />
                {r.reason !== null ? ` · ${r.reason}` : ''}
              </span>
            </div>
          )}
          rowLabel={(r) => `${r.entry_name} ${r.result}`}
          onStateChange={(p) => (p.page === undefined ? patch({ ...p }) : set({ ...p }))}
          emptyState={
            hasLogFilters(search) ? (
              <EmptyState
                kind="zero-results"
                title="No vault accesses match"
                onClear={() => clear()}
              />
            ) : (
              <EmptyState
                kind="zero-data"
                icon="vaultLog"
                title="No vault accesses yet"
                description="Every vault_fill writes one secret-free audit row here."
              />
            )
          }
        />
      )}
    </Stack>
  );
}

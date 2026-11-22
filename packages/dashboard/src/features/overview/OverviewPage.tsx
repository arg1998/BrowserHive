/** @module features/overview/OverviewPage — fleet health: header + range, degradations callout, KPI row, activity chart, two columns from 1280px (recent sessions + websites visited | recent failures + harnesses), then the full-width Websites card last (window stats and most visited domains → `/websites`) (spec 04 §12.1) */
import { useTopic } from '@/app/providers/SocketProvider.tsx';
import { ErrorState } from '@/components/shared/ErrorState.tsx';
import { PageHeader } from '@/components/shared/PageHeader.tsx';
import { TimeRangeControl } from '@/components/shared/time-range-control.tsx';
import { HarnessesCard } from '@/features/harness/HarnessesCard.tsx';
import { toAppError } from '@/lib/api/errors.ts';
import { useSearchState } from '@/lib/search/use-search-state.ts';
import {
  useActivity,
  useHarnessMetrics,
  useRecentFailures,
  useRecentPages,
  useRecentSessions,
  useResolvedWindow,
  useSystemStatus,
  useTopDomains,
  useVaultFills,
  useWebsitesSummary,
} from './api.ts';
import { ActivityCard } from './components/ActivityCard.tsx';
import { DegradationsCallout } from './components/DegradationsCallout.tsx';
import { FailuresCard } from './components/FailuresCard.tsx';
import { OverviewTiles, OverviewTilesSkeleton } from './components/OverviewTiles.tsx';
import { RecentSessionsCard } from './components/RecentSessionsCard.tsx';
import { WebsitesCard } from './components/WebsitesCard.tsx';
import {
  DOMAINS_FETCHED,
  type WebsitesLinkSearch,
  WebsitesStatsCard,
} from './components/WebsitesStatsCard.tsx';
import type { OverviewSearch } from './search.ts';

/** `/websites` search keeping the Overview window (the 7d default stays out of the URL). */
export function websitesSearchFor(
  search: Pick<OverviewSearch, 'range' | 'since' | 'until'>,
): WebsitesLinkSearch {
  if (search.since !== undefined || search.until !== undefined) {
    return {
      ...(search.since !== undefined && { since: search.since }),
      ...(search.until !== undefined && { until: search.until }),
    };
  }
  return search.range !== '7d' ? { range: search.range } : {};
}

/** `/websites` link filtered to one domain, keeping the Overview window. */
export function domainHref(
  domain: string,
  search: Pick<OverviewSearch, 'range' | 'since' | 'until'>,
): string {
  const params = new URLSearchParams({ domain });
  for (const [key, value] of Object.entries(websitesSearchFor(search))) {
    params.set(key, String(value));
  }
  return `/websites?${params.toString()}`;
}

/** Overview. */
export function OverviewPage() {
  const { search, set } = useSearchState<OverviewSearch>();
  const window = useResolvedWindow(search.range, search.since, search.until);
  const activity = useActivity(window);
  const system = useSystemStatus();
  const recentPages = useRecentPages();
  const recentSessions = useRecentSessions();
  const failures = useRecentFailures(window);
  const domains = useTopDomains(window, DOMAINS_FETCHED);
  const websites = useWebsitesSummary(window);
  const harnesses = useHarnessMetrics(window);
  const vaultEnabled = system.data?.vault.enabled === true;
  const vaultFills = useVaultFills(window, vaultEnabled);
  useTopic('sessions');
  useTopic('pages');
  useTopic('system');

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Overview"
        description="Fleet health at a glance: live sessions, tool calls and errors."
        learnMore={
          <>
            <p>
              Tiles and the chart cover the window picked on the right; the sub line of each tile
              gives the all-time total. Click a bar in the activity chart to open the sessions of
              that time slice.
            </p>
            <p>An error is a tool call that failed or reported a failure in its result.</p>
          </>
        }
        learnMoreDocs="dashboardOverview"
        actions={
          <TimeRangeControl
            value={search.range}
            since={search.since}
            until={search.until}
            onChange={(patch) => set(patch)}
          />
        }
      />
      {system.data !== undefined ? (
        <DegradationsCallout degradations={system.data.degradations} />
      ) : null}
      {/* Tiles and chart reserve their final geometry from the first paint (no delayed skeleton):
          everything below them would otherwise move when they land. */}
      {activity.isError && activity.data === undefined ? (
        <ErrorState
          tier="region"
          variant="panel"
          error={toAppError(activity.error)}
          onRetry={() => void activity.refetch()}
        />
      ) : activity.data === undefined || system.isPending ? (
        <OverviewTilesSkeleton />
      ) : (
        <OverviewTiles
          activity={activity.data}
          system={system.data}
          rangeLabel={window.label}
          vaultFills={vaultEnabled ? (vaultFills.data?.page.total ?? 0) : undefined}
        />
      )}
      {activity.isError && activity.data === undefined ? null : (
        <ActivityCard
          activity={activity.data}
          rangeLabel={window.label}
          onZoom={
            search.range !== '24h' && search.since === undefined && search.until === undefined
              ? () => set({ range: '24h' })
              : undefined
          }
        />
      )}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
        <div className="flex min-w-0 flex-col gap-6 xl:col-span-7">
          <RecentSessionsCard query={recentSessions} />
          <WebsitesCard query={recentPages} />
        </div>
        <div className="flex min-w-0 flex-col gap-6 xl:col-span-5">
          <FailuresCard query={failures} rangeLabel={window.label} />
          <HarnessesCard query={harnesses} rangeLabel={window.label} window={window} />
        </div>
      </div>
      <WebsitesStatsCard
        summary={websites}
        domains={domains}
        rangeLabel={window.label}
        search={websitesSearchFor(search)}
        hrefFor={(domain) => domainHref(domain, search)}
      />
    </div>
  );
}

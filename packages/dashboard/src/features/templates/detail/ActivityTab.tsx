/** @module features/templates/detail/ActivityTab — the Activity tab (spec 13 §8, §11.4): every sign-in check of the template's sites, newest first, filterable by site, outcome and why it ran (all in the URL), live over the `templates` topic (`template.probe`); guard hits join with site packs (T3a) */
import { TemplateProbeOutcome, TemplateProbeTrigger } from '@browserhive/contracts/enums';
import type { TemplateDetailResponse } from '@browserhive/contracts/http';
import { EmptyState } from '@/components/shared/EmptyState.tsx';
import { ErrorState } from '@/components/shared/ErrorState.tsx';
import { FilterBar } from '@/components/shared/FilterBar.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { toAppError } from '@/lib/api/errors.ts';
import { useSearchState } from '@/lib/search/use-search-state.ts';
import { SITE_HEALTH } from '@/lib/status-registry.ts';
import { useTemplateProbes } from '../api-health.ts';
import { PROBE_TRIGGER_LABEL } from '../relogin-text.ts';
import type { TemplatePageSearch } from '../search.ts';
import { ProbeRow } from './ProbeRow.tsx';

/** Activity tab. */
export function ActivityTab({ detail }: { readonly detail: TemplateDetailResponse }) {
  const { search, set } = useSearchState<TemplatePageSearch>();
  const id = detail.template.template_id;
  const filters = {
    ...(search.site !== undefined && { site_id: search.site }),
    ...(search.outcome !== undefined && { outcome: search.outcome }),
    ...(search.trigger !== undefined && { trigger: search.trigger }),
  };
  const query = useTemplateProbes(id, filters);
  const filtered = Object.keys(filters).length > 0;
  const rows = query.data?.pages.flatMap((p) => p.data) ?? [];
  const titles = new Map(detail.sites.map((s) => [s.site_id, s.title]));
  const clear = () => set({ site: undefined, outcome: undefined, trigger: undefined });
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <FilterBar
        selects={[
          {
            param: 'site',
            label: 'Site',
            value: search.site,
            allLabel: 'All sites',
            options: detail.sites.map((s) => ({ value: s.site_id, label: s.title })),
          },
        ]}
        chips={[
          {
            param: 'outcome',
            label: 'Outcome',
            options: TemplateProbeOutcome.options.map((value) => ({ value, count: 0 })),
            selected: search.outcome ?? [],
            format: (v) => SITE_HEALTH[v as TemplateProbeOutcome].label,
            counts: false,
          },
          {
            param: 'trigger',
            label: 'Why',
            options: TemplateProbeTrigger.options.map((value) => ({ value, count: 0 })),
            selected: search.trigger ?? [],
            format: (v) => PROBE_TRIGGER_LABEL[v as TemplateProbeTrigger],
            counts: false,
          },
        ]}
        onChange={(param, value) => set({ [param]: value })}
        onClear={clear}
      />
      {query.isPending ? (
        <div
          className="flex flex-col gap-2"
          role="status"
          aria-busy="true"
          aria-label="Loading checks"
        >
          <Skeleton className="h-16 rounded-xl" />
          <Skeleton className="h-16 rounded-xl" />
          <Skeleton className="h-16 rounded-xl" />
        </div>
      ) : query.isError ? (
        <ErrorState
          tier="region"
          error={toAppError(query.error)}
          onRetry={() => void query.refetch()}
        />
      ) : rows.length === 0 ? (
        filtered ? (
          <EmptyState
            kind="zero-results"
            variant="panel"
            title="No checks match these filters"
            description="Try another site, outcome or reason, or clear the filters."
            onClear={clear}
          />
        ) : (
          <EmptyState
            kind="zero-data"
            variant="panel"
            icon="activity"
            title="No sign-in checks yet"
            description="BrowserHive checks each site on a schedule, before launches and when you press Check now. Each result is listed here, newest first."
          />
        )
      ) : (
        <section
          aria-label="Sign-in checks"
          className="overflow-hidden rounded-xl border bg-card shadow-xs dark:shadow-none"
        >
          <ul className="flex flex-col divide-y">
            {rows.map((row) => (
              <ProbeRow key={row.seq} row={row} title={titles.get(row.site_id) ?? row.site_id} />
            ))}
          </ul>
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
                Show older checks
              </Button>
            </div>
          ) : null}
        </section>
      )}
    </div>
  );
}

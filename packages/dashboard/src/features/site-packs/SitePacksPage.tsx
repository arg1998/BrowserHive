/** @module features/site-packs/SitePacksPage — `/site-packs` (spec 13 §11.4 without the registry parts, PR T3a): header with the last load, **Reload local packs** and **Import…**; Updates available (pending bundled versions of followed packs and local files to approve); tabs Packs (source and Updates available chips plus search in the URL, a whole-row linked table that becomes cards under 768px, the Registry card), History and Guard hits; empty and `sitePacks=false` states; live over the `site-packs` topic */
import type { SitePackView } from '@browserhive/contracts/http';
import { useMemo, useState } from 'react';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import { DataPanel } from '@/components/shared/DataPanel.tsx';
import { DataTable } from '@/components/shared/DataTable.tsx';
import { EmptyState } from '@/components/shared/EmptyState.tsx';
import { FilterBar } from '@/components/shared/FilterBar.tsx';
import { Stack } from '@/components/shared/layout.tsx';
import { PageHeader } from '@/components/shared/PageHeader.tsx';
import { RelativeTime } from '@/components/shared/RelativeTime.tsx';
import { SkeletonTable } from '@/components/shared/Skeletons.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs.tsx';
import { ICONS } from '@/lib/icons.ts';
import { configKeyDocsUrl } from '@/lib/links.ts';
import { useSearchState } from '@/lib/search/use-search-state.ts';
import { useReloadSitePacks, useSitePackCatalog, useSitePacks } from './api.ts';
import { GuardHitsTab } from './GuardHitsTab.tsx';
import { HistoryTab } from './HistoryTabs.tsx';
import { ImportButton, type ImportProblem, ImportProblemCallout } from './ImportPack.tsx';
import { useSitePacksLive } from './live.ts';
import { PackCard, packColumns } from './pack-columns.tsx';
import { RegistryCard } from './RegistryCard.tsx';
import {
  hasPackFilters,
  SITE_PACK_TABS,
  type SitePacksSearch,
  type SitePackTab,
} from './search.ts';
import { UpdatesSection } from './UpdatesSection.tsx';

const TAB_LABEL: { readonly [K in SitePackTab]: string } = {
  packs: 'Packs',
  history: 'History',
  hits: 'Guard hits',
};

const CHIP_LABEL: Readonly<Record<string, string>> = {
  local: 'Local',
  bundled: 'Bundled',
  '1': 'Updates available',
};

/** The Packs tab: filters, the table (cards under 768px), the Registry card. */
function PacksTab({ search }: { readonly search: SitePacksSearch }) {
  const { set, clear } = useSearchState<SitePacksSearch>();
  const list = useSitePacks(search);
  const columns = useMemo(() => packColumns(), []);
  const filtered = hasPackFilters(search);
  const onClear = () => clear(['tab']);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <FilterBar
        search={{ param: 'q', placeholder: 'Search packs or domains…', value: search.q }}
        chips={[
          {
            param: 'source',
            label: 'Source',
            options: [
              { value: 'local', count: 0 },
              { value: 'bundled', count: 0 },
            ],
            selected: search.source ?? [],
            format: (v) => CHIP_LABEL[v] ?? v,
            counts: false,
          },
          {
            param: 'pending',
            label: 'Updates',
            options: [{ value: '1', count: 0 }],
            selected: search.pending === 1 ? ['1'] : [],
            format: (v) => CHIP_LABEL[v] ?? v,
            counts: false,
          },
        ]}
        {...(filtered && list.data !== undefined && { matching: list.data.data.length })}
        onChange={(param, value) =>
          set({
            [param]:
              param === 'pending'
                ? Array.isArray(value) && value.length > 0
                  ? 1
                  : undefined
                : value,
          })
        }
        onClear={onClear}
      />
      <DataPanel query={list} skeleton={<SkeletonTable />} isEmpty={() => false} empty={null}>
        {(page) => (
          <div className="@container min-w-0">
            <DataTable<SitePackView>
              label="Site packs"
              columns={columns}
              rows={page.data}
              state={{ page: 1, pageSize: 100 }}
              getRowId={(row) => row.pack_id}
              onStateChange={() => undefined}
              rowHref={(row) => `/site-packs/${encodeURIComponent(row.pack_id)}`}
              rowLabel={(row) => row.title}
              emptyState={
                filtered ? (
                  <EmptyState
                    kind="zero-results"
                    title="No packs match"
                    description="Try another search or source, or clear the filters."
                    onClear={onClear}
                  />
                ) : (
                  <EmptyState
                    kind="zero-data"
                    icon="sitePacks"
                    title="No site packs yet"
                    description="This BrowserHive bundles none and the local folder is empty. Put a pack file in the folder below and press Reload local packs, or use Import…."
                  />
                )
              }
              renderCard={(row) => <PackCard pack={row} />}
            />
          </div>
        )}
      </DataPanel>
      {list.data !== undefined ? <RegistryCard status={list.data.status} /> : null}
    </div>
  );
}

/** `/site-packs`. */
export function SitePacksPage() {
  const { search, set } = useSearchState<SitePacksSearch>();
  const catalog = useSitePackCatalog();
  const reload = useReloadSitePacks();
  const toast = useToast();
  const [problem, setProblem] = useState<ImportProblem | null>(null);
  const status = catalog.data?.status;
  const off = status !== undefined && !status.enabled;
  useSitePacksLive(!off);
  const tab = search.tab;
  const onReload = () =>
    reload.mutate(undefined, {
      onSuccess: ({ stats }) => {
        const loaded = stats.sources.reduce((n, s) => n + s.loaded, 0);
        const skipped = stats.sources.reduce((n, s) => n + s.skipped.length, 0);
        toast.success({
          title: `Loaded ${loaded} ${loaded === 1 ? 'pack version' : 'pack versions'}`,
          ...(skipped > 0 && { description: `${skipped} skipped: see Where packs come from.` }),
        });
      },
    });
  const lastLoad = status?.last_load_at ?? null;
  return (
    <Stack gap={4}>
      <PageHeader
        title="Site packs"
        description="Per-site knowledge that keeps templates signed in and well-behaved."
        learnMore="A pack tells BrowserHive how a site signs in, how to tell the sign-in still holds, which requests sign out or change the account, and what the site’s terms say. Nothing in a pack applies until you approve it."
        learnMoreDocs="sitePacks"
        {...(lastLoad !== null &&
          !off && {
            meta: (
              <span className="text-sm text-muted-foreground">
                Loaded <RelativeTime at={lastLoad} className="text-sm" />
              </span>
            ),
          })}
        {...(!off && {
          actions: (
            <>
              <ImportButton onProblem={setProblem} />
              <Button type="button" disabled={reload.isPending} onClick={onReload}>
                {reload.isPending ? <Spinner /> : <ICONS.refresh aria-hidden="true" />}
                Reload local packs
              </Button>
            </>
          ),
        })}
      />
      {off ? (
        <EmptyState
          kind="not-enabled"
          variant="panel"
          icon="sitePacks"
          title="Site packs are turned off"
          description="The configuration sets sitePacks to false, so every template site is a generic site: BrowserHive learns its sign-in cookies and applies no guards or write policies. Set sitePacks to true and restart BrowserHive to use packs."
          docsHref={configKeyDocsUrl('sitePacks')}
          className="max-w-3xl"
        />
      ) : (
        <>
          {problem !== null ? (
            <ImportProblemCallout problem={problem} onDismiss={() => setProblem(null)} />
          ) : null}
          {catalog.data !== undefined ? <UpdatesSection packs={catalog.data.data} /> : null}
          <Tabs
            value={tab}
            onValueChange={(value) => set({ tab: value === 'packs' ? undefined : value })}
          >
            <TabsList variant="line" aria-label="Site pack sections" className="shrink-0">
              {SITE_PACK_TABS.map((t) => (
                <TabsTrigger key={t} value={t} className="flex-none">
                  {TAB_LABEL[t]}
                </TabsTrigger>
              ))}
            </TabsList>
            <TabsContent value={tab} className="pt-4">
              {tab === 'packs' ? (
                <PacksTab search={search} />
              ) : tab === 'history' ? (
                <HistoryTab />
              ) : (
                <GuardHitsTab />
              )}
            </TabsContent>
          </Tabs>
        </>
      )}
    </Stack>
  );
}

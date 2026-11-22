/** @module features/site-packs/SitePacksPage — `/site-packs` (spec 13 §11.4): header with the last check and its outcome, **Check now**, **Download all**, **Import…** (a pack file or a signed folder) and **Reload local packs**; an out-of-date index or a failing check on top; the outcome of an import; Updates available (pending registry, bundled and imported versions of followed packs, revoked versions kept in force, local files to approve); tabs Packs (Local, Online, Bundled, Imported and Updates available chips plus search in the URL, a whole-row linked table that becomes cards under 768px, the Registry card), History and Guard hits; empty and `sitePacks=false` states; live over the `site-packs` topic */
import type { SitePackView } from '@browserhive/contracts/http';
import { useCallback, useMemo, useState } from 'react';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import { DataPanel } from '@/components/shared/DataPanel.tsx';
import { DataTable } from '@/components/shared/DataTable.tsx';
import { EmptyState } from '@/components/shared/EmptyState.tsx';
import { FilterBar } from '@/components/shared/FilterBar.tsx';
import { Stack } from '@/components/shared/layout.tsx';
import { PageHeader } from '@/components/shared/PageHeader.tsx';
import { SkeletonTable } from '@/components/shared/Skeletons.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs.tsx';
import { printable } from '@/lib/format/printable.ts';
import { ICONS } from '@/lib/icons.ts';
import { configKeyDocsUrl } from '@/lib/links.ts';
import { useSearchState } from '@/lib/search/use-search-state.ts';
import { useReloadSitePacks, useSitePackCatalog, useSitePacks } from './api.ts';
import { DecisionFocusScope, focusElement } from './decision-focus.tsx';
import { GuardHitsTab } from './GuardHitsTab.tsx';
import { HistoryTab } from './HistoryTabs.tsx';
import {
  ImportMenu,
  type ImportOutcome,
  ImportOutcomeCallout,
  type ImportPicker,
  useImportPicker,
} from './ImportPack.tsx';
import { useSitePacksLive } from './live.ts';
import { PackCard, packColumns } from './pack-columns.tsx';
import { RegistryAlert, RegistryCard } from './RegistryCard.tsx';
import { CheckMeta, CheckNowButton, DownloadAllButton } from './RegistryControls.tsx';
import { unfollowedOnlineCount } from './registry-model.ts';
import {
  hasPackFilters,
  PACK_SOURCE_CHIP_LABEL,
  PACK_SOURCE_CHIPS,
  type PackSourceChip,
  SITE_PACK_TABS,
  type SitePacksSearch,
  type SitePackTab,
} from './search.ts';
import { pendingDecisions, UpdatesSection } from './UpdatesSection.tsx';

const TAB_LABEL: { readonly [K in SitePackTab]: string } = {
  packs: 'Packs',
  history: 'History',
  hits: 'Guard hits',
};

function isSourceChip(value: string): value is PackSourceChip {
  return (PACK_SOURCE_CHIPS as readonly string[]).includes(value);
}

function chipLabel(value: string): string {
  if (value === '1') return 'Updates available';
  return isSourceChip(value) ? PACK_SOURCE_CHIP_LABEL[value] : value;
}

/** **Reload local packs**, with the toast of what it loaded. */
function ReloadButton({ size = 'default' }: { readonly size?: 'default' | 'sm' }) {
  const reload = useReloadSitePacks();
  const toast = useToast();
  const onReload = () =>
    reload.mutate(undefined, {
      onSuccess: ({ stats }) => {
        const loaded = stats.sources.reduce((n, s) => n + s.loaded, 0);
        const skipped = stats.sources.reduce((n, s) => n + s.skipped.length, 0);
        toast.success({
          title: `Loaded ${loaded} ${loaded === 1 ? 'pack version' : 'pack versions'}`,
          ...(skipped > 0 && { description: `${skipped} skipped: see Registry and sources.` }),
        });
      },
    });
  return (
    <Button
      type="button"
      variant="outline"
      size={size}
      disabled={reload.isPending}
      onClick={onReload}
    >
      {reload.isPending ? <Spinner /> : <ICONS.folder aria-hidden="true" />}
      Reload local packs
    </Button>
  );
}

/** The Packs tab: filters, the table (cards under 768px), the Registry card. */
function PacksTab({
  search,
  picker,
  unfollowed,
}: {
  readonly search: SitePacksSearch;
  readonly picker: ImportPicker;
  /** Newer versions online that no followed pack shows (review #100 M1). */
  readonly unfollowed: number;
}) {
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
            options: PACK_SOURCE_CHIPS.map((value) => ({ value, count: 0 })),
            selected: search.source ?? [],
            format: chipLabel,
            counts: false,
          },
          {
            param: 'pending',
            label: 'Updates',
            options: [{ value: '1', count: 0 }],
            selected: search.pending === 1 ? ['1'] : [],
            format: chipLabel,
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
      {unfollowed > 0 ? (
        <p
          className="flex min-w-0 items-start gap-2 text-sm text-muted-foreground text-pretty"
          data-follow-note=""
        >
          <ICONS.info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>
            {unfollowed}{' '}
            {unfollowed === 1 ? 'pack lists a newer version' : 'packs list newer versions'} online.
            Packs follow updates while a template uses them; turn Follow on to review one now.
          </span>
        </p>
      ) : null}
      <DataPanel query={list} skeleton={<SkeletonTable />} isEmpty={() => false} empty={null}>
        {(page) => (
          <div className="@container min-w-0" data-site-packs-table="">
            <DataTable<SitePackView>
              label="Site packs"
              columns={columns}
              rows={page.data}
              state={{ page: 1, pageSize: 100 }}
              getRowId={(row) => row.pack_id}
              onStateChange={() => undefined}
              rowHref={(row) => `/site-packs/${encodeURIComponent(row.pack_id)}`}
              rowLabel={(row) => printable(row.title)}
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
                    description="This BrowserHive bundles none, the registry lists none yet and the local folder is empty. Press Check now, put a pack file in the local folder and press Reload local packs, or use Import…"
                  />
                )
              }
              renderCard={(row) => <PackCard pack={row} />}
            />
          </div>
        )}
      </DataPanel>
      {list.data !== undefined ? (
        <RegistryCard
          status={list.data.status}
          picker={picker}
          reload={<ReloadButton size="sm" />}
        />
      ) : null}
    </div>
  );
}

/** `/site-packs`. */
export function SitePacksPage() {
  const { search, set } = useSearchState<SitePacksSearch>();
  const catalog = useSitePackCatalog();
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
  const picker = useImportPicker(setOutcome);
  const status = catalog.data?.status;
  const off = status !== undefined && !status.enabled;
  useSitePacksLive(!off);
  const tab = search.tab;
  // When the last decision card leaves, focus moves to the Packs tab below it.
  // When no card is left to focus: the pack's row in the table, else the Packs tab (review #100 M5).
  const onEmpty = useCallback((packId: string) => {
    const links = Array.from(
      document.querySelectorAll<HTMLElement>('[data-site-packs-table] a[href]'),
    ).filter((a) => a.getAttribute('href') === `/site-packs/${encodeURIComponent(packId)}`);
    // The table's row is its tab stop (roving focus); a phone card is its own link. Only the
    // visible one takes focus.
    for (const link of links) if (focusElement(link.closest<HTMLElement>('tr') ?? link)) return;
    focusElement(document.querySelector<HTMLElement>('[data-site-packs-tabs] [role="tab"]'));
  }, []);
  const decisionKeys = pendingDecisions(catalog.data?.data ?? []).map((d) => d.key);
  const unfollowed = unfollowedOnlineCount(catalog.data?.data ?? []);
  return (
    <Stack gap={4}>
      <PageHeader
        title="Site packs"
        description="Per-site knowledge that keeps templates signed in and well-behaved."
        learnMore="A pack tells BrowserHive how a site signs in, how to tell the sign-in still holds, which requests sign out or change the account, and what the site’s terms say. Nothing in a pack applies until you approve it."
        learnMoreDocs="sitePacks"
        actionsBelowXl
        {...(status !== undefined &&
          !off && {
            meta: (
              <CheckMeta
                status={status}
                pendingCount={catalog.data?.pending_count ?? 0}
                onlineUnfollowed={unfollowed}
              />
            ),
          })}
        {...(status !== undefined &&
          !off && {
            actions: (
              <>
                <CheckNowButton status={status} />
                <DownloadAllButton status={status} />
                <ImportMenu picker={picker} />
                <ReloadButton />
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
          description="The configuration sets sitePacks to false, so every template site is a generic site: BrowserHive learns its sign-in cookies, applies no guards or write policies and makes no request to the pack registry. Set sitePacks to true and restart BrowserHive to use packs."
          docsHref={configKeyDocsUrl('sitePacks')}
          className="max-w-3xl"
        />
      ) : (
        <>
          {picker.inputs}
          {status !== undefined ? <RegistryAlert status={status} /> : null}
          {outcome !== null ? (
            <ImportOutcomeCallout outcome={outcome} onDismiss={() => setOutcome(null)} />
          ) : null}
          <DecisionFocusScope keys={decisionKeys} fallback={onEmpty}>
            {catalog.data !== undefined ? (
              <UpdatesSection packs={catalog.data.data} status={status} />
            ) : null}
            <Tabs
              value={tab}
              onValueChange={(value) => set({ tab: value === 'packs' ? undefined : value })}
            >
              <TabsList
                variant="line"
                aria-label="Site pack sections"
                className="shrink-0"
                data-site-packs-tabs=""
              >
                {SITE_PACK_TABS.map((t) => (
                  <TabsTrigger key={t} value={t} className="flex-none">
                    {TAB_LABEL[t]}
                  </TabsTrigger>
                ))}
              </TabsList>
              <TabsContent value={tab} className="pt-4">
                {tab === 'packs' ? (
                  <PacksTab
                    search={search}
                    picker={picker}
                    unfollowed={(catalog.data?.pending_count ?? 0) === 0 ? unfollowed : 0}
                  />
                ) : tab === 'history' ? (
                  <HistoryTab />
                ) : (
                  <GuardHitsTab />
                )}
              </TabsContent>
            </Tabs>
          </DecisionFocusScope>
        </>
      )}
    </Stack>
  );
}

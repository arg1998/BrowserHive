/** @module features/templates/detail/TemplatePage — `/templates/$id` (spec 13 §11.4): header with the browser's state and actions, banners, and six tabs in `?tab=` (Sites, Sessions, Versions, Access, Settings, Activity); live through the `templates` and `sessions` topics */
import type { TemplateDetailResponse } from '@browserhive/contracts/http';
import { useParams } from '@tanstack/react-router';
import { ErrorState } from '@/components/shared/ErrorState.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs.tsx';
import { toAppError } from '@/lib/api/errors.ts';
import { useSearchState } from '@/lib/search/use-search-state.ts';
import { useTemplateDetail } from '../api.ts';
import { useTemplatesLive } from '../live.ts';
import { TEMPLATE_TABS, type TemplatePageSearch, type TemplateTab } from '../search.ts';
import { AccessTab } from './AccessTab.tsx';
import { ActivityTab } from './ActivityTab.tsx';
import { SessionsTab } from './SessionsTab.tsx';
import { SettingsTab } from './SettingsTab.tsx';
import { SitesTab } from './SitesTab.tsx';
import { TemplateBanners } from './TemplateBanners.tsx';
import { TemplateHeader } from './TemplateHeader.tsx';
import { VersionsTab } from './VersionsTab.tsx';

/** Tab labels. */
export const TAB_LABEL: { readonly [T in TemplateTab]: string } = {
  sites: 'Sites',
  sessions: 'Sessions',
  versions: 'Versions',
  access: 'Access',
  settings: 'Settings',
  activity: 'Activity',
};

function isTab(value: unknown): value is TemplateTab {
  return typeof value === 'string' && (TEMPLATE_TABS as readonly string[]).includes(value);
}

/** Loading state at the page's final geometry. */
function TemplateSkeleton() {
  return (
    <div
      className="flex flex-col gap-5"
      role="status"
      aria-busy="true"
      aria-label="Loading template"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-7 w-56" />
          <Skeleton className="h-4 w-80 max-w-[70vw]" />
        </div>
        <Skeleton className="h-9 w-40" />
      </div>
      <Skeleton className="h-10 w-full max-w-xl" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-44 rounded-xl" />
        <Skeleton className="h-44 rounded-xl" />
      </div>
    </div>
  );
}

function TabBody({
  tab,
  detail,
  site,
}: {
  readonly tab: TemplateTab;
  readonly detail: TemplateDetailResponse;
  readonly site: string | undefined;
}) {
  switch (tab) {
    case 'sites':
      return <SitesTab detail={detail} focusSite={site} />;
    case 'sessions':
      return <SessionsTab detail={detail} />;
    case 'versions':
      return <VersionsTab detail={detail} />;
    case 'access':
      return <AccessTab detail={detail} />;
    case 'settings':
      return <SettingsTab detail={detail} />;
    case 'activity':
      return <ActivityTab />;
  }
}

/** One template. */
export function TemplatePage() {
  const params = useParams({ strict: false }) as { readonly id?: string };
  const id = params.id ?? '';
  const { search, set } = useSearchState<TemplatePageSearch>();
  const query = useTemplateDetail(id);
  useTemplatesLive();

  if (query.isPending) return <TemplateSkeleton />;
  if (query.isError) {
    const error = toAppError(query.error);
    return (
      <ErrorState
        tier="page"
        error={error}
        {...(error.status === 404 && { title: 'Template not found' })}
        onRetry={() => void query.refetch()}
        escape={{ label: 'Back to templates', to: '/templates' }}
      />
    );
  }
  const detail = query.data;
  const tab = search.tab ?? 'sites';
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <TemplateHeader detail={detail} />
      <TemplateBanners detail={detail} />
      <Tabs
        value={tab}
        onValueChange={(value: unknown) => {
          if (isTab(value)) set({ tab: value === 'sites' ? undefined : value, site: undefined });
        }}
        className="min-w-0 gap-4"
      >
        <TabsList variant="line" aria-label="Template sections" className="shrink-0">
          {TEMPLATE_TABS.map((t) => (
            <TabsTrigger key={t} value={t} className="flex-none">
              {TAB_LABEL[t]}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value={tab}>
          <TabBody tab={tab} detail={detail} site={search.site} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

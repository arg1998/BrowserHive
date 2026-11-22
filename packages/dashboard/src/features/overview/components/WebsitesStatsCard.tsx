/** @module features/overview/components/WebsitesStatsCard — the Overview "Websites" card, last on the page: navigations, distinct domains, top domain and non-public visits over the window, then the most visited domains in columns (→ `/websites?domain=`); "View all websites" opens `/websites` keeping the window (spec 04 §12.1) */
import type { PageDomainsResponse, PagesPage } from '@browserhive/contracts/http';
import type { UseQueryResult } from '@tanstack/react-query';
import { type ReactNode, useId } from 'react';
import { DataPanel } from '@/components/shared/DataPanel.tsx';
import { EmptyState } from '@/components/shared/EmptyState.tsx';
import { Panel } from '@/components/shared/Section.tsx';
import { TONE_CLASSES } from '@/components/shared/tones.ts';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { BarList } from '@/features/websites/components/BarList.tsx';
import { BarListSkeleton } from '@/features/websites/components/TopDomainsCard.tsx';
import { formatNumber, formatPercent } from '@/lib/format/bytes.ts';
import { URL_CATEGORY } from '@/lib/status-registry.ts';
import { cn } from '@/lib/utils.ts';
import { PanelLink } from './PanelLink.tsx';

/** Domains asked for: the API maximum, so the distinct count is exact up to it. */
export const DOMAINS_FETCHED = 100;
/** Domains drawn as bars (fills three columns of three from 1280px). */
export const DOMAINS_SHOWN = 9;

/** The card's figures, derived from the window's pages total/facets and its domain counts. */
export interface WebsitesSummary {
  readonly navigations: number;
  /** Distinct domains; `capped` when the server list was full (there may be more). */
  readonly domains: { readonly count: number; readonly capped: boolean };
  readonly top: { readonly domain: string; readonly share: number } | null;
  /** Visits that were not public web pages, per category (registry order, non-zero only). */
  readonly notPublic: {
    readonly count: number;
    readonly parts: readonly { readonly label: string; readonly count: number }[];
  };
}

/** Summary figures (pure, tested). */
export function websitesSummary(
  pages: Pick<PagesPage, 'page' | 'facets'>,
  domains: Pick<PageDomainsResponse, 'data'> | undefined,
  fetched = DOMAINS_FETCHED,
): WebsitesSummary {
  const navigations = pages.page.total ?? 0;
  const list = domains?.data ?? [];
  const first = list[0];
  // Read defensively: a response without facets must not crash the card.
  const facets = (pages.facets as PagesPage['facets'] | undefined)?.category ?? [];
  const parts = (Object.keys(URL_CATEGORY) as (keyof typeof URL_CATEGORY)[])
    .filter((category) => category !== 'public')
    .map((category) => ({
      label: URL_CATEGORY[category].label,
      count: facets.find((f) => f.value === category)?.count ?? 0,
    }))
    .filter((part) => part.count > 0);
  return {
    navigations,
    domains: { count: list.length, capped: list.length >= fetched },
    top:
      first !== undefined && navigations > 0
        ? { domain: first.domain, share: Math.min(1, first.count / navigations) }
        : null,
    notPublic: { count: parts.reduce((sum, part) => sum + part.count, 0), parts },
  };
}

/** `/websites` search keeping the Overview window (defaults left out). */
export type WebsitesLinkSearch = Readonly<Record<string, string | number>>;

/** Props. */
export interface WebsitesStatsCardProps {
  readonly summary: UseQueryResult<PagesPage, unknown>;
  readonly domains: UseQueryResult<PageDomainsResponse, unknown>;
  readonly rangeLabel: string;
  /** Search for "View all websites". */
  readonly search: WebsitesLinkSearch;
  /** Link of one domain bar. */
  readonly hrefFor: (domain: string) => string;
  readonly className?: string;
}

const STAT_GRID = 'grid grid-cols-2 gap-px bg-border lg:grid-cols-4';

function Stat({
  label,
  value,
  sub,
  className,
}: {
  readonly label: string;
  readonly value: ReactNode;
  readonly sub: ReactNode;
  readonly className?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 bg-card px-5 py-4">
      <dt className="section-label truncate">{label}</dt>
      <dd className={cn('min-w-0 truncate text-2xl font-semibold tabular-nums', className)}>
        {value}
      </dd>
      <dd className="min-w-0 truncate text-sm text-muted-foreground">{sub}</dd>
    </div>
  );
}

function StatsSkeleton() {
  return (
    <div className={STAT_GRID} aria-hidden="true">
      {['navigations', 'domains', 'top', 'not-public'].map((key) => (
        <div key={key} className="flex flex-col gap-2 bg-card px-5 py-4">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-7 w-16" />
          <Skeleton className="h-4 w-24" />
        </div>
      ))}
    </div>
  );
}

function Stats({
  data,
  domains,
  rangeLabel,
}: {
  readonly data: PagesPage;
  readonly domains: PageDomainsResponse | undefined;
  readonly rangeLabel: string;
}) {
  const s = websitesSummary(data, domains);
  return (
    <dl className={STAT_GRID}>
      <Stat
        label="Navigations"
        value={formatNumber(s.navigations)}
        sub={`Pages opened · ${rangeLabel}`}
      />
      <Stat
        label="Domains"
        value={
          domains === undefined ? (
            <Skeleton className="my-1 h-6 w-12" />
          ) : (
            `${formatNumber(s.domains.count)}${s.domains.capped ? '+' : ''}`
          )
        }
        sub="Distinct sites"
      />
      <Stat
        label="Top domain"
        value={
          s.top === null ? (
            <span className="text-muted-foreground">—</span>
          ) : (
            <span className="font-mono text-base leading-8 font-medium" title={s.top.domain}>
              {s.top.domain}
            </span>
          )
        }
        sub={s.top === null ? 'No navigations' : `${formatPercent(s.top.share)} of navigations`}
      />
      <Stat
        label="Not public"
        value={formatNumber(s.notPublic.count)}
        className={cn(s.notPublic.count > 0 && TONE_CLASSES.warn.text)}
        sub={
          s.notPublic.count > 0
            ? s.notPublic.parts.map((p) => `${p.label} ${formatNumber(p.count)}`).join(' · ')
            : 'IP, local and other hosts'
        }
      />
    </dl>
  );
}

function SubSection({
  title,
  meta,
  children,
}: {
  readonly title: string;
  readonly meta: ReactNode;
  readonly children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col">
      <div className="flex min-w-0 items-baseline justify-between gap-3 px-5 pt-4 pb-2">
        <h3 id={id} className="truncate text-sm font-semibold">
          {title}
        </h3>
        <span className="shrink-0 text-sm text-muted-foreground">{meta}</span>
      </div>
      {children}
    </section>
  );
}

/** Websites stats card. */
export function WebsitesStatsCard({
  summary,
  domains,
  rangeLabel,
  search,
  hrefFor,
  className,
}: WebsitesStatsCardProps) {
  return (
    <Panel
      title="Websites"
      description={`Where agents browsed, across all sessions · ${rangeLabel}`}
      padding="none"
      {...(className !== undefined && { className })}
      actions={
        <PanelLink to="/websites" search={search}>
          View all websites
        </PanelLink>
      }
    >
      {/* Skeletons from the first paint: a late one would move the card. */}
      <div className="border-y">
        {summary.isPending && summary.failureCount === 0 ? (
          <StatsSkeleton />
        ) : (
          <DataPanel
            query={summary}
            skeleton={<StatsSkeleton />}
            isEmpty={() => false}
            empty={null}
          >
            {(data) => <Stats data={data} domains={domains.data} rangeLabel={rangeLabel} />}
          </DataPanel>
        )}
      </div>
      <SubSection title="Most visited domains" meta={`Visits · ${rangeLabel}`}>
        <div className="px-2.5 pb-3">
          {domains.isPending && domains.failureCount === 0 ? (
            <BarListSkeleton rows={DOMAINS_SHOWN} columns />
          ) : (
            <DataPanel
              query={domains}
              skeleton={<BarListSkeleton rows={DOMAINS_SHOWN} columns />}
              empty={
                <EmptyState
                  kind="zero-data"
                  size="sm"
                  icon="globe"
                  title="No domains visited"
                  description={`Nothing recorded · ${rangeLabel}`}
                />
              }
            >
              {(data) => (
                <BarList
                  label="Domains by visits"
                  columns
                  items={data.data.slice(0, DOMAINS_SHOWN).map((d) => ({
                    key: d.domain,
                    label: <span className="font-mono text-sm">{d.domain}</span>,
                    value: d.count,
                    href: hrefFor(d.domain),
                    hint: `${formatNumber(d.count)} visit${d.count === 1 ? '' : 's'} · open in Websites`,
                  }))}
                />
              )}
            </DataPanel>
          )}
        </div>
      </SubSection>
    </Panel>
  );
}

/** @module features/overview/components/WebsitesCard — live "Websites visited": the most recent navigations (prepended from `page.visited`) as whole-row links to their session (spec 04 §12.1) */
import type { RecentPagesResponse } from '@browserhive/contracts/http';
import type { UseQueryResult } from '@tanstack/react-query';
import { DataPanel } from '@/components/shared/DataPanel.tsx';
import { EmptyState } from '@/components/shared/EmptyState.tsx';
import { RelativeTime } from '@/components/shared/RelativeTime.tsx';
import { Panel } from '@/components/shared/Section.tsx';
import { UrlCell } from '@/components/shared/url-cell.tsx';
import { sessionShort } from '@/lib/format/ids.ts';
import { LinkList, LinkRow } from './LinkList.tsx';
import { ListSkeleton } from './ListSkeleton.tsx';
import { PanelLink } from './PanelLink.tsx';

/** Rows shown (the live query keeps 15 so prepends never leave the panel short). */
export const WEBSITES_SHOWN = 10;

/** Props. */
export interface WebsitesCardProps {
  readonly query: UseQueryResult<RecentPagesResponse, unknown>;
  readonly className?: string;
}

/** Websites visited panel. */
export function WebsitesCard({ query, className }: WebsitesCardProps) {
  return (
    <Panel
      title="Websites visited"
      description={
        <span className="max-sm:hidden">Latest navigations across all sessions, live</span>
      }
      padding="none"
      {...(className !== undefined && { className })}
      bodyClassName="pb-2"
      actions={<PanelLink to="/websites">All websites</PanelLink>}
    >
      {/* Skeleton from the first paint: a late one would push the panels below it. */}
      {query.isPending && query.failureCount === 0 ? (
        <ListSkeleton rows={WEBSITES_SHOWN} />
      ) : (
        <DataPanel
          query={query}
          skeleton={<ListSkeleton rows={WEBSITES_SHOWN} />}
          empty={
            <EmptyState
              kind="zero-data"
              size="sm"
              icon="globe"
              title="No navigations yet"
              description="As agents browse, the pages they open appear here in real time."
            />
          }
        >
          {(data) => (
            <LinkList label="Recent navigations">
              {data.data.slice(0, WEBSITES_SHOWN).map((row) => {
                const slug = row.session_slug ?? sessionShort(row.session_id);
                return (
                  <LinkRow
                    key={row.event_id}
                    href={`/sessions/${encodeURIComponent(row.session_id)}`}
                    label={`Open session ${slug} (${row.url})`}
                  >
                    <div className="grid h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 px-5 sm:grid-cols-[minmax(0,1fr)_minmax(0,11rem)_4.5rem]">
                      <UrlCell
                        url={row.url}
                        category={row.category}
                        copy={false}
                        external={false}
                        className="min-w-0 overflow-hidden"
                      />
                      <span className="hidden min-w-0 truncate text-sm text-muted-foreground group-hover/row:text-foreground sm:block">
                        {slug}
                      </span>
                      <RelativeTime
                        at={row.ts}
                        className="justify-self-end text-sm whitespace-nowrap text-muted-foreground"
                      />
                    </div>
                  </LinkRow>
                );
              })}
            </LinkList>
          )}
        </DataPanel>
      )}
    </Panel>
  );
}

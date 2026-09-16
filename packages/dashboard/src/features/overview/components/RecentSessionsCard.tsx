/** @module features/overview/components/RecentSessionsCard — five most recent sessions as whole-row links: slug + state, calls/errors, last URL, created time (spec 04 §12.1) */
import type { SessionsPage } from '@browserhive/contracts/http';
import type { UseQueryResult } from '@tanstack/react-query';
import { countLabel } from '@/components/shared/Chip.tsx';
import { DataPanel } from '@/components/shared/DataPanel.tsx';
import { EmptyState } from '@/components/shared/EmptyState.tsx';
import { RelativeTime } from '@/components/shared/RelativeTime.tsx';
import { Panel } from '@/components/shared/Section.tsx';
import { StatusBadge } from '@/components/shared/StatusBadge.tsx';
import { UrlCell } from '@/components/shared/url-cell.tsx';
import { formatNumber } from '@/lib/format/bytes.ts';
import { sessionSlug } from '@/lib/format/ids.ts';
import { sessionDisplayState } from '@/lib/status-registry.ts';
import { LinkList, LinkRow } from './LinkList.tsx';
import { ListSkeleton } from './ListSkeleton.tsx';
import { PanelLink } from './PanelLink.tsx';

/** Props. */
export interface RecentSessionsCardProps {
  readonly query: UseQueryResult<SessionsPage, unknown>;
  readonly className?: string;
}

/** Recent sessions panel. */
export function RecentSessionsCard({ query, className }: RecentSessionsCardProps) {
  return (
    <Panel
      title="Recent sessions"
      description="Newest first, with their activity"
      padding="none"
      {...(className !== undefined && { className })}
      bodyClassName="pb-2"
      actions={<PanelLink to="/sessions">All sessions</PanelLink>}
    >
      {/* Skeleton from the first paint: a late one would push the panels below it. */}
      {query.isPending && query.failureCount === 0 ? (
        <ListSkeleton rows={5} twoLine />
      ) : (
        <DataPanel
          query={query}
          skeleton={<ListSkeleton rows={5} twoLine />}
          empty={
            <EmptyState
              kind="zero-data"
              size="sm"
              icon="sessions"
              title="No sessions yet"
              description="Sessions appear here as soon as an agent calls launch_session."
            />
          }
        >
          {(data) => (
            <LinkList label="Recent sessions">
              {data.data.map((session) => {
                const slug = session.slug ?? sessionSlug(session.session_id);
                const { tool_calls: calls, errors } = session.counts;
                return (
                  <LinkRow
                    key={session.session_id}
                    href={`/sessions/${encodeURIComponent(session.session_id)}`}
                    label={`Open session ${slug}`}
                  >
                    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-0.5 px-5 py-2.5">
                      <div className="flex min-w-0 items-center gap-3">
                        <span className="min-w-0 truncate font-medium decoration-muted-foreground/60 underline-offset-4 group-hover/row:underline">
                          {slug}
                        </span>
                        <StatusBadge
                          domain="session"
                          value={sessionDisplayState(session)}
                          className="shrink-0 text-sm"
                        />
                      </div>
                      <RelativeTime
                        at={session.created_at}
                        className="justify-self-end text-sm whitespace-nowrap text-muted-foreground"
                      />
                      <div className="col-span-2 flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
                        <span className="shrink-0 tabular-nums">
                          {formatNumber(calls)} {countLabel(calls, 'calls')}
                        </span>
                        {errors > 0 ? (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="shrink-0 text-danger-text tabular-nums">
                              {formatNumber(errors)} {countLabel(errors, 'errors')}
                            </span>
                          </>
                        ) : null}
                        {session.current_url !== null ? (
                          <>
                            <span aria-hidden="true">·</span>
                            <UrlCell
                              url={session.current_url}
                              copy={false}
                              external={false}
                              className="min-w-0"
                            />
                          </>
                        ) : null}
                      </div>
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

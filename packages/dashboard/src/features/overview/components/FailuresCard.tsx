/** @module features/overview/components/FailuresCard — "Recent failures": the latest failed tool calls in the window as whole-row links to the session's Activity filtered to errors (spec 04 §12.1) */
import type { ToolCallsPage } from '@browserhive/contracts/http';
import type { UseQueryResult } from '@tanstack/react-query';
import { DataPanel } from '@/components/shared/DataPanel.tsx';
import { EmptyState } from '@/components/shared/EmptyState.tsx';
import { RelativeTime } from '@/components/shared/RelativeTime.tsx';
import { Panel } from '@/components/shared/Section.tsx';
import { Hint } from '@/components/ui/tooltip.tsx';
import { sessionShort } from '@/lib/format/ids.ts';
import { cn } from '@/lib/utils.ts';
import { LinkList, LinkRow } from './LinkList.tsx';
import { ListSkeleton } from './ListSkeleton.tsx';
import { PanelLink } from './PanelLink.tsx';

/** Session Activity deep link showing only failed tool calls. */
export function failureHref(sessionId: string): string {
  return `/sessions/${encodeURIComponent(sessionId)}?kinds=tool&errors_only=1`;
}

/** Props. */
export interface FailuresCardProps {
  readonly query: UseQueryResult<ToolCallsPage, unknown>;
  readonly rangeLabel: string;
  readonly className?: string;
}

/** Recent failures panel. */
export function FailuresCard({ query, rangeLabel, className }: FailuresCardProps) {
  return (
    <Panel
      title="Recent failures"
      description={`Failed tool calls · ${rangeLabel}`}
      padding="none"
      {...(className !== undefined && { className })}
      bodyClassName="pb-2"
      actions={
        <PanelLink to="/sessions" search={{ sort: 'errors', dir: 'desc' }}>
          Sessions by errors
        </PanelLink>
      }
    >
      {/* Skeleton from the first paint: a late one would push the panels below it. */}
      {query.isPending && query.failureCount === 0 ? (
        <ListSkeleton rows={4} twoLine />
      ) : (
        <DataPanel
          query={query}
          skeleton={<ListSkeleton rows={4} twoLine />}
          empty={
            <EmptyState
              kind="zero-data"
              size="sm"
              icon="check"
              title="No failed tool calls"
              description={`Nothing failed · ${rangeLabel}. Failures appear here with their error.`}
            />
          }
        >
          {(data) => (
            <LinkList label="Recent failed tool calls">
              {data.data.map((row) => {
                const slug =
                  row.session_id === null
                    ? null
                    : (row.session_slug ?? sessionShort(row.session_id));
                return (
                  <LinkRow
                    key={row.event_id}
                    href={row.session_id === null ? undefined : failureHref(row.session_id)}
                    label={`Open failed ${row.tool} in ${slug ?? 'its session'}`}
                  >
                    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-0.5 px-5 py-2.5">
                      <div className="flex min-w-0 items-baseline gap-2">
                        <span
                          className={cn(
                            'shrink-0 font-mono text-sm font-medium',
                            row.session_id === null
                              ? 'text-muted-foreground'
                              : 'group-hover/row:underline group-hover/row:decoration-muted-foreground/60 group-hover/row:underline-offset-4',
                          )}
                        >
                          {row.tool}
                        </span>
                        {row.error_code !== null ? (
                          <span className="min-w-0 truncate font-mono text-sm text-danger-text">
                            {row.error_code}
                          </span>
                        ) : null}
                      </div>
                      <RelativeTime
                        at={row.ts}
                        className="justify-self-end text-sm whitespace-nowrap text-muted-foreground"
                      />
                      <div className="col-span-2 flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
                        {slug !== null ? (
                          <span className="shrink-0">{slug}</span>
                        ) : (
                          <Hint label="Rejected before a session was resolved, so there is nothing to open">
                            <span className="shrink-0 cursor-default text-subtle-foreground italic">
                              No session
                            </span>
                          </Hint>
                        )}
                        {row.error_message !== null && row.error_message !== '' ? (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="min-w-0 truncate">{row.error_message}</span>
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

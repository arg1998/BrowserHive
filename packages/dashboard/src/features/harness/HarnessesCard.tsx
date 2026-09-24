/** @module features/harness/HarnessesCard — Overview "Harnesses": sessions and tool calls per agent harness over the page window, whole-row links to the sessions list filtered to that harness; Unknown always listed, last and muted (spec 04 §12.1, D-30) */
import type { HarnessMetricsResponse } from '@browserhive/contracts/http';
import type { UseQueryResult } from '@tanstack/react-query';
import { DataPanel } from '@/components/shared/DataPanel.tsx';
import { EmptyState } from '@/components/shared/EmptyState.tsx';
import { Panel } from '@/components/shared/Section.tsx';
import { formatNumber } from '@/lib/format/bytes.ts';
import { harnessLabel, isUnknownHarness } from '@/lib/harness.ts';
import { cn } from '@/lib/utils.ts';
import { LinkList, LinkRow } from '../overview/components/LinkList.tsx';
import { ListSkeleton } from '../overview/components/ListSkeleton.tsx';
import { PanelLink } from '../overview/components/PanelLink.tsx';
import { HarnessName, selfReportedExplainer } from './HarnessName.tsx';

/** `/sessions` filtered to one harness, keeping the window's bounds. */
export function harnessSessionsHref(
  harness: string,
  window: { readonly since?: number | undefined; readonly until?: number | undefined },
): string {
  const params = new URLSearchParams({ harness });
  if (window.since !== undefined) params.set('since', String(window.since));
  if (window.until !== undefined) params.set('until', String(window.until));
  return `/sessions?${params.toString()}`;
}

function plural(n: number, one: string, many: string): string {
  return `${formatNumber(n)} ${n === 1 ? one : many}`;
}

/** Props. */
export interface HarnessesCardProps {
  readonly query: UseQueryResult<HarnessMetricsResponse, unknown>;
  readonly rangeLabel: string;
  readonly window: { readonly since?: number | undefined; readonly until?: number | undefined };
  readonly className?: string;
}

/** Harnesses panel. */
export function HarnessesCard({ query, rangeLabel, window, className }: HarnessesCardProps) {
  return (
    <Panel
      title="Harnesses"
      description={`Sessions and tool calls by agent · ${rangeLabel}`}
      info={selfReportedExplainer()}
      infoDocs="harnessIdentity"
      padding="none"
      {...(className !== undefined && { className })}
      bodyClassName="pb-2"
      actions={<PanelLink to="/sessions">All sessions</PanelLink>}
    >
      {query.isPending && query.failureCount === 0 ? (
        <ListSkeleton rows={3} twoLine />
      ) : (
        <DataPanel
          query={query}
          skeleton={<ListSkeleton rows={3} twoLine />}
          isEmpty={(data) => data.data.every((r) => r.sessions === 0 && r.tool_calls === 0)}
          empty={
            <EmptyState
              kind="zero-data"
              size="sm"
              icon="activity"
              title="No agent activity"
              description={`No sessions or tool calls · ${rangeLabel}. Each agent that connects is counted here.`}
            />
          }
        >
          {(data) => {
            const rows = data.data.filter(
              (r) => r.sessions > 0 || r.tool_calls > 0 || isUnknownHarness(r.harness),
            );
            const max = Math.max(1, ...rows.map((r) => r.sessions));
            return (
              <LinkList label="Harnesses">
                {rows.map((row) => {
                  const unknown = isUnknownHarness(row.harness);
                  const share = row.sessions > 0 ? Math.max(3, (row.sessions / max) * 100) : 0;
                  return (
                    <LinkRow
                      key={row.harness}
                      href={harnessSessionsHref(row.harness, window)}
                      label={`Sessions launched by ${harnessLabel(row.harness)}`}
                    >
                      <div className="grid min-h-15 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-5 px-5 py-2.5 sm:grid-cols-[minmax(0,1fr)_10rem]">
                        <div className="flex min-w-0 flex-col gap-2">
                          <HarnessName
                            harness={row.harness}
                            className={cn(
                              'self-start text-base leading-5',
                              !unknown &&
                                'font-medium decoration-muted-foreground/60 underline-offset-4 group-hover/row:underline',
                            )}
                          />
                          <span
                            aria-hidden="true"
                            className="h-[3px] w-full overflow-hidden rounded-full bg-muted dark:bg-white/[0.06]"
                          >
                            <span
                              className={cn(
                                'block h-full rounded-full transition-[background-color] duration-(--duration-fast)',
                                unknown
                                  ? 'bg-muted-foreground/40'
                                  : 'bg-chart-1/70 group-hover/row:bg-chart-1',
                              )}
                              style={{ width: `${share}%` }}
                            />
                          </span>
                        </div>
                        <div className="flex flex-col items-end text-sm leading-5 whitespace-nowrap tabular-nums">
                          <span
                            className={cn(unknown ? 'text-muted-foreground' : 'text-foreground')}
                          >
                            {plural(row.sessions, 'session', 'sessions')}
                            {row.sessions_live > 0 ? (
                              <span className="text-success-text">
                                {' '}
                                · {formatNumber(row.sessions_live)} live
                              </span>
                            ) : null}
                          </span>
                          <span className="text-muted-foreground">
                            {plural(row.tool_calls, 'call', 'calls')}
                            {row.errors > 0 ? (
                              <span className="text-danger-text">
                                {' '}
                                · {plural(row.errors, 'error', 'errors')}
                              </span>
                            ) : null}
                          </span>
                        </div>
                      </div>
                    </LinkRow>
                  );
                })}
              </LinkList>
            );
          }}
        </DataPanel>
      )}
    </Panel>
  );
}

/** @module features/harness/McpConnectionsPanel — System "MCP connections" (spec 04 §12.10, D-30): live connections first, then recent ones, 10 per page by default; each row is a whole-row button opening a detail popover (harness and how it was recognised, model, workspace, client, protocol, User-Agent, IP, times, conflicting signals, meta) */
import type { McpConnectionRow, McpConnectionsResponse } from '@browserhive/contracts/http';
import type { UseQueryResult } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Chip } from '@/components/shared/Chip.tsx';
import { DataPanel } from '@/components/shared/DataPanel.tsx';
import { EmptyState } from '@/components/shared/EmptyState.tsx';
import { KeyValue, type KeyValueItem } from '@/components/shared/KeyValue.tsx';
import { Pagination } from '@/components/shared/Pagination.tsx';
import { RelativeTime } from '@/components/shared/RelativeTime.tsx';
import { Panel } from '@/components/shared/Section.tsx';
import { SkeletonKv } from '@/components/shared/Skeletons.tsx';
import { TONE_CLASSES } from '@/components/shared/tones.ts';
import { buttonVariants } from '@/components/ui/button.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx';
import { formatNumber } from '@/lib/format/bytes.ts';
import { declaredSourcePhrase, harnessSourcePhrase } from '@/lib/harness.ts';
import { ICONS } from '@/lib/icons.ts';
import { docsUrl } from '@/lib/links.ts';
import { cn } from '@/lib/utils.ts';
import { HarnessValue, metaItems } from './ClientPanel.tsx';
import { HarnessName, selfReportedExplainer } from './HarnessName.tsx';

function Muted({ children }: { readonly children: string }) {
  return <span className="text-muted-foreground">{children}</span>;
}

/** `claude-code 2.1.281`, or `null` when the client sent no name. */
function clientText(row: McpConnectionRow): string | null {
  const parts = [row.client_name, row.client_version].filter((v): v is string => v !== null);
  if (parts.length === 0) return null;
  const title =
    row.client_title !== null && row.client_title !== row.client_name
      ? ` (${row.client_title})`
      : '';
  return `${parts.join(' ')}${title}`;
}

/** Phrase for one conflicting signal: "clientInfo said cursor-vscode". */
export function conflictText(conflict: McpConnectionRow['conflicts'][number]): string {
  const where =
    conflict.source === 'client_info'
      ? 'clientInfo'
      : conflict.source === 'user_agent'
        ? 'User-Agent'
        : harnessSourcePhrase(conflict.source);
  return `${where} said ${conflict.value}`;
}

function detailItems(row: McpConnectionRow): KeyValueItem[] {
  const modelSource = declaredSourcePhrase(row.model_source);
  const client = clientText(row);
  const items: KeyValueItem[] = [
    { key: 'Harness', value: <HarnessValue harness={row.harness} source={row.harness_source} /> },
    {
      key: 'Model',
      value:
        row.model === null ? (
          <Muted>not reported</Muted>
        ) : (
          <span className="inline-flex flex-wrap items-baseline gap-x-2">
            <span>{row.model}</span>
            {modelSource !== null ? <Muted>{modelSource}</Muted> : null}
          </span>
        ),
    },
    { key: 'Workspace', value: row.workspace ?? <Muted>—</Muted> },
    { key: 'Client', value: client ?? <Muted>not reported</Muted> },
    { key: 'Transport', value: row.transport },
  ];
  if (row.protocol_version !== null) items.push({ key: 'Protocol', value: row.protocol_version });
  if (row.user_agent !== null) items.push({ key: 'User-Agent', value: row.user_agent, mono: true });
  if (row.ip !== null) items.push({ key: 'IP', value: row.ip, mono: true });
  items.push(
    { key: 'Connected', value: <RelativeTime at={row.connected_at} mode="both" /> },
    {
      key: row.live ? 'Last seen' : 'Closed',
      value: <RelativeTime at={row.closed_at ?? row.last_seen_at} mode="both" />,
    },
    { key: 'Sessions', value: formatNumber(row.sessions) },
  );
  return items;
}

function ConnectionDetail({ row }: { readonly row: McpConnectionRow }) {
  const meta = metaItems(row.meta);
  return (
    <div className="flex flex-col gap-4">
      <KeyValue items={detailItems(row)} />
      {row.conflicts.length > 0 ? (
        <section aria-label="Conflicting signals" className="flex flex-col gap-1.5 border-t pt-3">
          <h3 className="section-label">Conflicting signals</h3>
          <ul className="flex flex-col gap-1 text-sm">
            {row.conflicts.map((c) => (
              <li key={`${c.source}:${c.value}`} className="[overflow-wrap:anywhere]">
                <span className="text-muted-foreground">{conflictText(c)}</span>{' '}
                <span className="whitespace-nowrap">→ {c.harness}</span>
              </li>
            ))}
          </ul>
          <p className="text-sm text-muted-foreground">
            The highest-ranked signal wins; the rest are kept here.
          </p>
        </section>
      ) : null}
      {meta.length > 0 ? (
        <section aria-label="Meta" className="flex flex-col gap-2 border-t pt-3">
          <h3 className="section-label">Meta</h3>
          <KeyValue items={meta} />
        </section>
      ) : null}
      <p className="font-mono text-xs text-subtle-foreground [overflow-wrap:anywhere]">
        {row.connection_id}
      </p>
    </div>
  );
}

function ConnectionRow({ row }: { readonly row: McpConnectionRow }) {
  const Chevron = ICONS.chevronRight;
  const client = clientText(row);
  const declared = [row.model, row.workspace].filter((v): v is string => v !== null);
  return (
    <li className="border-b last:border-b-0">
      <Popover>
        <PopoverTrigger
          render={
            <button
              type="button"
              className="group/conn grid min-h-17 w-full min-w-0 cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 px-5 py-3 text-left transition-colors duration-(--duration-fast) hover:bg-accent/70 focus-ring-inset data-popup-open:bg-accent/70 dark:hover:bg-white/[0.035] dark:data-popup-open:bg-white/[0.035]"
              aria-label={`Connection details: ${row.harness_label}, ${row.live ? 'live' : 'closed'}`}
            />
          }
        >
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="flex min-w-0 items-center gap-2">
              <span
                aria-hidden="true"
                className={cn(
                  'size-2 shrink-0 rounded-full',
                  row.live ? TONE_CLASSES.success.dot : 'bg-muted-foreground/40',
                )}
              />
              <HarnessName harness={row.harness} className="text-base leading-5 font-medium" />
              {row.conflicts.length > 0 ? (
                <Chip tone="warn" className="shrink-0">
                  conflicting signals
                </Chip>
              ) : null}
            </span>
            <span className="truncate pl-4 text-sm leading-5 text-muted-foreground">
              {[row.transport, client, ...declared].filter((v) => v !== null).join(' · ')}
            </span>
          </span>
          <span className="flex items-center gap-3">
            <span className="flex flex-col items-end text-sm leading-5 whitespace-nowrap tabular-nums">
              <span className={row.live ? 'text-success-text' : 'text-muted-foreground'}>
                {row.live ? 'live' : 'closed'}
              </span>
              <span className="text-muted-foreground">
                {row.sessions > 0
                  ? `${formatNumber(row.sessions)} session${row.sessions === 1 ? '' : 's'}`
                  : null}
                {row.sessions > 0 ? ' · ' : null}
                <RelativeTime at={row.closed_at ?? row.last_seen_at} />
              </span>
            </span>
            <Chevron
              aria-hidden="true"
              className="size-4 shrink-0 text-subtle-foreground transition-transform duration-(--duration-fast) group-hover/conn:translate-x-0.5"
            />
          </span>
        </PopoverTrigger>
        <PopoverContent
          side="bottom"
          align="end"
          className="w-[28rem] max-w-[calc(100vw-2rem)] overflow-y-auto"
        >
          <ConnectionDetail row={row} />
        </PopoverContent>
      </Popover>
    </li>
  );
}

/** Rows-per-page choices for the connections list; the first is the default. */
export const MCP_CONNECTION_PAGE_SIZES = [10, 25, 50] as const;
/** One of {@link MCP_CONNECTION_PAGE_SIZES}. */
export type McpConnectionPageSize = (typeof MCP_CONNECTION_PAGE_SIZES)[number];
/** Default rows per page. */
export const MCP_CONNECTION_PAGE_SIZE_DEFAULT: McpConnectionPageSize = 10;

/** Page state, owned by the caller so the query can fetch just that page. */
export interface McpConnectionsPaging {
  readonly page: number;
  readonly pageSize: McpConnectionPageSize;
  readonly onPage: (page: number) => void;
  readonly onPageSize: (size: McpConnectionPageSize) => void;
}

/** Props. */
export interface McpConnectionsPanelProps {
  readonly query: UseQueryResult<McpConnectionsResponse, unknown>;
  /** Server paging; without it the panel shows whatever rows the query returned. */
  readonly paging?: McpConnectionsPaging;
  readonly className?: string;
}

/** The panel. */
export function McpConnectionsPanel({ query, paging, className }: McpConnectionsPanelProps) {
  const live = query.data?.live;
  const total = query.data?.total;
  const shown = query.data?.connections.length;
  // Rows were pruned or closed under us and this page is now past the end: go to the last page.
  useEffect(() => {
    if (paging === undefined || total === undefined || shown !== 0 || total === 0) return;
    if (paging.page > 1) paging.onPage(Math.max(1, Math.ceil(total / paging.pageSize)));
  }, [paging, total, shown]);
  return (
    <Panel
      title="MCP connections"
      description={
        live === undefined
          ? 'Agents connected over MCP, live first'
          : `${formatNumber(live)} live · most recent first`
      }
      info={selfReportedExplainer()}
      infoDocs="harnessIdentity"
      padding="none"
      {...(className !== undefined && { className })}
    >
      <DataPanel
        query={query}
        skeleton={<SkeletonKv count={3} />}
        isEmpty={(d) => d.total === 0 || (paging === undefined && d.connections.length === 0)}
        empty={
          <EmptyState
            kind="zero-data"
            icon="link"
            size="sm"
            title="No MCP client has connected yet"
            description="Connect an agent over HTTP or stdio; it shows up here with how it was recognised."
            action={
              <a
                href={docsUrl('mcpClients')}
                target="_blank"
                rel="noreferrer"
                className={buttonVariants({ variant: 'outline', size: 'sm' })}
              >
                Connect an MCP client
              </a>
            }
          />
        }
      >
        {(data) => (
          <>
            <ul aria-label="MCP connections" className="flex flex-col border-t">
              {data.connections.map((row) => (
                <ConnectionRow key={row.connection_id} row={row} />
              ))}
            </ul>
            {paging !== undefined ? (
              <Pagination
                page={paging.page}
                pageSize={paging.pageSize}
                sizes={MCP_CONNECTION_PAGE_SIZES}
                total={data.total}
                onPage={paging.onPage}
                onPageSize={paging.onPageSize}
                className="border-t px-5 py-3"
              />
            ) : null}
          </>
        )}
      </DataPanel>
    </Panel>
  );
}

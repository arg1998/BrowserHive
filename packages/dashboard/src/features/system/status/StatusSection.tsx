/** @module features/system/status/StatusSection — System › Status: notices shown once, live KPI tiles, health (including the degraded 503 body), runtime with fix hints, degradations, storage and retention, realtime connections, migrations */

import type {
  HealthResponse,
  McpConnectionsResponse,
  MigrationRow,
  RealtimeConnection,
  SystemEvent,
  SystemInfo,
} from '@browserhive/contracts/http';
import type { UseQueryResult } from '@tanstack/react-query';
import { BarMeter } from '@/components/shared/bar-meter.tsx';
import { Callout } from '@/components/shared/Callout.tsx';
import { DataPanel } from '@/components/shared/DataPanel.tsx';
import { EmptyState } from '@/components/shared/EmptyState.tsx';
import { KeyValue } from '@/components/shared/KeyValue.tsx';
import { RelativeTime } from '@/components/shared/RelativeTime.tsx';
import { Panel } from '@/components/shared/Section.tsx';
import { SkeletonKv } from '@/components/shared/Skeletons.tsx';
import { StatTile } from '@/components/shared/StatTile.tsx';
import { StatusDot, TonePill } from '@/components/shared/StatusBadge.tsx';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table.tsx';
import { formatBytes, formatNumber, formatPercent } from '@/lib/format/bytes.ts';
import { formatAbsoluteShort, formatDuration, formatMs } from '@/lib/format/time.ts';
import { ICONS } from '@/lib/icons.ts';
import { configKeyDocsUrl } from '@/lib/links.ts';
import { useServerNow } from '@/lib/server-now.ts';
import { diskTone, type Tone } from '@/lib/status-registry.ts';
import {
  type McpConnectionsPaging,
  McpConnectionsPanel,
} from '../../harness/McpConnectionsPanel.tsx';
import { SettingsList } from '../components/SettingsList.tsx';
import {
  browserRows,
  checkTone,
  dbRatio,
  healthTone,
  kpis,
  runtimeRows,
  systemNotices,
} from '../model.ts';

const SEVERITY_TONE: { readonly [K in SystemEvent['severity']]: Tone } = {
  info: 'info',
  warn: 'warn',
  error: 'danger',
};

function Kpis({ system }: { readonly system: SystemInfo }) {
  const now = useServerNow(30_000);
  const k = kpis(system);
  const uptime = Math.max(system.uptime_ms, now - system.started_at);
  return (
    // 2 columns on phones with Uptime spanning the first row, 3 on tablets with Database spanning
    // the second, 5 on wide screens: no orphan tile at any width.
    <section
      aria-label="System status"
      className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5"
    >
      <StatTile
        label="Uptime"
        value={formatDuration(uptime)}
        sub={`v${system.version} · since ${formatAbsoluteShort(system.started_at)}`}
        className="col-span-2 md:col-span-1"
      />
      <StatTile
        label="Live sessions"
        value={k.sessions.value}
        sub={k.sessions.sub}
        to="/sessions"
      />
      <StatTile
        label="Open attention"
        value={k.attention.value}
        sub={system.open_attention > 0 ? 'waiting for an operator' : 'nothing waiting'}
        to="/attention"
        {...(k.attention.tone !== undefined && { tone: k.attention.tone })}
      />
      <StatTile
        label="MCP clients"
        value={k.connections.value}
        sub={
          <>
            {k.connections.dashboards}
            <span className="hidden sm:inline"> · {k.connections.liveViews}</span>
          </>
        }
      />
      <StatTile
        label="Database"
        value={k.database.value}
        sub={k.database.sub}
        className="md:col-span-2 xl:col-span-1"
        {...(k.database.tone !== undefined && { tone: k.database.tone })}
      />
    </section>
  );
}

/** Health checks and runtime versions share one card: two halves of one question, "is the daemon able
 * to work", with no mismatched panel heights beside each other. */
function HealthRuntimePanel({
  system,
  health,
  query,
}: {
  readonly system: SystemInfo;
  readonly health: HealthResponse | undefined;
  readonly query: UseQueryResult<unknown, unknown>;
}) {
  const status = health !== undefined ? healthTone(health.status) : null;
  return (
    <section
      aria-label="Health and runtime"
      className="grid min-w-0 grid-cols-1 rounded-xl border bg-card text-card-foreground shadow-xs lg:grid-cols-2 dark:shadow-none"
    >
      <div className="flex min-w-0 flex-col gap-3 p-5">
        <div className="flex min-h-10 items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col">
            <h2 className="text-base font-semibold">Health</h2>
            <p className="text-sm text-muted-foreground">
              Readiness checks the daemon reports on /health.
            </p>
          </div>
          {status !== null ? <TonePill entry={{ label: status.label, tone: status.tone }} /> : null}
        </div>
        {health !== undefined ? (
          <KeyValue
            dividers
            items={[
              { key: 'Phase', value: health.phase },
              { key: 'Database', value: <StatusDot entry={checkTone(health.checks.db)} /> },
              { key: 'Browser', value: <StatusDot entry={checkTone(health.checks.browser)} /> },
              {
                key: 'Listeners',
                value: <StatusDot entry={checkTone(health.checks.listeners)} />,
              },
            ]}
          />
        ) : query.isError ? (
          <p className="text-sm text-muted-foreground">
            The health endpoint did not answer. Status data above may be stale.
          </p>
        ) : (
          <SkeletonKv count={4} />
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-3 border-t p-5 lg:border-t-0 lg:border-l">
        <div className="flex min-h-10 min-w-0 flex-col">
          <h2 className="text-base font-semibold">Runtime</h2>
          <p className="text-sm text-muted-foreground">Engines this daemon runs on.</p>
        </div>
        <SettingsList rows={runtimeRows(system, health)} label="Runtime versions" short />
      </div>
    </section>
  );
}

const SANDBOX_MODE_NOTE: Readonly<Record<string, string>> = {
  auto: 'sandbox auto: on wherever the browser can run with it',
  on: 'sandbox on: required',
  off: 'sandbox off',
};

/** The browsers this daemon found and whether each runs with Chromium's sandbox. */
function BrowsersPanel({ system }: { readonly system: SystemInfo }) {
  const rows = browserRows(system);
  const browser = system.browser;
  if (rows === null || browser === undefined) return null;
  const root = browser.running_as_root ? ' · running as root' : '';
  return (
    <Panel
      title="Browsers and sandbox"
      info={
        <>
          <p>
            The browsers on this machine that sessions can use, and whether each runs inside
            Chromium's sandbox. The sandbox keeps a compromised page from reaching the rest of the
            machine.
          </p>
          <p>
            With <code>sandbox=auto</code> each browser is checked on its first launch and falls
            back to no sandbox where the machine does not allow it. <code>browserhive doctor</code>{' '}
            explains why and how to fix it.
          </p>
        </>
      }
      infoDocs="security"
      description={`Default ${browser.default_channel} · ${SANDBOX_MODE_NOTE[browser.sandbox_mode] ?? browser.sandbox_mode}${root}`}
      padding="none"
    >
      <ul aria-label="Browsers" className="flex flex-col border-t">
        {rows.map((r) => (
          <li
            key={r.channel}
            className="flex flex-col gap-1 border-b px-5 py-3 last:border-b-0 sm:flex-row sm:items-start sm:gap-4"
          >
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-medium">{r.label}</span>
                <span className="font-mono text-sm text-muted-foreground">{r.channel}</span>
                {r.isDefault ? (
                  <TonePill entry={{ label: 'default', tone: 'accent' }} iconless />
                ) : null}
                {r.installed ? (
                  <span className="text-sm text-muted-foreground">
                    {r.source === 'bundled' ? 'bundled' : 'installed'}
                    {r.version !== null ? (
                      <>
                        {' · '}
                        <span className="font-mono tabular-nums">{r.version}</span>
                      </>
                    ) : null}
                  </span>
                ) : (
                  <span className="text-sm text-muted-foreground">not installed</span>
                )}
              </div>
              {r.path !== null ? (
                <span className="font-mono text-sm text-subtle-foreground [overflow-wrap:anywhere]">
                  {r.path}
                </span>
              ) : null}
              {r.reason !== null ? (
                <span className="text-sm text-warn-text [overflow-wrap:anywhere]">{r.reason}</span>
              ) : null}
            </div>
            {r.sandbox !== null ? (
              <span className="shrink-0">
                <StatusDot entry={r.sandbox} className="text-sm" />
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function DegradationsPanel({ events }: { readonly events: readonly SystemEvent[] }) {
  const open = events.filter((e) => e.resolved_at === null).length;
  return (
    <Panel
      title="Degradations"
      info={
        <>
          Problems the daemon detected and worked around, such as a browser that failed to launch or
          low disk space. Recurring problems are grouped by code.
        </>
      }
      infoDocs="troubleshooting"
      description={
        open > 0
          ? `${formatNumber(open)} open. Recurring problems are grouped by code.`
          : 'Problems the daemon detected and recovered from.'
      }
      padding="none"
      actions={open > 0 ? <TonePill entry={{ label: `${open} open`, tone: 'warn' }} /> : null}
    >
      {events.length === 0 ? (
        <p className="flex items-center gap-2 border-t px-5 py-3.5 text-base text-muted-foreground">
          <ICONS.success aria-hidden="true" className="size-4 text-success-text" />
          No degradations recorded
        </p>
      ) : (
        <ul aria-label="Degradations" className="flex flex-col border-t">
          {events.map((e) => (
            <li
              key={e.event_id}
              className="flex flex-col gap-1 border-b px-5 py-3 last:border-b-0 sm:flex-row sm:items-start sm:gap-4"
            >
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <StatusDot
                    entry={{
                      label: e.resolved_at === null ? e.severity : 'resolved',
                      tone: e.resolved_at === null ? SEVERITY_TONE[e.severity] : 'success',
                    }}
                    className="text-sm"
                  />
                  <span className="font-mono text-sm [overflow-wrap:anywhere]">{e.code}</span>
                  {e.count > 1 ? (
                    <span className="text-sm text-muted-foreground tabular-nums">
                      ×{formatNumber(e.count)}
                    </span>
                  ) : null}
                </div>
                <p className="text-base [overflow-wrap:anywhere]">{e.message}</p>
              </div>
              <span className="shrink-0 text-sm text-muted-foreground">
                last seen <RelativeTime at={e.last_seen_at} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function StoragePanel({ system }: { readonly system: SystemInfo }) {
  const { retention, storage } = system;
  const capped = retention.bytes > 0;
  const ratio = dbRatio(system);
  const never = <span className="text-muted-foreground">Never</span>;
  return (
    <Panel
      title="Storage and retention"
      info={
        <>
          Events older than the retention window are pruned, oldest first, and so is anything past
          the byte cap. Traces, screenshots and profiles of deleted sessions go with them.
        </>
      }
      infoDocs={{ href: configKeyDocsUrl('retentionDays'), label: 'Retention settings' }}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
            <span className="font-medium tabular-nums">
              {formatBytes(storage.db_bytes)}
              <span className="font-normal text-muted-foreground">
                {' '}
                of {capped ? formatBytes(retention.bytes) : 'no cap'}
              </span>
            </span>
            {capped ? (
              <span className="text-muted-foreground tabular-nums">{formatPercent(ratio)}</span>
            ) : null}
          </div>
          <BarMeter
            value={capped ? storage.db_bytes : 0}
            max={capped ? retention.bytes : 1}
            tone={diskTone(ratio)}
            size="md"
            floor={1}
            label="Database size against its cap"
          />
          <p className="text-sm text-pretty text-muted-foreground">
            {capped
              ? `When full, the oldest events are pruned first; anything older than ${formatNumber(retention.days)} days is always pruned.`
              : `Events older than ${formatNumber(retention.days)} days are pruned.`}
          </p>
        </div>
        <KeyValue
          dividers
          items={[
            {
              key: 'Last sweep',
              value:
                retention.last_run_at === null ? (
                  never
                ) : (
                  <span>
                    <RelativeTime at={retention.last_run_at} />
                    {retention.last_result !== null && retention.last_result !== 'ok' ? (
                      <span className="text-warn-text"> · {retention.last_result}</span>
                    ) : null}
                  </span>
                ),
            },
            {
              key: 'Next sweep',
              value:
                retention.next_run_at === null ? '—' : <RelativeTime at={retention.next_run_at} />,
            },
            { key: 'Rows pruned', value: formatNumber(retention.pruned_rows) },
            { key: 'Artifacts pending', value: formatNumber(retention.artifacts_pending) },
            { key: 'Write queue', value: formatNumber(storage.write_queue_depth) },
            {
              key: 'Dropped writes',
              value:
                storage.dropped_writes_total > 0 ? (
                  <span className="font-medium text-warn-text">
                    {formatNumber(storage.dropped_writes_total)}
                  </span>
                ) : (
                  '0'
                ),
            },
            {
              key: 'Backups',
              value:
                storage.last_backup_at === null ? (
                  <span className="text-muted-foreground">None taken yet</span>
                ) : (
                  <span>
                    {formatNumber(storage.backups_count)} · last{' '}
                    <RelativeTime at={storage.last_backup_at} />
                  </span>
                ),
            },
          ]}
        />
      </div>
    </Panel>
  );
}

function ConnectionsPanel({
  query,
}: {
  readonly query: UseQueryResult<{ readonly connections: readonly RealtimeConnection[] }, unknown>;
}) {
  return (
    <Panel
      title="Dashboard connections"
      description="Browsers connected to this dashboard's realtime socket."
      padding="none"
    >
      <DataPanel
        query={query}
        skeleton={<SkeletonKv count={2} />}
        isEmpty={(d) => d.connections.length === 0}
        empty={
          <EmptyState kind="zero-data" icon="online" title="No dashboard connections" size="sm" />
        }
      >
        {(data) => (
          <ul aria-label="Connections" className="flex flex-col border-t">
            {data.connections.map((c) => (
              <li
                key={c.connection_id}
                className="flex flex-col gap-0.5 border-b px-5 py-3 last:border-b-0"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="font-medium">{c.principal}</span>
                  <span className="text-sm text-muted-foreground">
                    connected <RelativeTime at={c.connected_at} />
                  </span>
                </div>
                <span className="text-sm text-muted-foreground tabular-nums">
                  {formatNumber(c.topics.length)} topics · {formatNumber(c.screencasts.length)} live
                  views · {formatNumber(c.messages_out)} messages · {formatBytes(c.buffered_bytes)}{' '}
                  buffered
                  {c.dropped_frames > 0 ? (
                    <span className="text-warn-text">
                      {' '}
                      · {formatNumber(c.dropped_frames)} dropped frames
                    </span>
                  ) : null}
                </span>
                <span className="font-mono text-sm text-subtle-foreground [overflow-wrap:anywhere]">
                  {c.connection_id}
                </span>
              </li>
            ))}
          </ul>
        )}
      </DataPanel>
    </Panel>
  );
}

function MigrationsPanel({
  migrations,
  schema,
  minReader,
}: {
  readonly migrations: readonly MigrationRow[];
  readonly schema: number;
  readonly minReader: number;
}) {
  return (
    <Panel
      title="Schema migrations"
      info={
        <>
          The database schema this daemon runs and the oldest BrowserHive version that can still
          read it. Upgrades back up the database before migrating.
        </>
      }
      infoDocs="upgrading"
      description={`Schema v${schema} · readable by v${minReader} and later`}
      padding="none"
    >
      <section aria-label="Applied migrations">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="border-t">Version</TableHead>
              <TableHead className="border-t">Name</TableHead>
              <TableHead className="hidden border-t sm:table-cell">Applied</TableHead>
              <TableHead className="hidden border-t text-right md:table-cell">Duration</TableHead>
              <TableHead className="border-t text-right">App version</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {migrations.map((m) => (
              <TableRow key={m.version}>
                <TableCell className="tabular-nums">v{m.version}</TableCell>
                <TableCell className="font-mono text-sm">{m.name}</TableCell>
                <TableCell className="hidden sm:table-cell">
                  {formatAbsoluteShort(m.applied_at)}
                </TableCell>
                <TableCell className="hidden text-right tabular-nums md:table-cell">
                  {formatMs(m.duration_ms)}
                </TableCell>
                <TableCell className="text-right font-mono text-sm">{m.app_version}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>
    </Panel>
  );
}

/** Props. */
export interface StatusSectionProps {
  readonly system: SystemInfo;
  readonly health: HealthResponse | undefined;
  readonly healthQuery: UseQueryResult<unknown, unknown>;
  readonly events: readonly SystemEvent[];
  readonly realtime: UseQueryResult<
    { readonly connections: readonly RealtimeConnection[] },
    unknown
  >;
  /** `GET /system/mcp/connections`; absent in callers that do not show it. */
  readonly mcpConnections?: UseQueryResult<McpConnectionsResponse, unknown>;
  /** Page state for {@link mcpConnections}. */
  readonly mcpPaging?: McpConnectionsPaging;
}

/** Status section. */
export function StatusSection({
  system,
  health,
  healthQuery,
  events,
  realtime,
  mcpConnections,
  mcpPaging,
}: StatusSectionProps) {
  const notices = systemNotices(system, health);
  return (
    <div className="flex flex-col gap-6">
      {notices.map((n) => (
        <Callout key={n.id} tone={n.tone} title={n.title}>
          {n.body}
        </Callout>
      ))}
      <Kpis system={system} />
      <HealthRuntimePanel system={system} health={health} query={healthQuery} />
      <BrowsersPanel system={system} />
      {mcpConnections !== undefined ? (
        <McpConnectionsPanel
          query={mcpConnections}
          {...(mcpPaging !== undefined && { paging: mcpPaging })}
        />
      ) : null}
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
        <StoragePanel system={system} />
        <div className="flex min-w-0 flex-col gap-6">
          <DegradationsPanel events={events} />
          <ConnectionsPanel query={realtime} />
        </div>
      </div>
      <MigrationsPanel
        migrations={system.storage.migrations}
        schema={system.storage.schema_version}
        minReader={system.storage.min_reader_version}
      />
    </div>
  );
}

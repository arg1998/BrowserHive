/** @module features/overview/components/OverviewTiles — the KPI row: live sessions, open attention, sessions/tool calls/errors/blocked in the window (32px sparklines), vault fills when the vault is on; trends drawn beside the value only when they read as a trend (every tile keeps one height); Blocked URLs hidden while no blocklist exists; a deliberate grid that never orphans a tile; live values come from `system.status` (spec 04 §12.1) */
import type { ActivityResponse, SystemInfo } from '@browserhive/contracts/http';
import type { ReactElement } from 'react';
import { SkeletonTiles } from '@/components/shared/Skeletons.tsx';
import { Sparkline } from '@/components/shared/Sparkline.tsx';
import { StatTile } from '@/components/shared/StatTile.tsx';
import { formatNumber, formatPercent } from '@/lib/format/bytes.ts';
import type { Tone } from '@/lib/status-registry.ts';
import { cn } from '@/lib/utils.ts';

/** Props. */
export interface OverviewTilesProps {
  readonly activity: ActivityResponse;
  /** May lag or be absent; when present its counts win (they are patched live). */
  readonly system: SystemInfo | undefined;
  readonly rangeLabel: string;
  /** Vault fills in the window; `undefined` when the vault is off (the tile is hidden). */
  readonly vaultFills: number | undefined;
}

/** Error-rate sub text: "{pct}% of calls · {n} all-time". */
export function errorSub(errors: number, calls: number, allTime: number): string {
  const pct = calls > 0 ? formatPercent(errors / calls) : '0%';
  return allTime > 0 ? `${pct} of calls · ${formatNumber(allTime)} all-time` : `${pct} of calls`;
}

/**
 * Grid columns per tile count: every row is full at every breakpoint. Odd counts let the first tile
 * (live sessions) span two columns until all tiles fit on one row.
 */
export function tileGridClass(count: number): string {
  switch (count) {
    case 4:
      return 'grid-cols-2 xl:grid-cols-4';
    case 5:
      return 'grid-cols-2 md:grid-cols-3 xl:grid-cols-5 [&>:first-child]:col-span-2 xl:[&>:first-child]:col-span-1';
    case 7:
      return 'grid-cols-2 md:grid-cols-4 [&>:first-child]:col-span-2';
    case 8:
      return 'grid-cols-2 md:grid-cols-4';
    default:
      return 'grid-cols-2 md:grid-cols-3 xl:grid-cols-6';
  }
}

/** A trend is worth drawing once at least this many buckets have data (else it is a flat line with a spike). */
export const SPARK_MIN_BUCKETS = 3;

/** The sparkline points, or `undefined` when the series is too sparse to read as a trend. */
export function sparkPoints(values: readonly number[]): readonly number[] | undefined {
  return values.filter((v) => v > 0).length >= SPARK_MIN_BUCKETS ? values : undefined;
}

/** Hide the Blocked URLs tile when no blocklist is configured and nothing was ever blocked. */
export function showBlockedTile(system: SystemInfo | undefined, blockedTotal: number): boolean {
  return blockedTotal > 0 || system?.blocklist.configured !== false;
}

/** Tile value with an optional trend beside it: the sparkline shares the value row, so every tile keeps one height. */
function TrendValue({
  value,
  spark,
  tone,
  label,
}: {
  readonly value: string;
  readonly spark: readonly number[] | undefined;
  readonly tone: Tone;
  readonly label: string;
}) {
  return (
    <span className="flex min-w-0 items-end justify-between gap-3">
      <span className="min-w-0 truncate">{value}</span>
      {spark !== undefined ? (
        <Sparkline
          points={spark}
          tone={tone}
          label={label}
          className="mb-1 h-6 w-20 shrink-0 opacity-90 sm:w-24"
        />
      ) : null}
    </span>
  );
}

/** Placeholder tiles at the exact `StatTile` geometry, in the same grid as the tiles. */
export function OverviewTilesSkeleton({ count = 6 }: { readonly count?: number }) {
  return (
    <SkeletonTiles
      count={count}
      label="Fleet metrics"
      className={cn('grid gap-3 sm:gap-4', tileGridClass(count))}
    />
  );
}

/** KPI tiles. */
export function OverviewTiles({ activity, system, rangeLabel, vaultFills }: OverviewTilesProps) {
  const s = activity.summary;
  const live = system?.capacity.live ?? s.sessions_live;
  const openAttention = system?.open_attention ?? s.attention_open;
  const screencasts = system?.active_screencasts ?? s.active_screencasts;
  const vaultOn = vaultFills !== undefined;
  const spark = (pick: (b: ActivityResponse['buckets'][number]) => number) =>
    sparkPoints(activity.buckets.map(pick));
  const tiles: ReactElement[] = [
    <StatTile
      key="live"
      label="Live sessions"
      value={formatNumber(live)}
      {...(live > 0 && { tone: 'success' as const })}
      sub={
        vaultOn
          ? live > 0
            ? 'running now'
            : 'none running'
          : `${formatNumber(screencasts)} watched live`
      }
      to="/sessions"
      search={{ view: 'live' }}
    />,
    <StatTile
      key="attention"
      label="Open attention"
      value={formatNumber(openAttention)}
      {...(openAttention > 0 && { tone: 'warn' as const })}
      sub={openAttention > 0 ? 'agents waiting on you' : 'queue clear'}
      to="/attention"
    />,
    <StatTile
      key="sessions"
      label={`Sessions · ${rangeLabel}`}
      value={
        <TrendValue
          value={formatNumber(s.sessions_window)}
          spark={spark((b) => b.sessions_started)}
          tone="accent"
          label="Sessions started per bucket"
        />
      }
      sub={`${formatNumber(s.sessions_total)} all-time`}
    />,
    <StatTile
      key="calls"
      label={`Tool calls · ${rangeLabel}`}
      value={
        <TrendValue
          value={formatNumber(s.tool_calls_window)}
          spark={spark((b) => b.tool_calls)}
          tone="accent"
          label="Tool calls per bucket"
        />
      }
      sub={`${formatNumber(s.tool_calls_total)} all-time`}
    />,
    <StatTile
      key="errors"
      label={`Errors · ${rangeLabel}`}
      value={
        <TrendValue
          value={formatNumber(s.errors_window)}
          spark={spark((b) => b.errors)}
          tone="danger"
          label="Errors per bucket"
        />
      }
      {...(s.errors_window > 0 && { tone: 'danger' as const })}
      sub={errorSub(s.errors_window, s.tool_calls_window, s.errors_total)}
      info={
        <>
          Tool calls in the selected window that failed, counted over <b>{rangeLabel}</b> (the same
          window as the chart). Includes calls that <em>reported</em> a failure in an otherwise
          successful result: a <code>vault_fill</code> that came back <code>auth_failed</code>, a{' '}
          <code>navigate</code> that returned HTTP 404, an attention request that timed out.
        </>
      }
    />,
  ];
  if (showBlockedTile(system, s.blocked_total)) {
    tiles.push(
      <StatTile
        key="blocked"
        label={`Blocked URLs · ${rangeLabel}`}
        value={formatNumber(s.blocked_window)}
        {...(s.blocked_window > 0 && { tone: 'warn' as const })}
        sub={`${formatNumber(s.blocked_total)} all-time`}
        to="/blocklist"
      />,
    );
  }
  if (vaultOn) {
    tiles.push(
      <StatTile
        key="vault"
        label={`Vault fills · ${rangeLabel}`}
        value={formatNumber(vaultFills)}
        {...(vaultFills > 0 && { tone: 'vault' as const })}
        sub="credential fills"
        to="/vault/log"
      />,
      <StatTile
        key="views"
        label="Active live views"
        value={formatNumber(screencasts)}
        sub="operators watching"
      />,
    );
  }
  return (
    <section
      aria-label="Fleet metrics"
      className={cn('grid gap-3 sm:gap-4', tileGridClass(tiles.length))}
    >
      {tiles}
    </section>
  );
}

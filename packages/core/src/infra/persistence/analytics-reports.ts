/** @module infra/persistence/analytics-reports — the report-window queries of `AnalyticsQueries` (D-43 digests): counts, per-tool latency and the top errors of a period. */

import { type Kysely, sql } from 'kysely';
import type {
  ReportWindow,
  ToolLatencyRow,
  TopErrorRow,
  WindowCounts,
} from '../../ports/persistence/analytics.ts';
import type { DB } from './generated/db.d.ts';
import { asNumber } from './repositories/common.ts';

/** `AnalyticsQueries.windowCounts`: sessions, calls, errors and blocked requests in a report window. */
export async function windowCounts(db: Kysely<DB>, window: ReportWindow): Promise<WindowCounts> {
  const { since, until } = window;
  const row = await sql<{
    sessions: number;
    calls: number;
    errors: number;
    blocked: number;
    attention: number;
    vault: number;
  }>`
    SELECT
      (SELECT COUNT(*) FROM sessions WHERE created_at >= ${since} AND created_at < ${until}) AS sessions,
      (SELECT COUNT(*) FROM tool_calls WHERE ts >= ${since} AND ts < ${until}) AS calls,
      (SELECT COUNT(*) FROM tool_calls WHERE error_code IS NOT NULL AND ts >= ${since} AND ts < ${until}) AS errors,
      (SELECT COUNT(*) FROM blocked_requests WHERE ts >= ${since} AND ts < ${until}) AS blocked,
      (SELECT COUNT(*) FROM operator_requests WHERE kind = 'attention' AND created_at >= ${since} AND created_at < ${until}) AS attention,
      (SELECT COUNT(*) FROM vault_access WHERE ts >= ${since} AND ts < ${until}) AS vault`.execute(
    db,
  );
  const r = row.rows[0];
  return {
    sessionsStarted: asNumber(r?.sessions),
    toolCalls: asNumber(r?.calls),
    errors: asNumber(r?.errors),
    blocked: asNumber(r?.blocked),
    attention: asNumber(r?.attention),
    vaultAccess: asNumber(r?.vault),
  };
}

/** `AnalyticsQueries.toolLatency`: per tool, calls and latency percentiles in a report window. */
export async function toolLatency(
  db: Kysely<DB>,
  window: ReportWindow,
): Promise<readonly ToolLatencyRow[]> {
  // The 95th percentile by rank inside SQLite (a window function), so only one row per tool
  // leaves the database: the smallest duration whose rank is at least 95 % of the calls.
  const rows = await sql<{ tool: string; calls: number; errors: number; p95: number | null }>`
    WITH ranked AS (
      SELECT tool, duration_ms, error_code,
             ROW_NUMBER() OVER (PARTITION BY tool ORDER BY duration_ms) AS rn,
             COUNT(*) OVER (PARTITION BY tool) AS n
        FROM tool_calls
       WHERE ts >= ${window.since} AND ts < ${window.until}
    )
    SELECT tool, MAX(n) AS calls,
           SUM(CASE WHEN error_code IS NOT NULL THEN 1 ELSE 0 END) AS errors,
           MIN(CASE WHEN rn * 100 >= 95 * n THEN duration_ms END) AS p95
      FROM ranked
     GROUP BY tool`.execute(db);
  return rows.rows
    .map((r) => ({
      tool: r.tool,
      calls: asNumber(r.calls),
      errors: asNumber(r.errors),
      p95Ms: asNumber(r.p95),
    }))
    .sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool));
}

/** `AnalyticsQueries.topErrors`: the most frequent error codes in a report window. */
export async function topErrors(
  db: Kysely<DB>,
  window: ReportWindow,
  limit: number,
): Promise<readonly TopErrorRow[]> {
  const rows = await db
    .selectFrom('tool_calls')
    .select([
      'error_code',
      'tool',
      sql<number>`COUNT(*)`.as('n'),
      sql<number>`COUNT(DISTINCT session_id)`.as('sessions'),
    ])
    .where('error_code', 'is not', null)
    .where('ts', '>=', window.since)
    .where('ts', '<', window.until)
    .groupBy(['error_code', 'tool'])
    .orderBy('n', 'desc')
    .orderBy('error_code')
    .orderBy('tool')
    .limit(Math.max(1, Math.min(50, limit)))
    .execute();
  return rows.map((r) => ({
    errorCode: r.error_code ?? '',
    tool: r.tool,
    count: asNumber(r.n),
    sessions: asNumber(r.sessions),
  }));
}

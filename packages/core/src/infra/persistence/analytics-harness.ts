/** @module infra/persistence/analytics-harness — the per-harness queries of `AnalyticsQueries` (spec 02 §1.4): sessions and tool calls by harness, and the harnesses seen with their declared names and principals. */

import { normalizeHarness, UNKNOWN_HARNESS } from '@browserhive/contracts/harness';
import { type Kysely, sql } from 'kysely';
import type {
  HarnessesSeen,
  HarnessMetricsRow,
  SeenHarnessRow,
} from '../../ports/persistence/analytics.ts';
import type { DB } from './generated/db.d.ts';
import { asNumber } from './repositories/common.ts';
import { TOOL_CALL_HARNESS } from './repositories/tool-calls.ts';

/** A time window, both ends included. */
interface Window {
  readonly since: number;
  readonly until: number;
}

/** `AnalyticsQueries.harnessMetrics`: sessions and tool calls per harness in the window. */
export async function harnessMetrics(
  db: Kysely<DB>,
  window: Window,
): Promise<readonly HarnessMetricsRow[]> {
  const { since, until } = window;
  const sessions = await db
    .selectFrom('sessions')
    .select([
      sql<string>`COALESCE(harness, 'unknown')`.as('harness'),
      sql<number>`COUNT(*)`.as('n'),
      sql<number>`SUM(CASE WHEN closed_at IS NULL THEN 1 ELSE 0 END)`.as('live'),
    ])
    .where('created_at', '>=', since)
    .where('created_at', '<=', until)
    .groupBy(sql`COALESCE(harness, 'unknown')`)
    .execute();
  const calls = await db
    .selectFrom('tool_calls as t')
    .leftJoin('sessions as s', 's.session_id', 't.session_id')
    .leftJoin('mcp_connections as m', 'm.connection_id', 't.connection_id')
    .select([
      TOOL_CALL_HARNESS.as('harness'),
      sql<number>`COUNT(*)`.as('n'),
      sql<number>`SUM(CASE WHEN t.error_code IS NOT NULL THEN 1 ELSE 0 END)`.as('errors'),
    ])
    .where('t.ts', '>=', since)
    .where('t.ts', '<=', until)
    .groupBy(TOOL_CALL_HARNESS)
    .execute();
  const byHarness = new Map<
    string,
    { sessions: number; sessionsLive: number; toolCalls: number; errors: number }
  >();
  const entry = (raw: string) => {
    // Rows written before schema v3 may hold a raw header value; fold it onto its slug.
    const harness = normalizeHarness(raw) ?? UNKNOWN_HARNESS;
    let found = byHarness.get(harness);
    if (found === undefined) {
      found = { sessions: 0, sessionsLive: 0, toolCalls: 0, errors: 0 };
      byHarness.set(harness, found);
    }
    return found;
  };
  entry(UNKNOWN_HARNESS);
  for (const row of sessions) {
    const e = entry(row.harness);
    e.sessions += asNumber(row.n);
    e.sessionsLive += asNumber(row.live);
  }
  for (const row of calls) {
    const e = entry(row.harness);
    e.toolCalls += asNumber(row.n);
    e.errors += asNumber(row.errors);
  }
  return [...byHarness.entries()]
    .map(([harness, counts]) => ({ harness, ...counts }))
    .sort(
      (a, b) =>
        Number(a.harness === UNKNOWN_HARNESS) - Number(b.harness === UNKNOWN_HARNESS) ||
        b.sessions - a.sessions ||
        b.toolCalls - a.toolCalls ||
        a.harness.localeCompare(b.harness),
    );
}

/** `AnalyticsQueries.harnessesSeen`: the harnesses that launched sessions or called tools in the window. */
export async function harnessesSeen(db: Kysely<DB>, window: Window): Promise<HarnessesSeen> {
  const { since, until } = window;
  const launched = await db
    .selectFrom('sessions')
    .select([
      sql<string>`COALESCE(harness, 'unknown')`.as('harness'),
      'harness_declared as declared',
      sql<number>`COUNT(*)`.as('n'),
      sql<number>`MAX(created_at)`.as('last'),
    ])
    .where('created_at', '>=', since)
    .where('created_at', '<=', until)
    .groupBy([sql`COALESCE(harness, 'unknown')`, 'harness_declared'])
    .execute();
  const owners = await db
    .selectFrom('sessions')
    .select(sql<number>`COUNT(DISTINCT owner)`.as('n'))
    .where('created_at', '>=', since)
    .where('created_at', '<=', until)
    .executeTakeFirst();
  const open = await db
    .selectFrom('mcp_connections')
    .select(['harness', 'harness_declared as declared', sql<number>`MAX(last_seen_at)`.as('last')])
    .where('closed_at', 'is', null)
    .groupBy(['harness', 'harness_declared'])
    .execute();
  const byKey = new Map<string, SeenHarnessRow>();
  const keyOf = (harness: string, declared: string | null) => JSON.stringify([harness, declared]);
  for (const row of launched) {
    const harness = normalizeHarness(row.harness) ?? UNKNOWN_HARNESS;
    const key = keyOf(harness, row.declared);
    const prior = byKey.get(key);
    byKey.set(key, {
      harness,
      declared: row.declared,
      sessions: (prior?.sessions ?? 0) + asNumber(row.n),
      lastSeenAt: Math.max(prior?.lastSeenAt ?? 0, asNumber(row.last)),
    });
  }
  for (const row of open) {
    // Rows written before schema v3 may hold a raw header value; fold it onto its slug.
    const harness =
      row.harness === null ? UNKNOWN_HARNESS : (normalizeHarness(row.harness) ?? UNKNOWN_HARNESS);
    const key = keyOf(harness, row.declared);
    const prior = byKey.get(key);
    byKey.set(key, {
      harness,
      declared: row.declared,
      sessions: prior?.sessions ?? 0,
      lastSeenAt: Math.max(prior?.lastSeenAt ?? 0, asNumber(row.last)),
    });
  }
  return {
    rows: [...byKey.values()].sort(
      (a, b) =>
        b.lastSeenAt - a.lastSeenAt ||
        a.harness.localeCompare(b.harness) ||
        (a.declared ?? '').localeCompare(b.declared ?? ''),
    ),
    principals: asNumber(owners?.n),
  };
}

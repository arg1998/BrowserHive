/** @module infra/persistence/analytics — SQLite `AnalyticsQueries` (activity buckets, tool metrics, timeline, summary). */

import { normalizeHarness, UNKNOWN_HARNESS } from '@browserhive/contracts/harness';
import { type Kysely, sql } from 'kysely';
import type {
  ActivityBucket,
  ActivityQuery,
  ActivityResult,
  ActivitySummary,
  AnalyticsQueries,
  HarnessMetricsRow,
  TimelineItem,
  TimelineKind,
  TimelineQuery,
  ToolMetricsQuery,
  ToolMetricsRow,
} from '../../ports/persistence/analytics.ts';
import type { DomainCount } from '../../ports/persistence/pages.ts';
import type { Page, TopDomainsQuery } from '../../ports/persistence/queries.ts';
import type { Repositories } from '../../ports/persistence/unit-of-work.ts';
import type { WriteQueue } from '../../ports/persistence/write-queue.ts';
import type { DB } from './generated/db.d.ts';
import { asNumber, clampLimit, decodeCursor, encodeCursor } from './repositories/common.ts';
import { TOOL_CALL_HARNESS } from './repositories/tool-calls.ts';

/** Smallest bucket of `GET /activity`. */
export const MIN_BUCKET_MS = 60_000;
/** Largest bucket. */
export const MAX_BUCKET_MS = 86_400_000;
/** Most buckets returned. */
export const MAX_BUCKETS = 720;

const TIMELINE = 'timeline';
const ALL_KINDS: readonly TimelineKind[] = ['tool', 'page', 'attention', 'vault', 'blocked'];

/** Unique row identity of a timeline item: `<kind>:<event_id | request_id>`. */
export function timelineId(kind: TimelineKind, rowId: string): string {
  return `${kind}:${rowId}`;
}

type BucketField =
  | 'toolCalls'
  | 'errors'
  | 'sessionsStarted'
  | 'sessionsClosed'
  | 'blocked'
  | 'attention';

interface Bucket {
  toolCalls: number;
  errors: number;
  sessionsStarted: number;
  sessionsClosed: number;
  blocked: number;
  attention: number;
  groups: Map<string, number>;
}

/** Picks a bucket width honouring the bounds and the 720-bucket cap. */
export function resolveBucketMs(since: number, until: number, requested?: number): number {
  const span = Math.max(1, until - since);
  const minForCap = Math.ceil(span / MAX_BUCKETS);
  const base = requested ?? Math.max(MIN_BUCKET_MS, minForCap);
  return Math.min(MAX_BUCKET_MS, Math.max(MIN_BUCKET_MS, minForCap, Math.floor(base)));
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

/** SQLite implementation of {@link AnalyticsQueries}; drains the write queue before every read. */
export class SqliteAnalyticsQueries implements AnalyticsQueries {
  readonly #db: Kysely<DB>;
  readonly #repos: Repositories;
  readonly #queue: WriteQueue | null;

  constructor(db: Kysely<DB>, repos: Repositories, queue: WriteQueue | null = null) {
    this.#db = db;
    this.#repos = repos;
    this.#queue = queue;
  }

  async #drain(): Promise<void> {
    if (this.#queue !== null) await this.#queue.drain();
  }

  async #bucketCounts(
    table: 'tool_calls' | 'sessions' | 'blocked_requests' | 'operator_requests',
    col: string,
    since: number,
    until: number,
    bucketMs: number,
    extra?: string,
  ): Promise<readonly { b: number; n: number }[]> {
    const where = extra === undefined ? sql`` : sql` AND ${sql.raw(extra)}`;
    const result = await sql<{ b: number; n: number }>`
      SELECT (${sql.ref(col)} / ${bucketMs}) * ${bucketMs} AS b, COUNT(*) AS n
        FROM ${sql.table(table)}
       WHERE ${sql.ref(col)} >= ${since} AND ${sql.ref(col)} <= ${until}${where}
       GROUP BY b`.execute(this.#db);
    return result.rows;
  }

  async activity(query: ActivityQuery): Promise<ActivityResult> {
    await this.#drain();
    const bucketMs = resolveBucketMs(query.since, query.until, query.bucketMs);
    const since = Math.floor(query.since / bucketMs) * bucketMs;
    const until = query.until;
    const buckets = new Map<number, Bucket>();
    for (let ts = since; ts <= until; ts += bucketMs) {
      buckets.set(ts, {
        toolCalls: 0,
        errors: 0,
        sessionsStarted: 0,
        sessionsClosed: 0,
        blocked: 0,
        attention: 0,
        groups: new Map(),
      });
    }
    const put = (rows: readonly { b: number; n: number }[], field: BucketField) => {
      for (const row of rows) {
        const bucket = buckets.get(asNumber(row.b));
        if (bucket !== undefined) bucket[field] = asNumber(row.n);
      }
    };
    put(await this.#bucketCounts('tool_calls', 'ts', since, until, bucketMs), 'toolCalls');
    put(
      await this.#bucketCounts(
        'tool_calls',
        'ts',
        since,
        until,
        bucketMs,
        'error_code IS NOT NULL',
      ),
      'errors',
    );
    put(
      await this.#bucketCounts('sessions', 'created_at', since, until, bucketMs),
      'sessionsStarted',
    );
    put(
      await this.#bucketCounts('sessions', 'closed_at', since, until, bucketMs),
      'sessionsClosed',
    );
    put(await this.#bucketCounts('blocked_requests', 'ts', since, until, bucketMs), 'blocked');
    put(
      await this.#bucketCounts(
        'operator_requests',
        'created_at',
        since,
        until,
        bucketMs,
        "kind = 'attention'",
      ),
      'attention',
    );
    if (query.groupBy !== undefined) {
      const col =
        query.groupBy === 'tool'
          ? 'tool'
          : query.groupBy === 'error_code'
            ? 'error_code'
            : 'session_id';
      const rows = await this.#db
        .selectFrom('tool_calls')
        .where('ts', '>=', since)
        .where('ts', '<=', until)
        .select([
          sql<number>`(ts / ${bucketMs}) * ${bucketMs}`.as('b'),
          sql<string | null>`${sql.ref(col)}`.as('g'),
          sql<number>`COUNT(*)`.as('n'),
        ])
        .groupBy(['b', 'g'])
        .execute();
      for (const row of rows)
        buckets.get(asNumber(row.b))?.groups.set(row.g ?? '', asNumber(row.n));
    }
    const out: ActivityBucket[] = [];
    for (const [ts, b] of buckets) {
      out.push({
        ts,
        toolCalls: b.toolCalls,
        errors: b.errors,
        sessionsStarted: b.sessionsStarted,
        sessionsClosed: b.sessionsClosed,
        blocked: b.blocked,
        attention: b.attention,
        ...(query.groupBy !== undefined && { groups: Object.fromEntries(b.groups) }),
      });
    }
    return { buckets: out, window: { since, until, bucketMs } };
  }

  async toolMetrics(query: ToolMetricsQuery): Promise<readonly ToolMetricsRow[]> {
    await this.#drain();
    let qb = this.#db.selectFrom('tool_calls').select(['tool', 'error_code', 'duration_ms']);
    if (query.sessionId !== undefined) qb = qb.where('session_id', '=', query.sessionId);
    if (query.since !== undefined) qb = qb.where('ts', '>=', query.since);
    if (query.until !== undefined) qb = qb.where('ts', '<=', query.until);
    const rows = await qb.execute();
    const byTool = query.groupBy !== 'error_code';
    const byError = query.groupBy !== 'tool';
    const groups = new Map<
      string,
      { tool: string | null; errorCode: string | null; durations: number[]; errors: number }
    >();
    for (const row of rows) {
      const tool = byTool ? row.tool : null;
      const errorCode = byError ? row.error_code : null;
      const key = `${tool ?? ''}::${errorCode ?? ''}`;
      let group = groups.get(key);
      if (group === undefined) {
        group = { tool, errorCode, durations: [], errors: 0 };
        groups.set(key, group);
      }
      group.durations.push(row.duration_ms);
      if (row.error_code !== null) group.errors += 1;
    }
    const out: ToolMetricsRow[] = [];
    for (const group of groups.values()) {
      const sorted = [...group.durations].sort((a, b) => a - b);
      const calls = sorted.length;
      out.push({
        tool: group.tool,
        errorCode: group.errorCode,
        calls,
        errors: group.errors,
        errorRate: calls === 0 ? 0 : group.errors / calls,
        p50Ms: percentile(sorted, 50),
        p95Ms: percentile(sorted, 95),
        p99Ms: percentile(sorted, 99),
        maxMs: sorted[calls - 1] ?? 0,
      });
    }
    out.sort(
      (a, b) =>
        b.calls - a.calls ||
        (a.tool ?? '').localeCompare(b.tool ?? '') ||
        (a.errorCode ?? '').localeCompare(b.errorCode ?? ''),
    );
    return out;
  }

  async timeline(sessionId: string, query: TimelineQuery): Promise<Page<TimelineItem>> {
    await this.#drain();
    const limit = clampLimit(query.limit);
    const cursor = decodeCursor(TIMELINE, query.cursor);
    const kinds = new Set(
      query.kinds !== undefined && query.kinds.length > 0 ? query.kinds : ALL_KINDS,
    );
    const errorsOnly = query.errorsOnly === true;
    const cursorTs = cursor === null ? undefined : asNumber(cursor.key);
    const until =
      cursorTs === undefined
        ? query.until
        : Math.min(query.until ?? Number.MAX_SAFE_INTEGER, cursorTs);
    const sub = {
      limit: limit + 1,
      sessionId,
      dir: 'desc' as const,
      ...(query.since !== undefined && { since: query.since }),
      ...(until !== undefined && { until }),
      ...(query.q !== undefined && query.q !== '' && { q: query.q }),
    };
    const items: TimelineItem[] = [];
    if (kinds.has('tool')) {
      const page = await this.#repos.toolCalls.listBySession(sessionId, {
        ...sub,
        ...(errorsOnly && { hasError: true }),
      });
      for (const item of page.items)
        items.push({ kind: 'tool', ts: item.ts, id: timelineId('tool', item.eventId), item });
    }
    if (kinds.has('page') && !errorsOnly) {
      const page = await this.#repos.pages.list(sub);
      for (const item of page.items)
        items.push({ kind: 'page', ts: item.ts, id: timelineId('page', item.eventId), item });
    }
    if (kinds.has('attention')) {
      const page = await this.#repos.operatorRequests.listHistory({
        ...sub,
        kind: 'attention',
        ...(errorsOnly && { statuses: ['rejected', 'timeout', 'cancelled'] as const }),
      });
      for (const item of page.items)
        items.push({
          kind: 'attention',
          ts: item.createdAt,
          id: timelineId('attention', item.requestId),
          item,
        });
    }
    if (kinds.has('vault')) {
      const page = await this.#repos.vaultAudit.list({
        ...sub,
        ...(errorsOnly && {
          results: ['origin_mismatch', 'auth_failed', 'blocked', 'denied'] as const,
        }),
      });
      for (const item of page.items)
        items.push({ kind: 'vault', ts: item.ts, id: timelineId('vault', item.eventId), item });
    }
    if (kinds.has('blocked')) {
      const page = await this.#repos.blocklistAudit.list(sub);
      for (const item of page.items)
        items.push({ kind: 'blocked', ts: item.ts, id: timelineId('blocked', item.eventId), item });
    }
    // Ties on `ts` break on the kind-qualified id, so a navigate call and the page row it produced
    // (same event id) stay distinct and keep a stable order across pages.
    items.sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    const after =
      cursor === null || cursorTs === undefined
        ? items
        : items.filter((i) => i.ts < cursorTs || (i.ts === cursorTs && i.id < cursor.id));
    const slice = after.slice(0, limit);
    const last = after.length > limit ? slice[slice.length - 1] : undefined;
    return {
      items: slice,
      nextCursor: last === undefined ? null : encodeCursor(TIMELINE, { key: last.ts, id: last.id }),
    };
  }

  async harnessMetrics(window: {
    readonly since: number;
    readonly until: number;
  }): Promise<readonly HarnessMetricsRow[]> {
    await this.#drain();
    const { since, until } = window;
    const sessions = await this.#db
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
    const calls = await this.#db
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

  async summary(now: number, windowMs: number): Promise<ActivitySummary> {
    await this.#drain();
    const since = now - windowMs;
    const n = sql<number>`COUNT(*)`.as('n');
    const one = async (qb: { executeTakeFirst(): Promise<{ n: number } | undefined> }) =>
      asNumber((await qb.executeTakeFirst())?.n);
    return {
      sessionsTotal: await one(this.#db.selectFrom('sessions').select(n)),
      sessionsLive: await one(
        this.#db.selectFrom('sessions').select(n).where('closed_at', 'is', null),
      ),
      sessionsWindow: await one(
        this.#db.selectFrom('sessions').select(n).where('created_at', '>=', since),
      ),
      toolCallsWindow: await one(
        this.#db.selectFrom('tool_calls').select(n).where('ts', '>=', since),
      ),
      toolCallsTotal: await one(this.#db.selectFrom('tool_calls').select(n)),
      errorsWindow: await one(
        this.#db
          .selectFrom('tool_calls')
          .select(n)
          .where('ts', '>=', since)
          .where('error_code', 'is not', null),
      ),
      errorsTotal: await one(
        this.#db.selectFrom('tool_calls').select(n).where('error_code', 'is not', null),
      ),
      blockedWindow: await one(
        this.#db.selectFrom('blocked_requests').select(n).where('ts', '>=', since),
      ),
      blockedTotal: await one(this.#db.selectFrom('blocked_requests').select(n)),
      attentionOpen: await one(
        this.#db
          .selectFrom('operator_requests')
          .select(n)
          .where('status', '=', 'pending')
          .where('kind', '=', 'attention'),
      ),
    };
  }

  async databaseSize(): Promise<number> {
    const row = await sql<{
      n: number;
    }>`SELECT (SELECT page_count FROM pragma_page_count) * (SELECT page_size FROM pragma_page_size) AS n`.execute(
      this.#db,
    );
    return asNumber(row.rows[0]?.n);
  }

  async topDomains(query: TopDomainsQuery): Promise<readonly DomainCount[]> {
    await this.#drain();
    return this.#repos.pages.topDomains(query);
  }
}

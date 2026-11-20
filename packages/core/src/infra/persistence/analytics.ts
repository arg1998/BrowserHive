/** @module infra/persistence/analytics — SQLite `AnalyticsQueries` (activity buckets, tool metrics, timeline, summary). */

import { type Kysely, sql } from 'kysely';
import type {
  ActivityBucket,
  ActivityQuery,
  ActivityResult,
  ActivitySummary,
  AnalyticsQueries,
  HarnessesSeen,
  HarnessMetricsRow,
  ReportWindow,
  TimelineItem,
  TimelineQuery,
  ToolLatencyRow,
  ToolMetricsQuery,
  ToolMetricsRow,
  TopErrorRow,
  WindowCounts,
} from '../../ports/persistence/analytics.ts';
import type { DomainCount } from '../../ports/persistence/pages.ts';
import type { Page, TopDomainsQuery } from '../../ports/persistence/queries.ts';
import type { Repositories } from '../../ports/persistence/unit-of-work.ts';
import type { WriteQueue } from '../../ports/persistence/write-queue.ts';
import { harnessesSeen, harnessMetrics } from './analytics-harness.ts';
import { toolLatency, topErrors, windowCounts } from './analytics-reports.ts';
import { sessionTimeline } from './analytics-timeline.ts';
import type { DB } from './generated/db.d.ts';
import { asNumber } from './repositories/common.ts';

export { timelineId } from './analytics-timeline.ts';

/** Smallest bucket of `GET /activity`. */
export const MIN_BUCKET_MS = 60_000;
/** Largest bucket. */
export const MAX_BUCKET_MS = 86_400_000;
/** Most buckets returned. */
export const MAX_BUCKETS = 720;

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
    return sessionTimeline(this.#repos, sessionId, query);
  }

  async harnessMetrics(window: {
    readonly since: number;
    readonly until: number;
  }): Promise<readonly HarnessMetricsRow[]> {
    await this.#drain();
    return harnessMetrics(this.#db, window);
  }

  async harnessesSeen(window: {
    readonly since: number;
    readonly until: number;
  }): Promise<HarnessesSeen> {
    await this.#drain();
    return harnessesSeen(this.#db, window);
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

  async windowCounts(window: ReportWindow): Promise<WindowCounts> {
    await this.#drain();
    return windowCounts(this.#db, window);
  }

  async toolLatency(window: ReportWindow): Promise<readonly ToolLatencyRow[]> {
    await this.#drain();
    return toolLatency(this.#db, window);
  }

  async topErrors(window: ReportWindow, limit: number): Promise<readonly TopErrorRow[]> {
    await this.#drain();
    return topErrors(this.#db, window, limit);
  }
}

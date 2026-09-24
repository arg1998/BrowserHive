/** @module contracts/http/metrics — activity buckets and tool metrics (spec 03 §4.3) */
import { z } from 'zod';
import { SessionId } from '../ids/index.ts';
import { Count, DurationMs, EpochMs, QueryInt, windowQuery } from './common.ts';
import { HarnessSlug } from './sessions.ts';

/** Smallest activity bucket (1 minute). */
export const ACTIVITY_BUCKET_MIN_MS = 60_000;
/** Largest activity bucket (1 day). */
export const ACTIVITY_BUCKET_MAX_MS = 86_400_000;
/** Maximum buckets in one activity response; the server widens `bucket_ms` to stay under it. */
export const ACTIVITY_MAX_BUCKETS = 720;
/** Default activity window when `since`/`until` are absent (7 days). */
export const ACTIVITY_DEFAULT_WINDOW_MS = 7 * 86_400_000;

/** Activity grouping dimension. */
export const ActivityGroupBy = z.enum(['tool', 'error_code', 'session']);
/** Activity grouping dimension. */
export type ActivityGroupBy = z.infer<typeof ActivityGroupBy>;

/** `GET /activity` query. */
export const ActivityQuery = z.strictObject({
  ...windowQuery,
  bucket_ms: QueryInt.min(ACTIVITY_BUCKET_MIN_MS).max(ACTIVITY_BUCKET_MAX_MS).optional(),
  group_by: ActivityGroupBy.optional(),
});
/** `GET /activity` query. */
export type ActivityQuery = z.infer<typeof ActivityQuery>;

/** One gap-filled, grid-aligned activity bucket. */
export const ActivityBucket = z.object({
  ts: EpochMs,
  tool_calls: Count,
  errors: Count,
  sessions_started: Count,
  sessions_closed: Count,
  blocked: Count,
  attention: Count,
  groups: z.record(z.string(), Count).optional(),
});
/** One activity bucket. */
export type ActivityBucket = z.infer<typeof ActivityBucket>;

/** Headline counters for the window and all-time. */
export const ActivitySummary = z.object({
  sessions_total: Count,
  sessions_live: Count,
  sessions_window: Count,
  tool_calls_window: Count,
  tool_calls_total: Count,
  errors_window: Count,
  errors_total: Count,
  blocked_window: Count,
  blocked_total: Count,
  attention_open: Count,
  active_screencasts: Count,
});
/** Headline counters. */
export type ActivitySummary = z.infer<typeof ActivitySummary>;

/** `GET /activity` body. */
export const ActivityResponse = z.object({
  buckets: z.array(ActivityBucket).max(ACTIVITY_MAX_BUCKETS),
  summary: ActivitySummary,
  window: z.object({ since: EpochMs, until: EpochMs, bucket_ms: DurationMs }),
  now: EpochMs,
});
/** `GET /activity` body. */
export type ActivityResponse = z.infer<typeof ActivityResponse>;

/** Tool metrics grouping. */
export const ToolMetricsGroupBy = z.enum(['tool', 'error_code', 'tool,error_code']);
/** Tool metrics grouping. */
export type ToolMetricsGroupBy = z.infer<typeof ToolMetricsGroupBy>;

/** `GET /metrics/tools` query. */
export const ToolMetricsQuery = z.strictObject({
  ...windowQuery,
  group_by: ToolMetricsGroupBy.default('tool'),
  session_id: SessionId.optional(),
});
/** `GET /metrics/tools` query. */
export type ToolMetricsQuery = z.infer<typeof ToolMetricsQuery>;

/** One tool metrics row; `error_code` present only when grouped by it. */
export const ToolMetricRow = z.object({
  tool: z.string(),
  error_code: z.string().nullable().optional(),
  calls: Count,
  errors: Count,
  error_rate: z.number().min(0).max(1),
  p50_ms: DurationMs,
  p95_ms: DurationMs,
  p99_ms: DurationMs,
  max_ms: DurationMs,
});
/** One tool metrics row. */
export type ToolMetricRow = z.infer<typeof ToolMetricRow>;

/** `GET /metrics/tools` body. */
export const ToolMetricsResponse = z.object({ data: z.array(ToolMetricRow), now: EpochMs });
/** `GET /metrics/tools` body. */
export type ToolMetricsResponse = z.infer<typeof ToolMetricsResponse>;

/** `GET /metrics/harnesses` query (default window: the last 7 days). */
export const HarnessMetricsQuery = z.strictObject({ ...windowQuery });
/** `GET /metrics/harnesses` query. */
export type HarnessMetricsQuery = z.infer<typeof HarnessMetricsQuery>;

/** Per-harness counts over a window (D-30). */
export const HarnessMetricRow = z.object({
  harness: HarnessSlug,
  label: z.string(),
  /** Sessions created in the window with this launch harness. */
  sessions: Count,
  /** Of those, still live. */
  sessions_live: Count,
  /** Tool calls in the window made by this harness. */
  tool_calls: Count,
  /** Of those, failed (an `error_code`, soft failures included). */
  errors: Count,
});
/** Per-harness counts. */
export type HarnessMetricRow = z.infer<typeof HarnessMetricRow>;

/** `GET /metrics/harnesses` body; `unknown` is always present. */
export const HarnessMetricsResponse = z.object({
  data: z.array(HarnessMetricRow),
  window: z.object({ since: EpochMs, until: EpochMs }),
  now: EpochMs,
});
/** `GET /metrics/harnesses` body. */
export type HarnessMetricsResponse = z.infer<typeof HarnessMetricsResponse>;

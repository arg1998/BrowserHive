/** @module contracts/http/blocklist — blocklist overview, reload and blocked-request audit (spec 03 §4.6, D-22) */
import { z } from 'zod';
import { BlockedSource } from '../enums/index.ts';
import { EventId, SessionId } from '../ids/index.ts';
import {
  Count,
  csv,
  EpochMs,
  listQuery,
  page,
  QueryText,
  sortable,
  TimeWindow,
  windowQuery,
} from './common.ts';

/** One loaded blocklist pattern with hit stats. */
export const BlocklistPattern = z.object({
  pattern: z.string(),
  line: z.number().int().positive(),
  hits: Count,
  last_ts: EpochMs.nullable(),
});
/** One loaded blocklist pattern. */
export type BlocklistPattern = z.infer<typeof BlocklistPattern>;

/** One skipped blocklist line. */
export const BlocklistSkippedLine = z.object({
  line: z.number().int().positive(),
  text: z.string(),
  reason: z.string(),
});
/** One skipped blocklist line. */
export type BlocklistSkippedLine = z.infer<typeof BlocklistSkippedLine>;

/** Aggregate blocked-request stats for the window. */
export const BlocklistStats = z.object({
  attempts: Count,
  sessions: Count,
  domains: Count,
  total_all_time: Count,
  top_patterns: z.array(z.object({ pattern: z.string(), count: Count })),
  top_domains: z.array(z.object({ domain: z.string(), count: Count })),
});
/** Aggregate blocked-request stats. */
export type BlocklistStats = z.infer<typeof BlocklistStats>;

/** `GET /blocklist` query. */
export const BlocklistOverviewQuery = z.strictObject({ ...windowQuery });
/** `GET /blocklist` query. */
export type BlocklistOverviewQuery = z.infer<typeof BlocklistOverviewQuery>;

/** `GET /blocklist` body. */
export const BlocklistOverview = z.object({
  configured: z.boolean(),
  path: z.string().nullable(),
  loaded_at: EpochMs.nullable(),
  patterns: z.array(BlocklistPattern),
  skipped: z.array(BlocklistSkippedLine),
  stats: BlocklistStats,
  window: TimeWindow,
  now: EpochMs,
});
/** `GET /blocklist` body. */
export type BlocklistOverview = z.infer<typeof BlocklistOverview>;

/** `POST /blocklist/reload` 200 body (on failure the previous list stays active). */
export const ReloadBlocklistResponse = z.object({
  ok: z.literal(true),
  patterns: Count,
  skipped: Count,
  loaded_at: EpochMs,
});
/** `POST /blocklist/reload` 200 body. */
export type ReloadBlocklistResponse = z.infer<typeof ReloadBlocklistResponse>;

/** One blocked request (`blocked_requests` row). */
export const BlockedRequestRow = z.object({
  event_id: EventId,
  session_id: SessionId.nullable(),
  session_slug: z.string().nullable(),
  tool_event_id: EventId.nullable(),
  url: z.string(),
  domain: z.string().nullable(),
  pattern: z.string(),
  source: BlockedSource,
  tool: z.string().nullable(),
  ts: EpochMs,
});
/** One blocked request. */
export type BlockedRequestRow = z.infer<typeof BlockedRequestRow>;

/** Sort keys accepted by `GET /blocklist/attempts`. */
export const BlockedSortKey = sortable(['ts', 'domain', 'pattern', 'session', 'source']);
/** Sort keys accepted by `GET /blocklist/attempts`. */
export type BlockedSortKey = z.infer<typeof BlockedSortKey>;

/** `GET /blocklist/attempts` and `GET /sessions/{session_id}/blocked` query. */
export const BlockedAttemptsQuery = listQuery({
  sort: BlockedSortKey.default('ts'),
  filters: {
    session_id: SessionId.optional(),
    pattern: z.string().min(1).max(512).optional(),
    domain: z.string().trim().toLowerCase().min(1).max(253).optional(),
    source: csv(BlockedSource),
    q: QueryText.optional(),
    ...windowQuery,
  },
});
/** `GET /blocklist/attempts` query. */
export type BlockedAttemptsQuery = z.infer<typeof BlockedAttemptsQuery>;

/** `GET /blocklist/attempts` body. */
export const BlockedAttemptsPage = page(BlockedRequestRow);
/** `GET /blocklist/attempts` body. */
export type BlockedAttemptsPage = z.infer<typeof BlockedAttemptsPage>;

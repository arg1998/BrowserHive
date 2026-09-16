/** @module contracts/http/sessions — session summary/detail DTOs and the sessions list query (spec 03 §4.2) */
import { z } from 'zod';
import { Channel, ClosedReason, PersistenceMode, SessionStatus } from '../enums/index.ts';
import { SessionId } from '../ids/index.ts';
import {
  Bytes,
  Count,
  csv,
  DurationMs,
  EpochMs,
  Facet,
  listQuery,
  page,
  QueryText,
  sortable,
  windowQuery,
} from './common.ts';

/** Browser engine; only `chromium` exists in v1. */
export const Engine = z.enum(['chromium']);
/** Browser engine. */
export type Engine = z.infer<typeof Engine>;

/** Path params for `/sessions/{session_id}/…`. */
export const SessionIdParams = z.strictObject({ session_id: SessionId });
/** Path params for `/sessions/{session_id}/…`. */
export type SessionIdParams = z.infer<typeof SessionIdParams>;

/** Per-session counters (counts only; the rows themselves are paged from their own endpoints). */
export const SessionCounts = z.object({
  tool_calls: Count,
  errors: Count,
  pages: Count,
  blocked: Count,
  attention_open: Count,
  vault_access: Count,
});
/** Per-session counters. */
export type SessionCounts = z.infer<typeof SessionCounts>;

/** Self-reported MCP client metadata (dashboard-only, never for access control). */
export const SessionClient = z.object({
  name: z.string().nullable(),
  version: z.string().nullable(),
  agent_name: z.string().optional(),
  model: z.string().optional(),
});
/** Self-reported MCP client metadata. */
export type SessionClient = z.infer<typeof SessionClient>;

/** Presented identity (UA, UA-CH brands, platform, geo, display); opaque to the dashboard. */
export const AppliedIdentity = z.record(z.string(), z.unknown());
/** Presented identity. */
export type AppliedIdentity = z.infer<typeof AppliedIdentity>;

/** The one session shape used by lists, detail and WS (spec 03 §4.2). */
export const SessionSummary = z.object({
  session_id: SessionId,
  slug: z.string(),
  owner: z.string(),
  tenant_id: z.string().nullable(),
  channel: Channel,
  engine: Engine,
  headless: z.boolean(),
  incognito: z.boolean(),
  persistence_mode: PersistenceMode,
  current_url: z.string().nullable(),
  created_at: EpochMs,
  last_activity_at: EpochMs,
  closed_at: EpochMs.nullable(),
  closed_reason: ClosedReason.nullable(),
  archived_at: EpochMs.nullable(),
  lease_expires_at: EpochMs,
  lease_paused_at: EpochMs.nullable(),
  lease_remaining_ms: DurationMs,
  state: SessionStatus,
  live: z.boolean(),
  disable_evaluate: z.boolean(),
  vault_enabled: z.boolean(),
  stealth: z.boolean(),
  fingerprint: z.boolean(),
  humanize: z.boolean(),
  stealth_recorded: z.boolean(),
  identity: AppliedIdentity.nullable(),
  proxy_label: z.string().nullable(),
  counts: SessionCounts,
  has_live_viewers: z.boolean(),
  client: SessionClient.nullable(),
});
/** The one session shape used by lists, detail and WS. */
export type SessionSummary = z.infer<typeof SessionSummary>;

/** Session list view presets. `all` = everything not archived. */
export const SessionView = z.enum(['all', 'live', 'closed', 'archived']);
/** Session list view presets. */
export type SessionView = z.infer<typeof SessionView>;

/** Archived-row handling for the session list. */
export const ArchivedFilter = z.enum(['exclude', 'include', 'only']);
/** Archived-row handling for the session list. */
export type ArchivedFilter = z.infer<typeof ArchivedFilter>;

/** Sort keys accepted by `GET /sessions`. */
export const SessionSortKey = sortable([
  'created_at',
  'slug',
  'channel',
  'last_activity_at',
  'errors',
  'lease_expires_at',
  'closed_at',
  'owner',
  'persistence_mode',
  'blocked',
]);
/** Sort keys accepted by `GET /sessions`. */
export type SessionSortKey = z.infer<typeof SessionSortKey>;

/** `GET /sessions` query. */
export const SessionsQuery = listQuery({
  sort: SessionSortKey.default('created_at'),
  filters: {
    state: csv(SessionStatus),
    view: SessionView.default('all'),
    archived: ArchivedFilter.default('exclude'),
    owner: z.string().min(1).max(128).optional(),
    channel: csv(Channel),
    persistence_mode: csv(PersistenceMode),
    q: QueryText.optional(),
    ...windowQuery,
  },
});
/** `GET /sessions` query. */
export type SessionsQuery = z.infer<typeof SessionsQuery>;

/** Facets returned with the session list (always present, counts respect the WHERE). */
export const SessionFacets = z.object({
  owners: z.array(Facet),
  channels: z.array(Facet),
  persistence_modes: z.array(Facet),
  states: z.array(Facet),
});
/** Facets returned with the session list. */
export type SessionFacets = z.infer<typeof SessionFacets>;

/** `GET /sessions` body: `Page<SessionSummary>` with typed facets. */
export const SessionsPage = page(SessionSummary).extend({ facets: SessionFacets });
/** `GET /sessions` body. */
export type SessionsPage = z.infer<typeof SessionsPage>;

/** Trace artifact descriptor embedded in the session detail. */
export const SessionTraceSummary = z.object({
  enabled: z.boolean(),
  path: z.string().nullable(),
  viewer_available: z.boolean(),
  size_bytes: Bytes.optional(),
});
/** Trace artifact descriptor embedded in the session detail. */
export type SessionTraceSummary = z.infer<typeof SessionTraceSummary>;

/** Where the session's on-disk data lives. */
export const SessionDataDir = z.object({ path: z.string(), persistent: z.boolean() });
/** Where the session's on-disk data lives. */
export type SessionDataDir = z.infer<typeof SessionDataDir>;

/** `GET /sessions/{session_id}` body (no embedded arrays; sub-collections are separate routes). */
export const SessionDetail = z.object({
  session: SessionSummary,
  trace: SessionTraceSummary,
  data_dir: SessionDataDir,
  counts: SessionCounts,
  now: EpochMs,
});
/** `GET /sessions/{session_id}` body. */
export type SessionDetail = z.infer<typeof SessionDetail>;

/** @module contracts/http/system — system info, config provenance, realtime, log level, degradations (spec 03 §4.7) */
import { z } from 'zod';
import {
  AuthMode,
  Channel,
  DegradationSeverity,
  ProvenanceSource,
  SandboxMode,
  Transport,
} from '../enums/index.ts';
import { ConnectionId, SessionId } from '../ids/index.ts';
import { Bytes, Count, csv, DurationMs, EpochMs, listQuery, page, sortable } from './common.ts';

/** One degradation row (`system_events`, spec 10 §3), aggregated by code + details fingerprint. */
export const SystemEvent = z.object({
  event_id: z.string(),
  code: z.string(),
  severity: DegradationSeverity,
  message: z.string(),
  details: z.unknown().nullable(),
  first_seen_at: EpochMs,
  last_seen_at: EpochMs,
  count: Count,
  resolved_at: EpochMs.nullable(),
});
/** One degradation row. */
export type SystemEvent = z.infer<typeof SystemEvent>;

/** One applied schema migration. */
export const MigrationRow = z.object({
  version: z.number().int().positive(),
  name: z.string(),
  applied_at: EpochMs,
  duration_ms: DurationMs,
  app_version: z.string(),
});
/** One applied schema migration. */
export type MigrationRow = z.infer<typeof MigrationRow>;

/** Session capacity; `max` is `null` when unbounded. */
export const SystemCapacity = z.object({
  live: Count,
  max: Count.nullable(),
  max_source: z.enum(['config', 'derived']),
});
/** Session capacity. */
export type SystemCapacity = z.infer<typeof SystemCapacity>;

/** Retention sweep status (`/system.retention`). */
export const RetentionStatus = z.object({
  days: z.number().int().positive(),
  bytes: Bytes,
  last_run_at: EpochMs.nullable(),
  last_result: z.enum(['ok', 'partial', 'failed']).nullable(),
  next_run_at: EpochMs.nullable(),
  pruned_rows: Count,
  artifacts_pending: Count,
});
/** Retention sweep status. */
export type RetentionStatus = z.infer<typeof RetentionStatus>;

/** Storage status (`/system.storage`). */
export const StorageStatus = z.object({
  db_bytes: Bytes,
  schema_version: z.number().int().nonnegative(),
  min_reader_version: z.number().int().nonnegative(),
  migrations: z.array(MigrationRow),
  dropped_writes_total: Count,
  write_queue_depth: Count,
  last_backup_at: EpochMs.nullable(),
  backups_count: Count,
});
/** Storage status. */
export type StorageStatus = z.infer<typeof StorageStatus>;

/** Runtime and browser engine versions reported by `/system` and `browserhive version`. */
export const RuntimeVersions = z.object({
  bun: z.string(),
  sqlite: z.string(),
  playwright: z.string(),
  patchright: z.string().nullable(),
  chromium: z.string().nullable(),
});
/** Runtime versions. */
export type RuntimeVersions = z.infer<typeof RuntimeVersions>;

/** One browser channel as the server sees it: where it is, its version, and its sandbox verdict. */
export const SystemBrowserChannel = z.object({
  channel: Channel,
  /** `Chrome for Testing`, `Google Chrome` or `Microsoft Edge`. */
  label: z.string(),
  /** `bundled` (downloaded by `browserhive init`, pinned) or `installed` (the OS's, updates itself). */
  source: z.enum(['bundled', 'installed']),
  installed: z.boolean(),
  version: z.string().nullable(),
  executable: z.string().nullable(),
  /** `sandboxed` / `unavailable` once a launch or the boot check decided; `unknown` before. */
  sandbox: z.enum(['sandboxed', 'unavailable', 'unknown']),
  /** Chrome's own reason when `unavailable`. */
  sandbox_reason: z.string().nullable(),
});
/** One browser channel on `/system`. */
export type SystemBrowserChannel = z.infer<typeof SystemBrowserChannel>;

/** Browser choice and sandbox state (`GET /system`). */
export const SystemBrowser = z.object({
  default_channel: Channel,
  /** The `sandbox` setting. */
  sandbox_mode: SandboxMode,
  /** Chrome refuses the sandbox as root; under `auto` it is not attempted. */
  running_as_root: z.boolean(),
  channels: z.array(SystemBrowserChannel),
});
/** Browser choice and sandbox state. */
export type SystemBrowser = z.infer<typeof SystemBrowser>;

/** `GET /system` body. */
export const SystemInfo = z.object({
  version: z.string(),
  runtime: RuntimeVersions,
  data_dir: z.string(),
  mcp: z.object({ connections: Count }),
  transport: Transport,
  uptime_ms: DurationMs,
  started_at: EpochMs,
  host: z.string(),
  port: z.number().int().min(0).max(65_535),
  admin: z.boolean(),
  /** `auth` config key: `token` requires a bearer on `/mcp`; `off` serves the local principal. */
  auth_mode: AuthMode,
  capacity: SystemCapacity,
  open_attention: Count,
  active_screencasts: Count,
  realtime: z.object({ connections: Count }),
  allow_evaluate: z.boolean(),
  persistence_mode: z.string(),
  stealth: z.object({
    profile: z.string(),
    driver: z.string(),
    fingerprint: z.boolean(),
    humanize: z.boolean(),
    captcha: z.string(),
  }),
  /** Browsers on this host and the sandbox state; absent from servers older than this field. */
  browser: SystemBrowser.optional(),
  vault: z.object({ enabled: z.boolean(), backend: z.string().nullable() }),
  blocklist: z.object({ configured: z.boolean(), path: z.string().nullable(), patterns: Count }),
  retention: RetentionStatus,
  storage: StorageStatus,
  otel: z.object({
    enabled: z.boolean(),
    endpoint: z.string().nullable(),
    protocol: z.string().nullable(),
  }),
  degradations: z.array(SystemEvent),
  now: EpochMs,
});
/** `GET /system` body. */
export type SystemInfo = z.infer<typeof SystemInfo>;

/** Redaction marker used for secret config values. */
export const REDACTED = '[REDACTED]';

/** One resolved config key with provenance; `shadowed` lists lower-precedence values that lost. */
export const SystemConfigKey = z.object({
  key: z.string(),
  value: z.unknown(),
  source: ProvenanceSource,
  shadowed: z.array(z.object({ source: ProvenanceSource, value: z.unknown() })),
  secret: z.boolean(),
});
/** One resolved config key with provenance. */
export type SystemConfigKey = z.infer<typeof SystemConfigKey>;

/** `GET /system/config` body. */
export const SystemConfigResponse = z.object({ keys: z.array(SystemConfigKey) });
/** `GET /system/config` body. */
export type SystemConfigResponse = z.infer<typeof SystemConfigResponse>;

/** One live realtime connection (`GET /system/realtime`). */
export const RealtimeConnection = z.object({
  connection_id: ConnectionId,
  principal: z.string(),
  connected_at: EpochMs,
  last_seen_at: EpochMs,
  topics: z.array(z.string()),
  screencasts: z.array(SessionId),
  buffered_bytes: Bytes,
  dropped_frames: Count,
  messages_out: Count,
});
/** One live realtime connection. */
export type RealtimeConnection = z.infer<typeof RealtimeConnection>;

/** `GET /system/realtime` body. */
export const SystemRealtimeResponse = z.object({ connections: z.array(RealtimeConnection) });
/** `GET /system/realtime` body. */
export type SystemRealtimeResponse = z.infer<typeof SystemRealtimeResponse>;

/** Per-module log level spec grammar: `info` or `info,sessions=debug,persistence=trace`. */
export const LOG_LEVEL_SPEC_RE =
  /^(error|warn|info|debug|trace)(,[a-z][a-z0-9-]*=(error|warn|info|debug|trace))*$/;

/** `PATCH /system/log-level` body. */
export const SetLogLevelRequest = z.strictObject({
  spec: z.string().trim().max(512).regex(LOG_LEVEL_SPEC_RE, 'invalid log level spec'),
});
/** `PATCH /system/log-level` body. */
export type SetLogLevelRequest = z.infer<typeof SetLogLevelRequest>;

/** `PATCH /system/log-level` 200 body; `effective` is the normalised spec now in force. */
export const SetLogLevelResponse = z.object({ ok: z.literal(true), effective: z.string() });
/** `PATCH /system/log-level` 200 body. */
export type SetLogLevelResponse = z.infer<typeof SetLogLevelResponse>;

/** `GET /system/events` query. */
export const SystemEventsQuery = listQuery({
  sort: sortable(['last_seen_at', 'first_seen_at', 'count']).default('last_seen_at'),
  filters: {
    since: EpochMs.optional(),
    severity: csv(DegradationSeverity),
    resolved: z.enum(['all', 'open', 'resolved']).default('open'),
  },
});
/** `GET /system/events` query. */
export type SystemEventsQuery = z.infer<typeof SystemEventsQuery>;

/** `GET /system/events` body. */
export const SystemEventsPage = page(SystemEvent);
/** `GET /system/events` body. */
export type SystemEventsPage = z.infer<typeof SystemEventsPage>;

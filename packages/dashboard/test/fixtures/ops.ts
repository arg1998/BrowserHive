/** @module dashboard/test/fixtures/ops — wire fixtures for the ops pages (system, activity, pages, blocklist, logs, notifications), shaped by the contracts schemas */
import type {
  ActivityResponse,
  BlockedRequestRow,
  BlocklistOverview,
  FleetPageRow,
  LogRecord,
  Notification,
  SystemConfigResponse,
  SystemInfo,
} from '@browserhive/contracts/http';

/** Fixed server time for fixtures. */
export const NOW = 1_700_000_000_000;

/** A session id matching the contracts grammar. */
export const SESSION_ID = 'shop-a1b2c3d4';

/** `GET /system`. */
export function systemInfo(patch: Partial<SystemInfo> = {}): SystemInfo {
  return {
    auth_mode: 'token',
    version: '0.1.0',
    runtime: {
      bun: '1.4.2',
      sqlite: '3.53.2',
      playwright: '1.63.0',
      patchright: '1.63.0',
      chromium: '141.0.7390.37',
    },
    data_dir: '/home/op/.local/share/browserhive',
    mcp: { connections: 1 },
    transport: 'http',
    uptime_ms: 3_600_000,
    started_at: NOW - 3_600_000,
    host: '127.0.0.1',
    port: 9876,
    admin: true,
    capacity: { live: 2, max: 8, max_source: 'config' },
    open_attention: 1,
    active_screencasts: 0,
    realtime: { connections: 1 },
    allow_evaluate: false,
    persistence_mode: 'memory',
    stealth: {
      profile: 'standard',
      driver: 'patchright',
      fingerprint: false,
      humanize: true,
      captcha: 'attention',
    },
    vault: { enabled: false, backend: null },
    blocklist: { configured: true, path: '/etc/bh/blocklist.txt', patterns: 3 },
    retention: {
      days: 14,
      bytes: 1_000_000,
      last_run_at: NOW - 60_000,
      last_result: 'ok',
      next_run_at: NOW + 3_600_000,
      pruned_rows: 12,
      artifacts_pending: 0,
    },
    storage: {
      db_bytes: 500_000,
      schema_version: 1,
      min_reader_version: 1,
      migrations: [
        {
          version: 1,
          name: 'initial',
          applied_at: NOW - 86_400_000,
          duration_ms: 12,
          app_version: '0.1.0',
        },
      ],
      dropped_writes_total: 0,
      write_queue_depth: 0,
      last_backup_at: null,
      backups_count: 0,
    },
    otel: { enabled: false, endpoint: null, protocol: null },
    degradations: [],
    now: NOW,
    ...patch,
  };
}

/** `GET /activity`. */
export function activity(): ActivityResponse {
  const bucketMs = 6 * 3_600_000;
  const buckets = [0, 1, 2, 3].map((i) => ({
    ts: NOW - (4 - i) * bucketMs,
    tool_calls: 10 + i,
    errors: i === 3 ? 2 : 0,
    sessions_started: i === 0 ? 1 : 0,
    sessions_closed: 0,
    blocked: 0,
    attention: 0,
  }));
  return {
    buckets,
    summary: {
      sessions_total: 40,
      sessions_live: 2,
      sessions_window: 7,
      tool_calls_window: 46,
      tool_calls_total: 900,
      errors_window: 2,
      errors_total: 30,
      blocked_window: 0,
      blocked_total: 0,
      attention_open: 1,
      active_screencasts: 0,
    },
    window: { since: NOW - 7 * 86_400_000, until: NOW, bucket_ms: bucketMs },
    now: NOW,
  };
}

/** One page visit. */
export function pageRow(i: number, patch: Partial<FleetPageRow> = {}): FleetPageRow {
  return {
    event_id: `e-01HZX${String(i).padStart(21, '0')}` as FleetPageRow['event_id'],
    session_id: SESSION_ID as FleetPageRow['session_id'],
    session_slug: 'shop',
    tab_id: 't-abc123' as FleetPageRow['tab_id'],
    url: `https://example${i}.com/path`,
    title: null,
    domain: `example${i}.com`,
    category: 'public',
    ts: NOW - i * 1000,
    ...patch,
  };
}

/** `GET /blocklist`. */
export function blocklistOverview(patch: Partial<BlocklistOverview> = {}): BlocklistOverview {
  return {
    configured: true,
    path: '/etc/bh/blocklist.txt',
    loaded_at: NOW - 1000,
    patterns: [
      { pattern: 'ads.example.com', line: 1, hits: 4, last_ts: NOW - 5000 },
      { pattern: '*.tracker.net', line: 2, hits: 0, last_ts: null },
    ],
    skipped: [],
    stats: {
      attempts: 4,
      sessions: 1,
      domains: 1,
      total_all_time: 9,
      top_patterns: [{ pattern: 'ads.example.com', count: 4 }],
      top_domains: [{ domain: 'ads.example.com', count: 4 }],
    },
    window: { since: NOW - 7 * 86_400_000, until: NOW },
    now: NOW,
    ...patch,
  };
}

/** One blocked request. */
export function blockedRow(i: number): BlockedRequestRow {
  return {
    event_id: `e-01HZY${String(i).padStart(21, '0')}` as BlockedRequestRow['event_id'],
    session_id: SESSION_ID as BlockedRequestRow['session_id'],
    session_slug: 'shop',
    tool_event_id: null,
    url: 'https://ads.example.com/pixel.gif',
    domain: 'ads.example.com',
    pattern: 'ads.example.com',
    source: 'request',
    tool: null,
    ts: NOW - i * 1000,
  };
}

/** One log record. */
export function logRecord(seq: number, patch: Partial<LogRecord> = {}): LogRecord {
  return {
    seq,
    ts: NOW + seq,
    level: 'info',
    msg: `record ${seq}`,
    module: 'sessions',
    ...patch,
  };
}

/** `GET /system/config`. */
export function systemConfig(): SystemConfigResponse {
  return {
    keys: [
      {
        key: 'port',
        value: 9876,
        source: 'cli',
        shadowed: [{ source: 'env', value: 9000 }],
        secret: false,
      },
      { key: 'authTokens', value: '[REDACTED]', source: 'file', shadowed: [], secret: true },
      {
        key: 'logLevel',
        value: { root: 'info', modules: { sessions: 'debug' } },
        source: 'default',
        shadowed: [],
        secret: false,
      },
      {
        key: 'otelTraceUrlTemplate',
        value: 'https://apm.test/trace/{trace_id}',
        source: 'env',
        shadowed: [],
        secret: false,
      },
    ],
  };
}

/** One notification. */
export function notification(i: number, patch: Partial<Notification> = {}): Notification {
  return {
    notification_id: `n-${String(i).padStart(12, '0')}` as Notification['notification_id'],
    principal_id: null,
    type: 'error',
    title: `Tool error · navigate ${i}`,
    body: 'NAVIGATION_FAILED (120 ms)',
    session_id: null,
    session_slug: null,
    target: null,
    source_event_id: null,
    created_at: NOW - i * 60_000,
    updated_at: NOW - i * 60_000,
    count: 1,
    read_at: null,
    dismissed_at: null,
    ...patch,
  };
}

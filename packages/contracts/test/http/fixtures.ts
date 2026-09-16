/** @module contracts/test/http/fixtures — canonical wire fixtures shared by DTO, endpoint and WS golden tests */
import type { z } from 'zod';
import type {
  BlockedRequestRow,
  LogRecord,
  Notification,
  OperatorRequestRow,
  PageRow,
  page,
  ScreenshotRow,
  SessionSummary,
  SystemEvent,
  ToolCallRow,
  VaultAccessRow,
  VaultBinding,
  VaultGroupPolicy,
} from '../../src/http/index.ts';

/** Fixed clock for every fixture (2025-01-01T00:00:00Z). */
export const NOW = 1_735_689_600_000;
export const SESSION_ID = 'shop-a1b2c3d4';
export const TAB_ID = 't-x7k2m9';
export const EVENT_ID = 'e-01J8XW3N5Q4R6T8V0Y2Z4A6C8E';
export const EVENT_ID_2 = 'e-01J8XW3N5Q4R6T8V0Y2Z4A6C8F';
export const REQUEST_ID = 'a-k3j4h5g6f7d8';
export const NOTIFICATION_ID = 'n-k3j4h5g6f7d8';
export const CONNECTION_ID = 'c-k3j4h5g6f7';

/** Input shape of a zod schema (what the wire carries before branding). */
type Input<S extends z.ZodType> = z.input<S>;

export const sessionSummary = (): Input<typeof SessionSummary> => ({
  session_id: SESSION_ID,
  slug: 'shop',
  owner: 'p-k3j4h5g6f7d8',
  tenant_id: null,
  channel: 'chromium',
  engine: 'chromium',
  headless: true,
  incognito: false,
  persistence_mode: 'memory',
  current_url: 'https://example.com/',
  created_at: NOW - 60_000,
  last_activity_at: NOW - 1_000,
  closed_at: null,
  closed_reason: null,
  archived_at: null,
  lease_expires_at: NOW + 600_000,
  lease_paused_at: null,
  lease_remaining_ms: 600_000,
  state: 'live',
  live: true,
  disable_evaluate: false,
  vault_enabled: true,
  stealth: true,
  fingerprint: true,
  humanize: true,
  stealth_recorded: true,
  identity: { platform: 'Linux' },
  proxy_label: null,
  counts: { tool_calls: 3, errors: 1, pages: 2, blocked: 0, attention_open: 0, vault_access: 0 },
  has_live_viewers: false,
  client: { name: 'claude-code', version: '1.0.0', agent_name: 'agent' },
});

export const toolCallRow = (): Input<typeof ToolCallRow> => ({
  event_id: EVENT_ID,
  session_id: SESSION_ID,
  tool: 'navigate',
  tab_id: TAB_ID,
  ok: true,
  error_code: null,
  error_message: null,
  duration_ms: 420,
  result_size_bytes: 128,
  ts: NOW - 5_000,
  trace_id: 'abcdef0123456789abcdef0123456789',
  has_screenshot: false,
});

export const pageRow = (): Input<typeof PageRow> => ({
  event_id: EVENT_ID,
  session_id: SESSION_ID,
  tab_id: TAB_ID,
  url: 'https://example.com/',
  title: 'Example',
  domain: 'example.com',
  category: 'public',
  ts: NOW - 5_000,
});

export const screenshotRow = (): Input<typeof ScreenshotRow> => ({
  event_id: EVENT_ID_2,
  session_id: SESSION_ID,
  tool: 'screenshot',
  kind: 'tool',
  content_type: 'image/png',
  width: 1280,
  height: 720,
  size_bytes: 40_960,
  ts: NOW - 4_000,
  url: `/api/v1/sessions/${SESSION_ID}/screenshots/${EVENT_ID_2}`,
});

export const operatorRequestRow = (): Input<typeof OperatorRequestRow> => ({
  request_id: REQUEST_ID,
  kind: 'attention',
  session_id: SESSION_ID,
  session_slug: 'shop',
  owner: 'p-k3j4h5g6f7d8',
  reason: 'captcha',
  mode: 'takeover',
  options: { hint: 'solve the puzzle' },
  status: 'pending',
  message: null,
  resolved_by: null,
  resolution_reason: null,
  created_at: NOW - 3_000,
  resolved_at: null,
  deadline_at: NOW + 297_000,
  waited_ms: null,
  page_url: 'https://example.com/login',
  tool: 'request_attention',
  event_id: EVENT_ID,
  entry_name: null,
});

export const vaultAccessRow = (): Input<typeof VaultAccessRow> => ({
  event_id: EVENT_ID,
  session_id: SESSION_ID,
  session_slug: 'shop',
  tool_event_id: EVENT_ID,
  entry_name: 'Example Login',
  handle: 'work.example-login',
  result: 'success',
  reason: null,
  evaluate_enabled: false,
  page_url: 'https://example.com/login',
  origin_check: 'pass',
  principal_id: 'p-k3j4h5g6f7d8',
  details: null,
  ts: NOW - 2_000,
});

export const blockedRequestRow = (): Input<typeof BlockedRequestRow> => ({
  event_id: EVENT_ID,
  session_id: SESSION_ID,
  session_slug: 'shop',
  tool_event_id: EVENT_ID,
  url: 'https://ads.example.net/pixel',
  domain: 'ads.example.net',
  pattern: '*.example.net',
  source: 'request',
  tool: null,
  ts: NOW - 1_500,
});

export const systemEvent = (): Input<typeof SystemEvent> => ({
  event_id: EVENT_ID,
  code: 'RETENTION_FAILED',
  severity: 'error',
  message: 'retention sweep failed',
  details: { table: 'events' },
  first_seen_at: NOW - 100_000,
  last_seen_at: NOW - 1_000,
  count: 2,
  resolved_at: null,
});

export const notification = (): Input<typeof Notification> => ({
  notification_id: NOTIFICATION_ID,
  principal_id: 'p-k3j4h5g6f7d8',
  type: 'attention',
  title: 'Attention requested',
  body: 'captcha · takeover — agent blocked, lease frozen',
  session_id: SESSION_ID,
  session_slug: SESSION_ID.slice(0, -9),
  target: `/sessions/${SESSION_ID}?tab=live`,
  source_event_id: REQUEST_ID,
  created_at: NOW - 3_000,
  updated_at: NOW - 3_000,
  count: 1,
  read_at: null,
  dismissed_at: null,
});

export const logRecord = (): Input<typeof LogRecord> => ({
  seq: 42,
  ts: NOW - 500,
  level: 'info',
  msg: 'session opened',
  module: 'sessions',
  session_id: SESSION_ID,
  slug: 'shop',
});

export const vaultBinding = (): Input<typeof VaultBinding> => ({
  handle: 'work.example-login',
  title: 'Example login',
  item_name: 'Example Login',
  item_id: 'item-1',
  group_id: 'grp-1',
  allowed_origins: ['https://example.com'],
  authorized_principals: [],
  authorized_session_slugs: ['shop*'],
  allow_all_sessions: false,
  redact_username: false,
  require_no_evaluate: true,
  dashboard_confirm: true,
  created_at: NOW - 86_400_000,
  updated_at: NOW - 3_600_000,
  version: 2,
});

export const vaultGroupPolicy = (): Input<typeof VaultGroupPolicy> => ({
  group_id: 'grp-1',
  access_mode: 'manual',
  allow_all_sessions: false,
  session_slug_globs: ['shop*'],
  authorized_principals: [],
  dashboard_confirm: true,
  require_no_evaluate: false,
  redact_username: false,
  version: 1,
  created_at: NOW - 86_400_000,
  updated_at: NOW - 86_400_000,
});

/** Wrap items in the spec 03 §5 collection envelope. */
export function envelope<T>(items: readonly T[], sortKey = 'ts'): z.input<ReturnType<typeof page>> {
  return {
    data: [...items],
    page: { next_cursor: null, limit: 50 },
    applied: { filters: {}, sort: { key: sortKey, dir: 'desc' } },
    meta: { now: NOW },
  };
}

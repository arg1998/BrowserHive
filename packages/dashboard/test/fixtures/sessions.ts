/** @module dashboard/test/fixtures/sessions — typed builders for session DTOs, detail, timeline items and tool calls used by the sessions page tests */
import type {
  OperatorRequestRow,
  PageRow,
  SessionDetail,
  SessionSummary,
  SessionsPage,
  TimelineItem,
  ToolCallDetail,
  ToolCallRow,
} from '@browserhive/contracts/http';
import { EventId, SessionId } from '@browserhive/contracts/ids';

/** Server clock used by fixtures. */
export const T0 = 1_700_000_000_000;

/** A valid session id for index `i`. */
export function sid(i: number): SessionId {
  return SessionId.parse(`shop-${String(i).padStart(8, '0')}`);
}

/** A valid event id for index `i`. */
export function eid(i: number): EventId {
  return EventId.parse(`e-01HZX${String(i).padStart(21, '0')}`);
}

/** Session summary. */
export function sessionSummary(i: number, patch: Partial<SessionSummary> = {}): SessionSummary {
  return {
    session_id: sid(i),
    slug: 'shop',
    owner: 'claude',
    tenant_id: null,
    channel: 'chromium',
    engine: 'chromium',
    headless: true,
    incognito: false,
    persistence_mode: 'memory',
    current_url: `https://example${i}.com/cart`,
    created_at: T0 - 60_000 * i,
    last_activity_at: T0 - 1000,
    closed_at: null,
    closed_reason: null,
    archived_at: null,
    lease_expires_at: T0 + 30 * 60_000,
    lease_paused_at: null,
    lease_remaining_ms: 30 * 60_000,
    state: 'live',
    live: true,
    disable_evaluate: false,
    vault_enabled: false,
    stealth: true,
    fingerprint: true,
    humanize: false,
    stealth_recorded: true,
    identity: null,
    proxy_label: null,
    counts: { tool_calls: 12, errors: 1, pages: 3, blocked: 0, attention_open: 0, vault_access: 0 },
    has_live_viewers: false,
    client: { name: 'claude-code', version: '1.0.0' },
    ...patch,
  };
}

/** Sessions page envelope with facets. */
export function sessionsPage(
  rows: readonly SessionSummary[],
  nextCursor: string | null = null,
): SessionsPage {
  return {
    data: [...rows],
    page: { next_cursor: nextCursor, limit: 25, total: rows.length },
    applied: { filters: {}, sort: { key: 'created_at', dir: 'desc' } },
    meta: { now: T0 },
    facets: {
      owners: [{ value: 'claude', count: rows.length }],
      channels: [
        { value: 'chromium', count: rows.length },
        { value: 'chrome', count: 0 },
      ],
      persistence_modes: [{ value: 'memory', count: rows.length }],
      states: [{ value: 'live', count: rows.filter((r) => r.live).length }],
    },
  };
}

/** Session detail. */
export function sessionDetail(patch: Partial<SessionSummary> = {}): SessionDetail {
  const session = sessionSummary(1, patch);
  return {
    session,
    trace: {
      enabled: true,
      path: '/data/shop/trace.zip',
      viewer_available: true,
      size_bytes: 2048,
    },
    data_dir: { path: '/data/sessions/shop-00000001', persistent: false },
    counts: session.counts,
    now: T0,
  };
}

/** Tool call row. */
export function toolCall(i: number, patch: Partial<ToolCallRow> = {}): ToolCallRow {
  return {
    event_id: eid(i),
    session_id: sid(1),
    tool: 'navigate',
    tab_id: null,
    ok: true,
    error_code: null,
    error_message: null,
    duration_ms: 120 + i,
    result_size_bytes: 512,
    ts: T0 - i * 1000,
    trace_id: null,
    has_screenshot: false,
    ...patch,
  };
}

/** Tool call detail. */
export function toolCallDetail(i: number, patch: Partial<ToolCallDetail> = {}): ToolCallDetail {
  return {
    ...toolCall(i),
    args_json: { url: 'https://example.com' },
    result_text: '{"ok":true}',
    ...patch,
  };
}

/** Timeline tool item. */
export function toolItem(i: number, patch: Partial<ToolCallRow> = {}): TimelineItem {
  const row = toolCall(i, patch);
  return { id: `tool:${row.event_id}`, kind: 'tool', ts: row.ts, seq: i, row };
}

/** Page visit row (same `event_id` as tool call `i` by default, like a navigate). */
export function pageRow(i: number, patch: Partial<PageRow> = {}): PageRow {
  return {
    event_id: eid(i),
    session_id: sid(1),
    tab_id: 't-abc123' as PageRow['tab_id'],
    url: `https://example.com/page-${i}`,
    title: `Example page ${i}`,
    domain: 'example.com',
    category: 'public',
    ts: T0 - i * 1000,
    ...patch,
  };
}

/** Timeline page item. */
export function pageItem(i: number, patch: Partial<PageRow> = {}): TimelineItem {
  const row = pageRow(i, patch);
  return { id: `page:${row.event_id}`, kind: 'page', ts: row.ts, seq: 0, row };
}

/** Operator (attention) request row. */
export function attentionRequest(patch: Partial<OperatorRequestRow> = {}): OperatorRequestRow {
  return {
    request_id: 'r-01HZX000000000000000000001' as OperatorRequestRow['request_id'],
    kind: 'attention',
    session_id: sid(1),
    session_slug: 'shop',
    owner: 'claude',
    reason: 'A CAPTCHA blocks the login form. Please solve it.',
    mode: 'takeover',
    options: null,
    status: 'pending',
    message: null,
    resolved_by: null,
    resolution_reason: null,
    created_at: T0 - 30_000,
    resolved_at: null,
    deadline_at: T0 + 30 * 60_000,
    waited_ms: null,
    page_url: 'https://example.com/login',
    tool: null,
    event_id: null,
    entry_name: null,
    ...patch,
  };
}

/** Timeline attention item (`request_attention` request). */
export function attentionItem(patch: Partial<OperatorRequestRow> = {}): TimelineItem {
  const row = attentionRequest(patch);
  return { id: `attention:${row.request_id}`, kind: 'attention', ts: row.created_at, seq: 0, row };
}

/** Timeline envelope. */
export function timelinePage(items: readonly TimelineItem[], nextCursor: string | null = null) {
  return {
    data: [...items],
    page: { next_cursor: nextCursor, limit: 100 },
    applied: { filters: {}, sort: { key: 'ts', dir: 'desc' } },
    meta: { now: T0 },
  };
}

/** Resize the happy-dom window (responsive smoke tests). */
export function setViewport(width: number, height: number): void {
  const happyDom: unknown = Reflect.get(window, 'happyDOM');
  if (typeof happyDom === 'object' && happyDom !== null && 'setViewport' in happyDom) {
    const fn = happyDom.setViewport;
    if (typeof fn === 'function') fn.call(happyDom, { width, height });
  }
}

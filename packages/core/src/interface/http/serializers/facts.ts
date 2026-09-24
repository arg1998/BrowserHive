/** @module interface/http/serializers/facts — tool call, page, screenshot, blocked-request and vault-access rows → wire DTOs, and their list queries (spec 03 §4.2–4.6). */

import type {
  BlockedAttemptsQuery,
  BlockedRequestRow,
  FleetPageRow,
  FleetToolCallRow,
  PageRow,
  PagesQuery,
  ScreenshotRow,
  SessionPagesQuery,
  SessionScreenshotsQuery,
  SessionToolCallsQuery,
  ToolCallRow,
  ToolCallsQuery,
  VaultAccessRow,
  VaultLogQuery,
} from '@browserhive/contracts/http';
import type { z } from 'zod';
import { toVaultAccessRow } from '../../../domain/vault/events.ts';
import type { BlockedRequestListRow } from '../../../ports/persistence/blocklist-audit.ts';
import type { PageListRow } from '../../../ports/persistence/pages.ts';
import type {
  BlockedRequestListQuery,
  PageListQuery,
  ScreenshotListQuery,
  ToolCallListQuery,
  VaultAccessListQuery,
} from '../../../ports/persistence/queries.ts';
import type { ScreenshotListRow } from '../../../ports/persistence/screenshots.ts';
import type { ToolCallListRow } from '../../../ports/persistence/tool-calls.ts';
import type { VaultAccessListRow } from '../../../ports/persistence/vault-audit.ts';
import { pagingOf } from './page.ts';

/** Tool call row; `detail` adds `args_json`/`result_text` (`?expand=detail`). */
export function toolCallToWire(row: ToolCallListRow, detail: boolean): z.input<typeof ToolCallRow> {
  return {
    event_id: row.eventId,
    session_id: row.sessionId,
    tool: row.tool,
    tab_id: row.tabId,
    ok: row.ok,
    error_code: row.errorCode,
    error_message: row.errorMessage,
    duration_ms: row.durationMs,
    result_size_bytes: row.resultSizeBytes,
    ts: row.ts,
    trace_id: row.traceId,
    has_screenshot: row.hasScreenshot,
    harness: row.harness,
    ...(detail && { args_json: row.args, result_text: row.resultText }),
  };
}

/** Fleet tool call row (adds the slug). */
export function fleetToolCallToWire(
  row: ToolCallListRow,
  detail: boolean,
): z.input<typeof FleetToolCallRow> {
  return { ...toolCallToWire(row, detail), session_slug: row.sessionSlug };
}

/** Page visit row. */
export function pageToWire(row: PageListRow): z.input<typeof PageRow> {
  return {
    event_id: row.eventId,
    session_id: row.sessionId,
    tab_id: row.tabId,
    url: row.url,
    title: row.title,
    domain: row.domain,
    category: row.category,
    ts: row.ts,
  };
}

/** Fleet page row. */
export function fleetPageToWire(row: PageListRow): z.input<typeof FleetPageRow> {
  return { ...pageToWire(row), session_slug: row.sessionSlug };
}

/** The grant-enabled image URL of a screenshot. */
export function screenshotUrl(sessionId: string, eventId: string): string {
  return `/api/v1/sessions/${encodeURIComponent(sessionId)}/screenshots/${encodeURIComponent(eventId)}`;
}

/** Screenshot row. */
export function screenshotToWire(row: ScreenshotListRow): z.input<typeof ScreenshotRow> {
  return {
    event_id: row.eventId,
    session_id: row.sessionId,
    tool: row.tool ?? '',
    kind: row.kind,
    content_type: row.contentType,
    width: row.width,
    height: row.height,
    size_bytes: row.sizeBytes,
    ts: row.ts,
    url: screenshotUrl(row.sessionId, row.eventId),
  };
}

/** Blocked request row. */
export function blockedToWire(row: BlockedRequestListRow): z.input<typeof BlockedRequestRow> {
  return {
    event_id: row.eventId,
    session_id: row.sessionId,
    session_slug: row.sessionSlug,
    tool_event_id: row.toolEventId,
    url: row.url,
    domain: row.domain,
    pattern: row.pattern,
    source: row.source,
    tool: row.tool,
    ts: row.ts,
  };
}

/** Vault access row (the domain projection, shared with the feed). */
export function vaultAccessToWire(row: VaultAccessListRow): z.input<typeof VaultAccessRow> {
  return toVaultAccessRow(row, row.sessionSlug);
}

type ToolCallsWireQuery = z.output<typeof SessionToolCallsQuery> | z.output<typeof ToolCallsQuery>;

/** Tool call list query → repository query. */
export function toolCallsQueryToRepo(
  query: ToolCallsWireQuery,
  sessionId?: string,
): ToolCallListQuery {
  const session = sessionId ?? ('session_id' in query ? query.session_id : undefined);
  return {
    ...pagingOf(query),
    sort: query.sort,
    ...(session !== undefined && { sessionId: session }),
    ...('has_session' in query &&
      query.has_session !== undefined && { hasSession: query.has_session }),
    ...(query.tool !== undefined && { tools: query.tool }),
    ...(query.ok !== undefined && { ok: query.ok }),
    ...(query.error_code !== undefined && { errorCodes: query.error_code }),
    ...('harness' in query && query.harness !== undefined && { harnesses: query.harness }),
    ...(query.q !== undefined && { q: query.q }),
    ...(query.since !== undefined && { since: query.since }),
    ...(query.until !== undefined && { until: query.until }),
  };
}

/** Page list query → repository query. */
export function pagesQueryToRepo(
  query: z.output<typeof PagesQuery> | z.output<typeof SessionPagesQuery>,
  sessionId?: string,
): PageListQuery {
  const session = sessionId ?? ('session_id' in query ? query.session_id : undefined);
  return {
    ...pagingOf(query),
    sort: query.sort,
    ...(session !== undefined && { sessionId: session }),
    ...(query.category !== undefined && { categories: query.category }),
    ...(query.domain !== undefined && { domain: query.domain }),
    ...('tab_id' in query && query.tab_id !== undefined && { tabId: query.tab_id }),
    ...(query.q !== undefined && { q: query.q }),
    ...('since' in query && query.since !== undefined && { since: query.since }),
    ...('until' in query && query.until !== undefined && { until: query.until }),
  };
}

/** Screenshot list query → repository query. */
export function screenshotsQueryToRepo(
  query: z.output<typeof SessionScreenshotsQuery>,
): ScreenshotListQuery {
  return { ...pagingOf(query), ...(query.kind !== undefined && { kinds: query.kind }) };
}

/** Blocked attempts query → repository query. */
export function blockedQueryToRepo(
  query: z.output<typeof BlockedAttemptsQuery>,
  sessionId?: string,
): BlockedRequestListQuery {
  const session = sessionId ?? query.session_id;
  return {
    ...pagingOf(query),
    sort: query.sort,
    ...(session !== undefined && { sessionId: session }),
    ...(query.pattern !== undefined && { pattern: query.pattern }),
    ...(query.domain !== undefined && { domain: query.domain }),
    ...(query.source !== undefined && { sources: query.source }),
    ...(query.q !== undefined && { q: query.q }),
    ...(query.since !== undefined && { since: query.since }),
    ...(query.until !== undefined && { until: query.until }),
  };
}

/** Vault log query → repository query. */
export function vaultLogQueryToRepo(
  query: z.output<typeof VaultLogQuery>,
  sessionId?: string,
): VaultAccessListQuery {
  const session = sessionId ?? query.session_id;
  return {
    ...pagingOf(query),
    sort: query.sort,
    ...(session !== undefined && { sessionId: session }),
    ...(query.result !== undefined && { results: query.result }),
    ...(query.origin_check !== undefined && { originChecks: query.origin_check }),
    ...(query.evaluate !== undefined && { evaluate: query.evaluate }),
    ...(query.entry_name !== undefined && { entryName: query.entry_name }),
    ...(query.q !== undefined && { q: query.q }),
    ...(query.since !== undefined && { since: query.since }),
    ...(query.until !== undefined && { until: query.until }),
  };
}

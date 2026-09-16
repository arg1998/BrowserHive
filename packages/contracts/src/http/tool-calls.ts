/** @module contracts/http/tool-calls — tool call rows, per-session and fleet queries (spec 03 §4.2–4.3) */
import { z } from 'zod';
import { EventId, SessionId, TabId } from '../ids/index.ts';
import { ScreenshotRow } from './artifacts.ts';
import {
  Bytes,
  csv,
  DurationMs,
  EpochMs,
  listQuery,
  page,
  QueryBool,
  QueryText,
  sortable,
  windowQuery,
} from './common.ts';

/** Tool name as recorded (frozen catalog; a plain string on the wire so rows recorded under a name outside the current catalog still parse). */
export const ToolName = z.string().min(1).max(64);

/** One recorded tool call (`tool_calls` row). `args_json`/`result_text` only with `?expand=detail`. */
export const ToolCallRow = z.object({
  event_id: EventId,
  session_id: SessionId.nullable(),
  tool: ToolName,
  tab_id: TabId.nullable(),
  ok: z.boolean(),
  error_code: z.string().nullable(),
  error_message: z.string().nullable(),
  duration_ms: DurationMs,
  result_size_bytes: Bytes,
  ts: EpochMs,
  trace_id: z.string().nullable(),
  has_screenshot: z.boolean(),
  args_json: z.unknown().optional(),
  result_text: z.string().nullable().optional(),
});
/** One recorded tool call. */
export type ToolCallRow = z.infer<typeof ToolCallRow>;

/** Tool call row in cross-session lists (adds the slug for labels). */
export const FleetToolCallRow = ToolCallRow.extend({ session_slug: z.string().nullable() });
/** Tool call row in cross-session lists. */
export type FleetToolCallRow = z.infer<typeof FleetToolCallRow>;

/** `GET …/tool-calls/{event_id}` body: full row plus its screenshot when one exists. */
export const ToolCallDetail = ToolCallRow.extend({
  args_json: z.unknown(),
  result_text: z.string().nullable(),
  screenshot: ScreenshotRow.optional(),
});
/** `GET …/tool-calls/{event_id}` body. */
export type ToolCallDetail = z.infer<typeof ToolCallDetail>;

/** Sort keys accepted by tool-call lists. */
export const ToolCallSortKey = sortable(['ts', 'duration_ms']);
/** Sort keys accepted by tool-call lists. */
export type ToolCallSortKey = z.infer<typeof ToolCallSortKey>;

const toolCallFilters = {
  tool: csv(ToolName),
  ok: QueryBool.optional(),
  error_code: csv(z.string().min(1).max(64)),
  q: QueryText.optional(),
  expand: z.enum(['detail']).optional(),
  ...windowQuery,
} as const;

/** `GET /sessions/{session_id}/tool-calls` query. */
export const SessionToolCallsQuery = listQuery({
  sort: ToolCallSortKey.default('ts'),
  filters: toolCallFilters,
});
/** `GET /sessions/{session_id}/tool-calls` query. */
export type SessionToolCallsQuery = z.infer<typeof SessionToolCallsQuery>;

/** `GET /sessions/{session_id}/tool-calls` body. */
export const SessionToolCallsPage = page(ToolCallRow);
/** `GET /sessions/{session_id}/tool-calls` body. */
export type SessionToolCallsPage = z.infer<typeof SessionToolCallsPage>;

/** `GET /tool-calls` query (fleet view; seeds the live feed and error views). */
export const ToolCallsQuery = listQuery({
  sort: ToolCallSortKey.default('ts'),
  filters: {
    ...toolCallFilters,
    session_id: SessionId.optional(),
    /**
     * `true`: only calls that ran in a session (linkable rows); `false`: only session-less calls
     * (rejected before a session resolved, e.g. `INVALID_ARGUMENTS`, or a failed launch). Omitted:
     * both; session-less rows carry `session_id: null` and `session_slug: null`.
     */
    has_session: QueryBool.optional(),
  },
});
/** `GET /tool-calls` query. */
export type ToolCallsQuery = z.infer<typeof ToolCallsQuery>;

/** `GET /tool-calls` body. */
export const ToolCallsPage = page(FleetToolCallRow);
/** `GET /tool-calls` body. */
export type ToolCallsPage = z.infer<typeof ToolCallsPage>;

/** @module contracts/http/session-actions — session mutations, bulk, trace, data-dir, viewport and input (spec 03 §4.2) */
import { z } from 'zod';
import { SessionId } from '../ids/index.ts';
import { LIVE_INPUT_BATCH_MAX, LiveInput } from '../ws/live-input.ts';
import { BulkItemError, Bytes, Count, csv, OkResponse } from './common.ts';

/** Maximum ids per `POST /sessions/bulk`. */
export const BULK_SESSIONS_MAX = 100;

/** Actions accepted by `POST /sessions/bulk`. */
export const BulkSessionAction = z.enum(['archive', 'unarchive', 'terminate', 'delete']);
/** Actions accepted by `POST /sessions/bulk`. */
export type BulkSessionAction = z.infer<typeof BulkSessionAction>;

/** `POST /sessions/bulk` body (requires `Idempotency-Key`). */
export const BulkSessionsRequest = z.strictObject({
  action: BulkSessionAction,
  session_ids: z.array(SessionId).min(1).max(BULK_SESSIONS_MAX),
});
/** `POST /sessions/bulk` body. */
export type BulkSessionsRequest = z.infer<typeof BulkSessionsRequest>;

/** One item of a bulk session result. */
export const BulkSessionResult = z.object({
  session_id: SessionId,
  ok: z.boolean(),
  error: BulkItemError.optional(),
});
/** One item of a bulk session result. */
export type BulkSessionResult = z.infer<typeof BulkSessionResult>;

/** `POST /sessions/bulk` 200 body (207-style per-item results). */
export const BulkSessionsResponse = z.object({
  results: z.array(BulkSessionResult),
  ok_count: Count,
  error_count: Count,
});
/** `POST /sessions/bulk` 200 body. */
export type BulkSessionsResponse = z.infer<typeof BulkSessionsResponse>;

/** `POST /sessions/{session_id}/terminate` 200 body. `closed=false` when it was already closing. */
export const TerminateSessionResponse = z.object({ ok: z.literal(true), closed: z.boolean() });
/** `POST /sessions/{session_id}/terminate` 200 body. */
export type TerminateSessionResponse = z.infer<typeof TerminateSessionResponse>;

/** `POST /sessions/{session_id}/archive` and `/unarchive` 200 body. */
export const ArchiveSessionResponse = OkResponse;

/** `DELETE /sessions/{session_id}` 200 body. */
export const DeleteSessionResponse = z.object({
  ok: z.literal(true),
  deleted: z.object({ rows: Count, bytes: Bytes }),
});
/** `DELETE /sessions/{session_id}` 200 body. */
export type DeleteSessionResponse = z.infer<typeof DeleteSessionResponse>;

/** Viewport bounds accepted by `set_viewport` (HTTP and WS). */
export const VIEWPORT_MIN = 200;
/** Viewport bounds accepted by `set_viewport` (HTTP and WS). */
export const VIEWPORT_MAX = 10_000;
/** One viewport dimension. */
export const ViewportDimension = z.number().int().min(VIEWPORT_MIN).max(VIEWPORT_MAX);

/** `POST /sessions/{session_id}/viewport` body. */
export const SetViewportRequest = z.strictObject({
  width: ViewportDimension,
  height: ViewportDimension,
});
/** `POST /sessions/{session_id}/viewport` body. */
export type SetViewportRequest = z.infer<typeof SetViewportRequest>;

/** `POST /sessions/{session_id}/viewport` 200 body; `clamped` when the driver adjusted the size. */
export const SetViewportResponse = z.object({
  ok: z.literal(true),
  width: ViewportDimension,
  height: ViewportDimension,
  clamped: z.boolean().optional(),
});
/** `POST /sessions/{session_id}/viewport` 200 body. */
export type SetViewportResponse = z.infer<typeof SetViewportResponse>;

/** `POST /sessions/{session_id}/input` body — the same batch as the WS `input` command, for scripted (curl) use. */
export const SessionInputRequest = z.strictObject({
  inputs: z.array(LiveInput).min(1).max(LIVE_INPUT_BATCH_MAX),
});
/** `POST /sessions/{session_id}/input` body. */
export type SessionInputRequest = z.infer<typeof SessionInputRequest>;

/** Why one input of a batch was refused. */
export const InputRejectionCode = z.enum([
  'INPUT_NOT_PERMITTED',
  'SESSION_NOT_AVAILABLE',
  'INPUT_FAILED',
]);
/** Why one input of a batch was refused. */
export type InputRejectionCode = z.infer<typeof InputRejectionCode>;

/** `POST /sessions/{session_id}/input` 200 body. */
export const SessionInputResponse = z.object({
  accepted: Count,
  rejected: z.array(z.object({ index: Count, code: InputRejectionCode })),
});
/** `POST /sessions/{session_id}/input` 200 body. */
export type SessionInputResponse = z.infer<typeof SessionInputResponse>;

/** Timeline facets (also the `kinds[]` filter of `/timeline` and `/export`). */
export const TimelineKind = z.enum(['tool', 'page', 'attention', 'vault', 'blocked']);
/** Timeline facets. */
export type TimelineKind = z.infer<typeof TimelineKind>;

/** `GET /sessions/{session_id}/export` query; the format is negotiated on `Accept`. */
export const SessionExportQuery = z.strictObject({ kinds: csv(TimelineKind) });
/** `GET /sessions/{session_id}/export` query. */
export type SessionExportQuery = z.infer<typeof SessionExportQuery>;

/** Export media types negotiated on `Accept`. */
export const EXPORT_MEDIA_TYPES = ['application/x-ndjson', 'text/csv'] as const;
/** Row cap of a session export; `X-Truncated: true` when hit. */
export const SESSION_EXPORT_MAX_ROWS = 100_000;

/** `GET /sessions/{session_id}/trace` body. */
export const SessionTraceInfo = z.object({
  enabled: z.boolean(),
  viewer_available: z.boolean(),
  path: z.string().nullable(),
  size_bytes: Bytes.nullable(),
  command: z.string().nullable(),
  viewer_url: z.string().nullable(),
});
/** `GET /sessions/{session_id}/trace` body. */
export type SessionTraceInfo = z.infer<typeof SessionTraceInfo>;

/** Why `data-dir/reveal` could not open a file manager. */
export const RevealFailureReason = z.enum(['no_desktop', 'missing', 'unsupported', 'failed']);
/** Why `data-dir/reveal` could not open a file manager. */
export type RevealFailureReason = z.infer<typeof RevealFailureReason>;

/** `POST /sessions/{session_id}/data-dir/reveal` body. */
export const RevealDataDirResponse = z.object({
  path: z.string(),
  exists: z.boolean(),
  desktop: z.boolean(),
  opened: z.boolean(),
  reason: RevealFailureReason.optional(),
  detail: z.string().optional(),
});
/** `POST /sessions/{session_id}/data-dir/reveal` body. */
export type RevealDataDirResponse = z.infer<typeof RevealDataDirResponse>;

/** Error code detail carried by 404 `TRACE_UNAVAILABLE` (`details.enabled`). */
export const TraceUnavailableDetails = z.object({ enabled: z.boolean() });
/** Error code detail carried by 404 `TRACE_UNAVAILABLE`. */
export type TraceUnavailableDetails = z.infer<typeof TraceUnavailableDetails>;

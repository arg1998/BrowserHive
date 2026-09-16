/** @module contracts/http/artifacts — screenshot rows and image routes (spec 03 §4.2) */
import { z } from 'zod';
import { EventId, SessionId } from '../ids/index.ts';
import { Bytes, csv, EpochMs, listQuery, page, sortable } from './common.ts';

/** Where a screenshot came from: a tool result or the tracing chunk. */
export const ScreenshotKind = z.enum(['tool', 'trace']);
/** Where a screenshot came from. */
export type ScreenshotKind = z.infer<typeof ScreenshotKind>;

/** One stored screenshot (`screenshots` row); `url` is the image route, grant-enabled. */
export const ScreenshotRow = z.object({
  event_id: EventId,
  session_id: SessionId,
  tool: z.string(),
  kind: ScreenshotKind,
  content_type: z.string(),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
  size_bytes: Bytes,
  ts: EpochMs,
  url: z.string(),
});
/** One stored screenshot. */
export type ScreenshotRow = z.infer<typeof ScreenshotRow>;

/** Sort keys accepted by `GET /sessions/{session_id}/screenshots`. */
export const ScreenshotSortKey = sortable(['ts']);

/** `GET /sessions/{session_id}/screenshots` query. */
export const SessionScreenshotsQuery = listQuery({
  sort: ScreenshotSortKey.default('ts'),
  filters: { kind: csv(ScreenshotKind) },
});
/** `GET /sessions/{session_id}/screenshots` query. */
export type SessionScreenshotsQuery = z.infer<typeof SessionScreenshotsQuery>;

/** `GET /sessions/{session_id}/screenshots` body. */
export const ScreenshotsPage = page(ScreenshotRow);
/** `GET /sessions/{session_id}/screenshots` body. */
export type ScreenshotsPage = z.infer<typeof ScreenshotsPage>;

/** Path params for `/sessions/{session_id}/screenshots/{event_id}` and tool-call detail. */
export const SessionEventParams = z.strictObject({ session_id: SessionId, event_id: EventId });
/** Path params for `/sessions/{session_id}/…/{event_id}`. */
export type SessionEventParams = z.infer<typeof SessionEventParams>;

/** `Cache-Control` sent with screenshot bytes (spec 03 §4.2). */
export const SCREENSHOT_CACHE_CONTROL = 'private, max-age=86400, immutable';

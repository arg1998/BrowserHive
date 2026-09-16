/** @module contracts/http/logs — log record and ring-buffer query (spec 03 §4.7, spec 10 §4) */
import { z } from 'zod';
import { LogLevel } from '../enums/index.ts';
import { SessionId } from '../ids/index.ts';
import {
  Count,
  Cursor,
  csv,
  EpochMs,
  limitQuery,
  page,
  QueryText,
  SortDir,
  windowQuery,
} from './common.ts';

/** Maximum `limit` for `GET /logs`. */
export const LOGS_LIMIT_MAX = 1000;

/** Transport a log record was produced under. */
export const LogTransport = z.enum(['http', 'stdio', 'ws', 'cli']);
/** Transport a log record was produced under. */
export type LogTransport = z.infer<typeof LogTransport>;

/** Serialized error attached to a log record (`err`), already redacted. */
export const SerializedError = z.object({
  name: z.string(),
  message: z.string(),
  code: z.string().optional(),
  stack: z.string().optional(),
  cause: z.unknown().optional(),
});
/** Serialized error attached to a log record. */
export type SerializedError = z.infer<typeof SerializedError>;

/**
 * One log record (spec 10 §4). Reserved keys are fixed; user fields that collide are written under
 * `fields.<name>`. `seq` is the ring-buffer sequence (monotonic, never reused). Optional reserved
 * keys are **absent, never `null`**, when unknown; a value that does not fit its reserved slot is
 * moved to `fields.<name>` by the server rather than failing the page.
 */
export const LogRecord = z
  .object({
    seq: z.number().int().nonnegative(),
    ts: EpochMs,
    level: LogLevel,
    msg: z.string(),
    module: z.string(),
    trace_id: z.string().optional(),
    span_id: z.string().optional(),
    request_id: z.string().optional(),
    session_id: z.string().optional(),
    principal: z.string().optional(),
    transport: LogTransport.optional(),
    err: SerializedError.optional(),
  })
  .catchall(z.unknown());
/** One log record. */
export type LogRecord = z.infer<typeof LogRecord>;

const logFilters = {
  level: csv(LogLevel),
  module: csv(z.string().min(1).max(64)),
  session_id: SessionId.optional(),
  trace_id: z.string().min(1).max(64).optional(),
  request_id: z.string().min(1).max(128).optional(),
  q: QueryText.optional(),
  ...windowQuery,
} as const;

/**
 * `GET /logs` query (keyset on `seq`).
 *
 * - `dir=desc` (default): newest matching records first; `page.next_cursor` pages to **older** ones.
 * - `dir=asc`: oldest held records first; `page.next_cursor` pages to **newer** ones.
 * - `after_seq`: only records with `seq > after_seq` (gap fill after a WS reconnect).
 *
 * A cursor is bound to the `dir` that minted it (400 otherwise).
 */
export const LogsQuery = z.strictObject({
  cursor: Cursor.optional(),
  limit: limitQuery(LOGS_LIMIT_MAX, 200),
  dir: SortDir.default('desc'),
  after_seq: z.coerce.number().int().nonnegative().optional(),
  ...logFilters,
});
/** `GET /logs` query. */
export type LogsQuery = z.infer<typeof LogsQuery>;

/** `GET /logs` body; `latest_seq` is the newest `seq` the buffer has assigned (0 when empty). */
export const LogsPage = page(LogRecord).extend({ latest_seq: Count });
/** `GET /logs` body. */
export type LogsPage = z.infer<typeof LogsPage>;

/** `GET /logs/export` query (streams NDJSON, same filters, no paging). */
export const LogsExportQuery = z.strictObject(logFilters);
/** `GET /logs/export` query. */
export type LogsExportQuery = z.infer<typeof LogsExportQuery>;

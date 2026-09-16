/** @module features/logs/log-fields — how a log record reads in one line: safe level lookup, HTTP access summary, priority inline fields, extra fields, correlation ids, APM trace URL (spec 10 §4) */
import type { LogRecord } from '@browserhive/contracts/http';
import { LOG_LEVEL, type StatusEntry } from '@/lib/status-registry.ts';

/** Reserved record keys rendered in fixed positions (spec 10 §4). */
const RESERVED: ReadonlySet<string> = new Set([
  'seq',
  'ts',
  'level',
  'msg',
  'module',
  'trace_id',
  'span_id',
  'request_id',
  'session_id',
  'principal',
  'transport',
  'err',
]);

/** Fields shown inline, in the terminal pretty renderer's priority order, so both read the same (spec 10 §4.2). */
const PRIORITY_FIELDS = [
  'tool',
  'session_id',
  'slug',
  'url',
  'pattern',
  'code',
  'error_code',
  'result',
  'source',
  'event',
  'entry_name',
  'duration_ms',
  'result_size_bytes',
] as const;

/** Fields the HTTP access summary already shows. */
const HTTP_FIELDS: ReadonlySet<string> = new Set([
  'method',
  'route_pattern',
  'path',
  'status',
  'duration_ms',
]);

/** Level entry; an unknown level (newer daemon) renders neutrally instead of throwing. */
export function levelEntry(level: string): StatusEntry {
  return (
    (LOG_LEVEL as Readonly<Record<string, StatusEntry | undefined>>)[level] ?? {
      label: level,
      tone: 'neutral',
    }
  );
}

/** `POST login 200 · 198 ms` for access-log records; `null` for anything else. */
export function httpSummary(record: LogRecord): {
  readonly method: string;
  readonly target: string;
  readonly status: number | null;
  readonly durationMs: number | null;
} | null {
  const method = record['method'];
  if (typeof method !== 'string') return null;
  const route = record['route_pattern'] ?? record['path'];
  const status = record['status'];
  const duration = record['duration_ms'];
  return {
    method,
    target: typeof route === 'string' ? route : '',
    status: typeof status === 'number' ? status : null,
    durationMs: typeof duration === 'number' ? duration : null,
  };
}

/** Extra (non-reserved) fields of a record. */
export function extraFields(record: LogRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!RESERVED.has(key) && value !== undefined) out[key] = value;
  }
  return out;
}

function inlineValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Inline `key=value` pairs in priority order (max `limit`); HTTP summary fields are skipped when summarised. */
export function inlineFields(
  record: LogRecord,
  limit = 4,
): readonly { readonly key: string; readonly value: string }[] {
  const skipHttp = httpSummary(record) !== null;
  const out: { key: string; value: string }[] = [];
  for (const key of PRIORITY_FIELDS) {
    if (skipHttp && HTTP_FIELDS.has(key)) continue;
    const value = record[key];
    if (value === undefined || value === null) continue;
    out.push({ key, value: inlineValue(value) });
    if (out.length >= limit) break;
  }
  return out;
}

/** Build the APM link from `otelTraceUrlTemplate` (`{trace_id}` placeholder). */
export function traceUrl(template: string | undefined, traceId: string | undefined): string | null {
  if (template === undefined || template === '' || traceId === undefined) return null;
  return template.replace('{trace_id}', encodeURIComponent(traceId));
}

/** Correlation ids present on a record, in display order. */
export function correlation(record: LogRecord): readonly (readonly [string, string])[] {
  const out: (readonly [string, string])[] = [];
  const pairs = [
    ['trace_id', record.trace_id],
    ['span_id', record.span_id],
    ['request_id', record.request_id],
    ['session_id', record.session_id],
    ['principal', record.principal],
    ['transport', record.transport],
  ] as const;
  for (const [key, value] of pairs) if (typeof value === 'string') out.push([key, value]);
  return out;
}

/** Methods that only read. */
const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Routine realtime-socket lifecycle lines (warnings and failures of the hub are never routine). */
const SOCKET_LIFECYCLE: ReadonlySet<string> = new Set(['ws connected', 'ws disconnected']);

/**
 * Dashboard traffic: the records an open dashboard produces just by being open. Successful reads on the
 * REST API (`GET getMe 200`, `GET listNotifications 200`), the realtime socket upgrade, and the socket's
 * connect/disconnect lines. They make up most of an idle tail, so Logs hides them by default.
 * Writes, failed requests (≥ 400), MCP traffic (`/mcp`) and hub warnings are never dashboard traffic:
 * those are what an operator is looking for. Classified by shape, not by principal: with agent auth off
 * every caller is `local`, and the socket upgrade carries no principal at all.
 */
export function isDashboardTraffic(record: LogRecord): boolean {
  if (record.module === 'ws.hub')
    return (
      SOCKET_LIFECYCLE.has(record.msg) &&
      (record.level === 'info' || record.level === 'debug' || record.level === 'trace')
    );
  if (record.module !== 'http.access') return false;
  const http = httpSummary(record);
  if (http === null || !READ_METHODS.has(http.method.toUpperCase())) return false;
  if (http.status !== null && http.status >= 400) return false;
  return http.target !== '/mcp' && !http.target.startsWith('/mcp/');
}

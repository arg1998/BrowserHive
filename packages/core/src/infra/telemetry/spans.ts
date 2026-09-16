/** @module infra/telemetry/spans — typed span helpers and the `browserhive.*` attribute catalogue (spec 10 §6). */

import {
  type Attributes,
  context as otelContext,
  type Span,
  SpanKind,
  SpanStatusCode,
  type Tracer,
  trace,
} from '@opentelemetry/api';
import { isAppError } from '../../kernel/errors/app-error.ts';

/** Name of the one tracer every span is started from. */
export const TRACER_NAME = 'browserhive';

/** Attribute keys from the span catalogue. Standard `http.*`/`db.*`/`url.*` keys are included. */
export const ATTR = {
  TOOL: 'browserhive.tool',
  SESSION_ID: 'browserhive.session_id',
  TAB_ID: 'browserhive.tab_id',
  PRINCIPAL: 'browserhive.principal',
  EVENT_ID: 'browserhive.event_id',
  OK: 'browserhive.ok',
  ERROR_CODE: 'browserhive.error_code',
  RESULT_BYTES: 'browserhive.result_bytes',
  CHANNEL: 'browserhive.channel',
  STEALTH: 'browserhive.stealth',
  PERSISTENCE_MODE: 'browserhive.persistence_mode',
  PHASE_MS: 'browserhive.phase_ms',
  REASON: 'browserhive.reason',
  DRIVER: 'browserhive.driver',
  HEADLESS: 'browserhive.headless',
  WAIT_UNTIL: 'browserhive.wait_until',
  CDP_METHOD: 'browserhive.cdp.method',
  ENTRY_NAME: 'browserhive.entry_name',
  RESULT: 'browserhive.result',
  REQUEST_ID: 'browserhive.request_id',
  MODE: 'browserhive.mode',
  STATUS: 'browserhive.status',
  ROWS: 'browserhive.rows',
  FROM_VERSION: 'browserhive.from_version',
  TO_VERSION: 'browserhive.to_version',
  BACKUP_PATH: 'browserhive.backup_path',
  WS_COMMAND: 'browserhive.ws.command',
  WS_TOPIC: 'browserhive.ws.topic',
  WS_RECIPIENTS: 'browserhive.ws.recipients',
  TRANSPORT: 'browserhive.transport',
  PRUNED: 'browserhive.pruned',
  FAILED: 'browserhive.failed',
  URL_FULL: 'url.full',
  HTTP_REQUEST_METHOD: 'http.request.method',
  HTTP_ROUTE: 'http.route',
  HTTP_RESPONSE_STATUS_CODE: 'http.response.status_code',
  DB_SYSTEM: 'db.system',
  DB_OPERATION: 'db.operation',
} as const;

/** Span names from the catalogue. Free-form names are allowed for children not listed here. */
export const SPAN = {
  MCP_TOOL_CALL: 'mcp.tool_call',
  SESSION_CREATE: 'session.create',
  SESSION_CLOSE: 'session.close',
  BROWSER_LAUNCH: 'browser.launch',
  PAGE_NAVIGATE: 'page.navigate',
  CDP_COMMAND: 'cdp.command',
  VAULT_FILL: 'vault.fill',
  ATTENTION_WAIT: 'attention.wait',
  DB_QUERY: 'db.query',
  DB_DRAIN: 'db.drain',
  DB_MIGRATE: 'db.migrate',
  DB_MIGRATE_STEP: 'db.migrate.step',
  HTTP_REQUEST: 'http.request',
  WS_COMMAND: 'ws.command',
  WS_BROADCAST: 'ws.broadcast',
  RETENTION_SWEEP: 'retention.sweep',
  OUTBOX_SWEEP: 'outbox.sweep',
  LEASE_SWEEP: 'lease.sweep',
  SCREENCAST_FRAME: 'screencast.frame',
} as const;

/** Attribute values accepted by {@link withSpan}; `undefined` entries are skipped. */
export type SpanAttributes = Readonly<Record<string, string | number | boolean | undefined>>;

/** Options for {@link withSpan}. */
export interface WithSpanOptions {
  /** Tracer to use; defaults to the global `browserhive` tracer. */
  readonly tracer?: Tracer;
  readonly kind?: SpanKind;
}

/** The global `browserhive` tracer (no-op until `createTelemetry` registers a provider). */
export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

/**
 * Runs `fn` inside an active span named `name`. On success the span ends with status unset; on a
 * throw it records the exception, sets `ERROR`, stamps `browserhive.ok=false` plus
 * `browserhive.error_code` for an `AppError`, ends, and rethrows.
 */
export async function withSpan<T>(
  name: string,
  attrs: SpanAttributes,
  fn: (span: Span) => Promise<T> | T,
  options: WithSpanOptions = {},
): Promise<T> {
  const tracer = options.tracer ?? getTracer();
  return tracer.startActiveSpan(
    name,
    { attributes: cleanAttributes(attrs), kind: options.kind ?? SpanKind.INTERNAL },
    async (span) => {
      try {
        return await fn(span);
      } catch (error) {
        markFailed(span, error);
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

/** Synchronous variant of {@link withSpan} for pure work (glob checks, classification). */
export function withSpanSync<T>(
  name: string,
  attrs: SpanAttributes,
  fn: (span: Span) => T,
  options: WithSpanOptions = {},
): T {
  const tracer = options.tracer ?? getTracer();
  return tracer.startActiveSpan(
    name,
    { attributes: cleanAttributes(attrs), kind: options.kind ?? SpanKind.INTERNAL },
    (span) => {
      try {
        return fn(span);
      } catch (error) {
        markFailed(span, error);
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

/** Records `error` on `span` and sets the failure attributes/status without ending it. */
export function markFailed(span: Span, error: unknown): void {
  if (error instanceof Error) span.recordException(error);
  span.setAttribute(ATTR.OK, false);
  if (isAppError(error)) span.setAttribute(ATTR.ERROR_CODE, error.code);
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: error instanceof Error ? error.message : 'failed',
  });
}

/** Sets several attributes at once, skipping `undefined` values. */
export function setAttributes(span: Span, attrs: SpanAttributes): void {
  span.setAttributes(cleanAttributes(attrs));
}

/** The active span, or `undefined`. */
export function activeSpan(): Span | undefined {
  return trace.getSpan(otelContext.active());
}

/** W3C `traceparent` components. */
export interface Traceparent {
  readonly traceId: string;
  readonly spanId: string;
  readonly sampled: boolean;
}

const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;

/** Parses a `traceparent` header (version 00). Returns `null` for malformed or all-zero ids. */
export function parseTraceparent(header: string | undefined | null): Traceparent | null {
  if (header === undefined || header === null) return null;
  const match = TRACEPARENT_RE.exec(header.trim());
  if (match === null) return null;
  const version = match[1];
  const traceId = match[2]?.toLowerCase();
  const spanId = match[3]?.toLowerCase();
  const flags = match[4];
  if (
    version === undefined ||
    traceId === undefined ||
    spanId === undefined ||
    flags === undefined
  ) {
    return null;
  }
  if (version === 'ff' || /^0+$/.test(traceId) || /^0+$/.test(spanId)) return null;
  return { traceId, spanId, sampled: (Number.parseInt(flags, 16) & 1) === 1 };
}

/** Formats a `traceparent` header (version 00). */
export function formatTraceparent(traceId: string, spanId: string, sampled = true): string {
  return `00-${traceId}-${spanId}-${sampled ? '01' : '00'}`;
}

function cleanAttributes(attrs: SpanAttributes): Attributes {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

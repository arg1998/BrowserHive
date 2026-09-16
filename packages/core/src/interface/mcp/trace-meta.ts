/** @module interface/mcp/trace-meta — adopts a client-supplied trace parent from MCP `_meta` (`traceparent`, `browserhive.ai/traceId`, `traceId`) as the tool span's parent (D-08). */

import { type Context, context, TraceFlags, trace } from '@opentelemetry/api';

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const ZERO_TRACE = '0'.repeat(32);
const ZERO_SPAN = '0'.repeat(16);
/** Synthetic remote span id when the client sent only a trace id. */
const SYNTHETIC_PARENT_SPAN = '0000000000000001';

function metaString(
  meta: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined {
  const value = meta?.[key];
  return typeof value === 'string' ? value.trim().toLowerCase() : undefined;
}

/**
 * The OTel context to start the tool span under: the active context extended with the client's
 * remote span when `_meta` carries a valid W3C `traceparent` or a bare 32-hex trace id; otherwise
 * the active context unchanged.
 */
export function parentContextFromMeta(
  meta: Readonly<Record<string, unknown>> | undefined,
): Context {
  const active = context.active();
  const traceparent = metaString(meta, 'traceparent');
  const match = traceparent === undefined ? null : TRACEPARENT_RE.exec(traceparent);
  if (match !== null) {
    const [, traceId = '', spanId = '', flags = '00'] = match;
    if (traceId !== ZERO_TRACE && spanId !== ZERO_SPAN) {
      return trace.setSpanContext(active, {
        traceId,
        spanId,
        traceFlags: Number.parseInt(flags, 16) & TraceFlags.SAMPLED,
        isRemote: true,
      });
    }
  }
  const bare = metaString(meta, 'browserhive.ai/traceId') ?? metaString(meta, 'traceId');
  if (bare !== undefined && TRACE_ID_RE.test(bare) && bare !== ZERO_TRACE) {
    return trace.setSpanContext(active, {
      traceId: bare,
      spanId: SYNTHETIC_PARENT_SPAN,
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    });
  }
  return active;
}

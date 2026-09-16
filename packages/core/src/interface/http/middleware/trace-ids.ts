/** @module interface/http/middleware/trace-ids — W3C `traceparent` parsing/formatting and id minting for entry points (spec 10 §5). */

import { isSpanContextValid, type Span } from '@opentelemetry/api';

/** W3C trace ids of one request. */
export interface TraceIds {
  readonly traceId: string;
  readonly spanId: string;
}

const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;

/** Parses a version-00 `traceparent`; `null` for malformed or all-zero ids. */
export function parseTraceparent(header: string | undefined): TraceIds | null {
  if (header === undefined) return null;
  const match = TRACEPARENT_RE.exec(header.trim());
  const version = match?.[1];
  const traceId = match?.[2]?.toLowerCase();
  const spanId = match?.[3]?.toLowerCase();
  if (version === undefined || traceId === undefined || spanId === undefined) return null;
  if (version === 'ff' || /^0+$/.test(traceId) || /^0+$/.test(spanId)) return null;
  return { traceId, spanId };
}

/** Formats a sampled version-00 `traceparent`. */
export function formatTraceparent(ids: TraceIds): string {
  return `00-${ids.traceId}-${ids.spanId}-01`;
}

/** Random lowercase hex of `bytes` bytes (Web Crypto; not a clock or id port concern). */
export function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The ids a request runs under: the active OTel span's when telemetry is on, otherwise the inbound
 * trace id (or a fresh one) with a fresh span id.
 */
export function traceIdsFor(span: Span | undefined, inbound: TraceIds | null): TraceIds {
  const context = span?.spanContext();
  if (context !== undefined && isSpanContextValid(context)) {
    return { traceId: context.traceId, spanId: context.spanId };
  }
  return { traceId: inbound?.traceId ?? randomHex(16), spanId: randomHex(8) };
}

const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Accepts a client `X-Request-Id` when it matches the grammar (spec 03 §2). */
export function acceptRequestId(header: string | undefined): string | undefined {
  return header !== undefined && REQUEST_ID_RE.test(header) ? header : undefined;
}

/** @module infra/logging/record — the LogRecord shape, reserved keys, field normalization and serializers (spec 10 §4). */

import type { RequestContext } from '../../kernel/context.ts';
import { type SerializedError, serializeError } from '../../kernel/errors/serialize-error.ts';
import { sanitizeUrl } from '../../kernel/url.ts';
import type { LogFields, LogLevel } from '../../ports/logger.ts';

/** One structured log record (spec 10 §4). Extra fields are pre-redacted, snake_case. */
export interface LogRecord {
  readonly ts: number;
  readonly level: LogLevel;
  readonly msg: string;
  readonly module: string;
  readonly trace_id?: string;
  readonly span_id?: string;
  readonly request_id?: string;
  readonly session_id?: string;
  readonly principal?: string;
  readonly transport?: string;
  readonly err?: SerializedError;
  readonly [field: string]: unknown;
}

/** Keys the logger owns outright: a colliding user field is written under `fields.<name>`. */
export const LOGGER_OWNED_KEYS: readonly string[] = ['ts', 'level', 'msg', 'trace_id', 'span_id'];

/**
 * Correlation keys stamped from the request context. A user field fills the slot when the
 * context has no value; when the context already has one, the user's value goes under
 * `fields.<name>` so the correlation column stays trustworthy.
 */
export const CONTEXT_KEYS: readonly string[] = [
  'request_id',
  'session_id',
  'principal',
  'transport',
];

/** Module name used when a logger has no `module` binding. */
export const DEFAULT_MODULE = 'app';

/** `sessionId` → `session_id`, `durationMs` → `duration_ms`, `HTTPStatus` → `http_status`. */
export function toSnakeCase(key: string): string {
  if (!/[A-Z]/.test(key)) return key;
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

/** Trace ids the logger stamps: from the active OTel span when valid, else the request context. */
export interface TraceIds {
  readonly traceId: string;
  readonly spanId: string;
}

/** Inputs to {@link buildLogRecord}. */
export interface BuildRecordInput {
  readonly ts: number;
  readonly level: LogLevel;
  readonly msg: string;
  /** Bindings then call fields, already merged (call fields win). */
  readonly fields: LogFields;
  readonly context: RequestContext | undefined;
  readonly traceIds: TraceIds | undefined;
  /** Applied to `url` fields. */
  readonly urlQueryAllowlist: readonly string[];
  /** Applied to every field value after normalization (key heuristics + literal scrub). */
  readonly redactValue: (value: unknown) => unknown;
  /** Applied to the message. */
  readonly scrubText: (text: string) => string;
}

/**
 * Builds a {@link LogRecord}: normalizes keys to snake_case, runs the `err`/`url`/`duration`
 * serializers, stamps correlation ids, namespaces collisions and redacts.
 */
export function buildLogRecord(input: BuildRecordInput): LogRecord {
  const normalized: Record<string, unknown> = {};
  const namespaced: Record<string, unknown> = {};
  let module = DEFAULT_MODULE;
  let err: SerializedError | undefined;
  const contextValues = contextFields(input.context);

  for (const [rawKey, rawValue] of Object.entries(input.fields)) {
    if (rawValue === undefined) continue;
    const key = toSnakeCase(rawKey);
    // Reserved correlation keys are absent, never null, on a record.
    if (rawValue === null && (CONTEXT_KEYS.includes(key) || key === 'err')) continue;
    if (key === 'module') {
      if (typeof rawValue === 'string' && rawValue.length > 0) module = rawValue;
      continue;
    }
    if (rawValue instanceof Error && (key === 'err' || key === 'error')) {
      err = serializeError(rawValue, { includeStack: true });
      continue;
    }
    if (key === 'err') {
      // Already serialized (`serializeError(e)`) or a thrown non-Error: always a SerializedError.
      err = isSerializedError(rawValue) ? rawValue : serializeError(rawValue);
      continue;
    }
    if (LOGGER_OWNED_KEYS.includes(key)) {
      namespaced[key] = rawValue;
      continue;
    }
    if (CONTEXT_KEYS.includes(key) && contextValues[key] !== undefined) {
      if (contextValues[key] !== rawValue) namespaced[key] = rawValue;
      continue;
    }
    normalized[key] = serializeField(key, rawValue, input.urlQueryAllowlist);
    if (key === 'duration' && typeof rawValue === 'number') {
      delete normalized[key];
      normalized['duration_ms'] = rawValue;
    }
  }

  const redactedFields = asRecord(input.redactValue(normalized));
  const redactedNamespaced = asRecord(input.redactValue(namespaced));
  const traceId = input.traceIds?.traceId ?? input.context?.traceId;
  const spanId = input.traceIds?.spanId ?? input.context?.spanId;

  return {
    ts: input.ts,
    level: input.level,
    msg: input.scrubText(input.msg),
    module,
    ...(traceId !== undefined && { trace_id: traceId }),
    ...(spanId !== undefined && { span_id: spanId }),
    ...pickDefined(contextValues, redactedFields, 'request_id'),
    ...pickDefined(contextValues, redactedFields, 'session_id'),
    ...pickDefined(contextValues, redactedFields, 'principal'),
    ...pickDefined(contextValues, redactedFields, 'transport'),
    ...(err !== undefined && { err: scrubError(err, input.scrubText, input.redactValue) }),
    ...withoutKeys(redactedFields, CONTEXT_KEYS),
    ...(Object.keys(redactedNamespaced).length > 0 && { fields: redactedNamespaced }),
  };
}

function isSerializedError(value: unknown): value is SerializedError {
  if (typeof value !== 'object' || value === null) return false;
  const name: unknown = Reflect.get(value, 'name');
  const message: unknown = Reflect.get(value, 'message');
  return typeof name === 'string' && typeof message === 'string';
}

function contextFields(context: RequestContext | undefined): Record<string, string | undefined> {
  if (context === undefined) return {};
  return {
    request_id: context.requestId,
    session_id: context.sessionId,
    principal: context.principal,
    transport: context.transport,
  };
}

function serializeField(key: string, value: unknown, allow: readonly string[]): unknown {
  if (key === 'url' && typeof value === 'string')
    return sanitizeUrl(value, { allowQueryKeys: allow });
  if (value instanceof Error) return serializeError(value);
  return value;
}

function scrubError(
  error: SerializedError,
  scrub: (t: string) => string,
  redact: (value: unknown) => unknown,
): SerializedError {
  return {
    ...error,
    message: scrub(error.message),
    ...(error.details !== undefined && { details: asRecord(redact(error.details)) }),
    ...(error.stack !== undefined && { stack: scrub(error.stack) }),
    ...(error.cause !== undefined && { cause: scrubError(error.cause, scrub, redact) }),
  };
}

function pickDefined(
  context: Record<string, string | undefined>,
  fields: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = context[key] ?? fields[key];
  return value !== undefined ? { [key]: value } : {};
}

function withoutKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (!keys.includes(k)) out[k] = v;
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = v;
    return out;
  }
  return {};
}

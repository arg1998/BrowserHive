/** @module kernel/errors/serialize-error — turn any thrown value into a plain, loggable record (spec 10 §1.2). */

import { isAppError } from './app-error.ts';

/** Depth cap for the `cause` chain: deeper links are dropped with a `[truncated]` marker. */
export const MAX_CAUSE_DEPTH = 8;

/** Plain projection of an error and its `cause` chain. Safe to `JSON.stringify`. */
export interface SerializedError {
  /** `error.name`, or the value's type name for non-errors. */
  readonly name: string;
  /** Registry code when the value is an `AppError`. */
  readonly code?: string;
  /** Private message (host paths allowed); the caller scrubs before any sink. */
  readonly message: string;
  /** `AppError.details` when present. */
  readonly details?: Readonly<Record<string, unknown>>;
  /** Included only when `includeStack` is set (log sink audience). */
  readonly stack?: string;
  /** Next link of the `cause` chain, up to {@link MAX_CAUSE_DEPTH}. */
  readonly cause?: SerializedError;
}

/** Options for {@link serializeError}. */
export interface SerializeErrorOptions {
  /** Include `stack` frames. Default `false`; the log sink sets `true`. */
  readonly includeStack?: boolean;
  /** Override for the cause-chain depth cap (tests). */
  readonly maxDepth?: number;
}

/**
 * Serializes `value` and its `cause` chain into a {@link SerializedError}.
 *
 * @remarks Never throws. Non-`Error` values (strings, objects, `undefined`) are wrapped as
 * `{ name: 'NonError', message: <rendered> }`. Cycles in the chain stop at the depth cap.
 */
export function serializeError(
  value: unknown,
  options: SerializeErrorOptions = {},
): SerializedError {
  const maxDepth = options.maxDepth ?? MAX_CAUSE_DEPTH;
  const includeStack = options.includeStack === true;
  return walk(value, 0, maxDepth, includeStack, new Set());
}

function walk(
  value: unknown,
  depth: number,
  maxDepth: number,
  includeStack: boolean,
  seen: Set<unknown>,
): SerializedError {
  if (depth >= maxDepth) {
    return { name: 'Truncated', message: '[truncated]' };
  }
  if (!(value instanceof Error)) {
    return { name: 'NonError', message: renderNonError(value) };
  }
  if (seen.has(value)) {
    return { name: value.name, message: '[circular]' };
  }
  seen.add(value);

  const out: {
    name: string;
    code?: string;
    message: string;
    details?: Readonly<Record<string, unknown>>;
    stack?: string;
    cause?: SerializedError;
  } = { name: value.name || 'Error', message: value.message };

  if (isAppError(value)) {
    out.code = value.code;
    if (isRecord(value.details)) out.details = value.details;
  } else if (hasStringCode(value)) {
    out.code = value.code;
  }
  if (includeStack && typeof value.stack === 'string' && value.stack.length > 0) {
    out.stack = value.stack;
  }
  if (value.cause !== undefined && value.cause !== null) {
    out.cause = walk(value.cause, depth + 1, maxDepth, includeStack, seen);
  }
  return out;
}

function renderNonError(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return `${value}`;
  }
  try {
    return JSON.stringify(value) ?? '[unserializable]';
  } catch {
    return '[unserializable]';
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasStringCode(value: Error): value is Error & { code: string } {
  return typeof (value as { code?: unknown }).code === 'string';
}

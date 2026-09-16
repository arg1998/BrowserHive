/** @module lib/api/errors — `AppError`: the dashboard's typed error (registry codes + client-only transport codes), problem+json mapping (spec 04 §5) */

import type { Retryable } from '@browserhive/contracts/enums';
import {
  ERROR_REGISTRY,
  type ErrorCode,
  errorDocsUrl,
  isErrorCode,
  ProblemDetails,
} from '@browserhive/contracts/errors';

/** Codes that only exist on the client (the daemon never answered, or answered nonsense). */
export type ClientErrorCode =
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'MALFORMED_RESPONSE'
  | 'CLIENT_ERROR';
/** Every code an `AppError` can carry. */
export type AppErrorCode = ErrorCode | ClientErrorCode;

/** Constructor input. */
export interface AppErrorInit {
  readonly code: AppErrorCode;
  readonly status: number;
  readonly title: string;
  readonly message?: string;
  readonly retryable: Retryable;
  readonly retryAfterMs?: number;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly requestId?: string;
  readonly hint?: string;
  readonly cause?: unknown;
}

/** Typed error for every failed request, socket command or wire mismatch. */
export class AppError extends Error {
  override readonly name = 'AppError';
  readonly code: AppErrorCode;
  readonly status: number;
  readonly title: string;
  readonly retryable: Retryable;
  readonly retryAfterMs: number | undefined;
  readonly details: Readonly<Record<string, unknown>>;
  readonly requestId: string | undefined;
  readonly hint: string | undefined;

  constructor(init: AppErrorInit) {
    super(init.message ?? init.title, init.cause === undefined ? undefined : { cause: init.cause });
    this.code = init.code;
    this.status = init.status;
    this.title = init.title;
    this.retryable = init.retryable;
    this.retryAfterMs = init.retryAfterMs;
    this.details = init.details ?? {};
    this.requestId = init.requestId;
    this.hint = init.hint;
  }

  /** Link into the generated error reference (`docs/errors.md#<code>`). */
  get docsUrl(): string {
    return errorDocsUrl(this.code);
  }

  /** `true` when the dashboard itself broke (a bug in this page), not the daemon or the network. */
  get isClientBug(): boolean {
    return this.code === 'CLIENT_ERROR';
  }

  /** `true` for registry codes (the daemon answered with a typed error). */
  get isServerError(): boolean {
    return isErrorCode(this.code);
  }
}

/** Type guard. */
export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** Read `retry_after_ms` out of a details bag (RATE_LIMITED). */
function retryAfterFrom(details: Record<string, unknown> | undefined): number | undefined {
  const value = details?.['retry_after_ms'];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Build an `AppError` from a parsed problem+json body. */
export function appErrorFromProblem(problem: ProblemDetails, status: number): AppError {
  const spec = ERROR_REGISTRY[problem.code];
  const retryAfterMs = retryAfterFrom(problem.details);
  const hint = problem.hint ?? spec.hint;
  return new AppError({
    code: problem.code,
    status: problem.status || status,
    title: problem.title || spec.title,
    ...(problem.detail !== undefined && { message: problem.detail }),
    retryable: problem.retryable,
    ...(problem.details !== undefined && { details: problem.details }),
    ...(retryAfterMs !== undefined && { retryAfterMs }),
    ...(problem.request_id !== undefined && { requestId: problem.request_id }),
    ...(hint !== undefined && { hint }),
  });
}

/** Map a non-2xx response whose body may or may not be problem+json. */
export function appErrorFromResponse(
  status: number,
  body: unknown,
  headers: { get(name: string): string | null },
): AppError {
  const parsed = ProblemDetails.safeParse(body);
  if (parsed.success) return appErrorFromProblem(parsed.data, status);
  const retryAfterHeader = headers.get('retry-after');
  const retryAfterMs =
    retryAfterHeader !== null && /^\d+$/.test(retryAfterHeader)
      ? Number(retryAfterHeader) * 1000
      : undefined;
  const code: AppErrorCode = statusToCode(status);
  const spec = isErrorCode(code) ? ERROR_REGISTRY[code] : undefined;
  const requestId = headers.get('x-request-id');
  return new AppError({
    code,
    status,
    title: spec?.title ?? `HTTP ${status}`,
    retryable: spec?.retryable ?? (status >= 500 ? 'backoff' : 'never'),
    ...(retryAfterMs !== undefined && { retryAfterMs }),
    ...(requestId !== null && { requestId }),
    // A non-problem body can still be meaningful (the 503 health body describes the degraded state).
    ...(body !== undefined && { details: { body } }),
  });
}

/** Best-effort registry code for a status when the body was not problem+json. */
function statusToCode(status: number): AppErrorCode {
  switch (status) {
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 429:
      return 'RATE_LIMITED';
    default:
      return status >= 500 ? 'INTERNAL_ERROR' : 'MALFORMED_RESPONSE';
  }
}

/** Network failure (DNS, refused, CORS, offline). */
export function networkError(cause: unknown): AppError {
  return new AppError({
    code: 'NETWORK_ERROR',
    status: 0,
    title: 'Network error',
    message: 'The daemon could not be reached.',
    retryable: 'backoff',
    cause,
  });
}

/** The request exceeded its timeout. */
export function timeoutError(timeoutMs: number): AppError {
  return new AppError({
    code: 'TIMEOUT',
    status: 0,
    title: 'Request timed out',
    message: `No answer within ${timeoutMs} ms.`,
    retryable: 'backoff',
    details: { timeout_ms: timeoutMs },
  });
}

/** The caller aborted the request. */
export function abortedError(): AppError {
  return new AppError({
    code: 'ABORTED',
    status: 0,
    title: 'Request aborted',
    retryable: 'never',
  });
}

/** The daemon answered 2xx with a body the contracts schema rejects. */
export function malformedError(operation: string, issues: unknown): AppError {
  return new AppError({
    code: 'MALFORMED_RESPONSE',
    status: 0,
    title: 'Unexpected response shape',
    message: `Response of ${operation} does not match the contract.`,
    retryable: 'never',
    details: { operation, issues },
  });
}

/**
 * A bug in the dashboard itself (render crash, `TypeError` in a component). Transport failures are
 * mapped to `NETWORK_ERROR` by the HTTP/WS layers explicitly, so an uncaught `TypeError` here is
 * never an outage.
 */
export function clientError(error: unknown): AppError {
  const message = error instanceof Error ? error.message : String(error);
  return new AppError({
    code: 'CLIENT_ERROR',
    status: 0,
    title: 'Something broke in the dashboard',
    message,
    hint: 'This is a bug in the dashboard, not a problem with the daemon. Retry, or copy the details for a bug report.',
    retryable: 'never',
    details: {
      name: error instanceof Error ? error.name : typeof error,
      ...(error instanceof Error && error.stack !== undefined && { stack: error.stack }),
    },
    cause: error,
  });
}

/** Coerce anything thrown into an `AppError`. Non-`AppError` throwables are dashboard bugs. */
export function toAppError(error: unknown): AppError {
  if (isAppError(error)) return error;
  if (error instanceof DOMException && error.name === 'AbortError') return abortedError();
  return clientError(error);
}

/** @module interface/http/problem — RFC 9457 `application/problem+json` projection of every error (spec 10 §2.2, D-07). */

import { ERROR_REGISTRY, errorDocsUrl, type ProblemDetails } from '@browserhive/contracts/errors';
import { ZodError } from 'zod';
import { AppError, isAppError } from '../../kernel/errors/app-error.ts';

/** Media type of every error body. */
export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/** What the error handler turns into a `Response`. */
export interface ProblemResponse {
  readonly status: number;
  readonly body: ProblemDetails;
  readonly headers: Readonly<Record<string, string>>;
}

/** Request facts every problem carries. */
export interface ProblemContext {
  /** `instance`: the request path. */
  readonly instance: string;
  /** `request_id`: the id echoed in `X-Request-Id`. */
  readonly requestId: string;
  /** Methods to list in `Allow` for a 405. */
  readonly allow?: readonly string[];
}

/** One zod issue projected onto `VALIDATION_FAILED.details.issues`. */
export interface FieldIssue {
  readonly path: string;
  readonly message: string;
  readonly code: string;
}

/** Flattens a `ZodError` into field issues; `prefix` names the validated part (`query`, `body`). */
export function fieldIssues(error: ZodError, prefix?: string): readonly FieldIssue[] {
  return error.issues.map((issue) => {
    const path = issue.path.map(String).join('.');
    const full = prefix === undefined ? path : path === '' ? prefix : `${prefix}.${path}`;
    return { path: full, message: issue.message, code: issue.code };
  });
}

/** Builds the `VALIDATION_FAILED` error for a set of field issues. */
export function validationFailed(issues: readonly FieldIssue[]): AppError<'VALIDATION_FAILED'> {
  const first = issues[0];
  return new AppError(
    'VALIDATION_FAILED',
    { issues: issues.map((i) => ({ path: i.path, message: i.message, code: i.code })) },
    {
      publicMessage:
        first === undefined ? 'Request validation failed.' : `${first.path}: ${first.message}`,
    },
  );
}

/**
 * Projects any thrown value onto a problem+json response. `AppError` keeps its status and
 * details; a `ZodError` becomes 400 `VALIDATION_FAILED`; anything else is a generic 500
 * `INTERNAL_ERROR` whose `ref` is the request id (the private message is the caller's to log).
 */
export function problemFromError(error: unknown, context: ProblemContext): ProblemResponse {
  const appError = toAppError(error, context.requestId);
  return problemFromAppError(appError, context);
}

/** Projects an `AppError` onto a problem+json response. */
export function problemFromAppError(error: AppError, context: ProblemContext): ProblemResponse {
  const spec = ERROR_REGISTRY[error.code];
  const status = statusFor(error.httpStatus);
  const details = detailsOf(error.details);
  const body: ProblemDetails = {
    type: errorDocsUrl(error.code),
    title: spec.title,
    status,
    ...(error.publicMessage !== spec.title && { detail: error.publicMessage }),
    instance: context.instance,
    code: error.code,
    retryable: error.retryable,
    ...(error.hint !== undefined && { hint: error.hint }),
    ...(details !== undefined && { details }),
    request_id: context.requestId,
  };
  const headers: Record<string, string> = { 'content-type': PROBLEM_CONTENT_TYPE };
  if (status === 401) headers['www-authenticate'] = 'Bearer realm="browserhive"';
  if (status === 405 && context.allow !== undefined) headers['allow'] = context.allow.join(', ');
  const retryAfterMs = details?.['retry_after_ms'];
  if ((status === 429 || status === 503) && typeof retryAfterMs === 'number') {
    headers['retry-after'] = String(Math.max(1, Math.ceil(retryAfterMs / 1000)));
  }
  return { status, body, headers };
}

/** Normalises any thrown value to an `AppError` (wrapping unknowns as `INTERNAL_ERROR`). */
export function toAppError(error: unknown, requestId: string): AppError {
  if (isAppError(error)) return error;
  if (error instanceof ZodError) return validationFailed(fieldIssues(error));
  return new AppError(
    'INTERNAL_ERROR',
    { ref: requestId },
    {
      publicMessage: 'An internal error occurred.',
      message: error instanceof Error ? error.message : 'non-error thrown',
      cause: error,
    },
  );
}

function statusFor(httpStatus: number): number {
  // Codes never meant for HTTP (boot/audit/warning) still need a sane status when they surface.
  return httpStatus >= 400 && httpStatus <= 599 ? httpStatus : 500;
}

function detailsOf(details: unknown): Record<string, unknown> | undefined {
  if (typeof details !== 'object' || details === null || Array.isArray(details)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) out[key] = value;
  return Object.keys(out).length === 0 ? undefined : out;
}
